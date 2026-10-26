# Operations runbook (draft v0.1)

Scope: staging and production on AWS `ap-south-1` (DR backups in `ap-south-2`), deployed with
`infra/terraform` and `.github/workflows/deploy.yml`. Names below use `procure-production`; substitute
`procure-staging` for staging.

> Status: first draft for Phase 1. Every procedure must be rehearsed on staging before it counts as done.
> Rehearsal log: _none yet_.

## 0. Quick reference

| Thing       | Where                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| ECS cluster | `procure-<env>` (services `api`, `web`, `worker`; one-off task family `procure-<env>-migrate`)                  |
| Logs        | CloudWatch `/procure/<env>/{api,web,worker,migrate}`                                                            |
| Alarms      | SNS topic `procure-<env>-alarms`                                                                                |
| Database    | RDS `procure-<env>` (PostgreSQL 16, Multi-AZ, PITR 14 days)                                                     |
| Secrets     | Secrets Manager `procure-<env>/{jwt_secret,jwt_secret_previous,file_url_secret,provider_key,database_url,database_platform_url,redis_url,database_migrator_url}` |
| Files       | S3 `procure-<env>-files-*` (versioned, SSE-KMS)                                                                 |
| Images      | ECR `procure-<env>/{api,web,worker}`; tags are immutable (git tag or sha)                                       |

```bash
export AWS_REGION=ap-south-1 ENV=production CLUSTER=procure-production
```

## 1. Deploy

**Staging:** GitHub > Actions > _Deploy_ > _Run workflow_ > environment `staging` (any branch or sha).
**Production:** push a tag:

```bash
git tag -a v1.4.0 -m "v1.4.0" && git push origin v1.4.0
```

The workflow then:

1. builds and pushes `api`, `worker` and `web` images tagged with the git tag (or sha),
2. runs the `migrate` task (`node db/migrate.mjs && node db/policies/rls-lint.mjs`) and stops if it fails,
3. registers new task definitions and `update-service` api, worker, web, then waits for `services-stable`.

ECS deployment circuit breaker auto-rolls back a service whose new tasks fail health checks.

**Migration rule (expand/contract):** migrations must be backward compatible with the previous app
version, because old tasks keep serving during rollout and rollback does not undo SQL. Destructive
changes (drop or rename a column) ship in a later release, once no running version uses the column.

Post-deploy checks (5 minutes):

- `curl -fsS https://api.<domain>/health` returns `{"status":"ok"}`
- ALB 5xx alarm and p95 latency alarm are OK
- `aws ecs describe-services --cluster $CLUSTER --services api web worker --query 'services[].{s:serviceName,r:runningCount,d:desiredCount,dep:length(deployments)}'`
- Log in to a test tenant on the web app and open a list page

## 2. Rollback

### 2a. Application rollback (no schema concerns)

Re-deploy the previous good tag. This is the preferred path because it keeps the pipeline as the only
writer:

- Production: Actions > _Deploy_ > re-run the job of the previous tag's run. Or point a new tag at the
  old commit (`git tag v1.4.1 v1.3.0^{}`) and push it.

Fast path when the pipeline is unavailable (previous task definition revision):

```bash
for s in api worker web; do
  TD=$(aws ecs describe-services --cluster $CLUSTER --services $s --query 'services[0].taskDefinition' --output text)
  FAMILY=${TD%:*}; REV=${TD##*:}
  aws ecs update-service --cluster $CLUSTER --service $s --task-definition "$FAMILY:$((REV-1))"
done
aws ecs wait services-stable --cluster $CLUSTER --services api worker web
```

### 2b. A migration broke something

Migrations are forward-only. Do **not** edit or delete the applied file. Write a new corrective migration,
then ship it through the normal deploy. If data was destroyed, see §3.

## 3. Restore from PITR

Use when data was lost or corrupted (bad migration, bad bulk job, operator error). RDS restores into a
**new** instance; production is never overwritten in place.

1. **Freeze writes** if corruption is ongoing: scale `worker` to 0 and, if needed, put the API in
   maintenance mode (scale `api` to 0; the ALB returns 503).
2. **Pick the target time** (UTC), just before the incident. Check what is restorable:
   ```bash
   aws rds describe-db-instances --db-instance-identifier procure-production \
     --query 'DBInstances[0].LatestRestorableTime'
   ```
3. **Restore into a new instance:**
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier procure-production \
     --target-db-instance-identifier procure-production-restore-$(date +%Y%m%d%H%M) \
     --restore-time 2026-10-22T05:30:00Z \
     --db-subnet-group-name procure-production \
     --vpc-security-group-ids <db-sg-id> \
     --db-parameter-group-name procure-production-pg16 \
     --multi-az --no-publicly-accessible --deletion-protection
   aws rds wait db-instance-available --db-instance-identifier <new-id>
   ```
   For a regional outage, restore in `ap-south-2` from the replicated automated backups instead:
   `aws rds restore-db-instance-to-point-in-time --region ap-south-2 --source-db-instance-automated-backups-arn <arn> ...`
   (find the ARN with `aws rds describe-db-instance-automated-backups --region ap-south-2`).
4. **Choose a recovery mode:**
   - _Partial (one tenant or table):_ copy the affected rows from the restored instance into production
     with `pg_dump --data-only -t ... --where` or `\copy`, running as the migrator. Record what was
     copied in the incident doc. Preferred whenever the damage is scoped.
   - _Full cut-over:_ run `node db/policies/rls-lint.mjs` against the restored instance, then update the
     `database_url`, `database_platform_url` and `database_migrator_url` secrets to the new endpoint and
     force a new deployment of every service:
     `aws ecs update-service --cluster $CLUSTER --service <s> --force-new-deployment`.
     Then import the new instance into Terraform state (or rename instances) so Terraform does not
     recreate the old one.
5. Scale services back up and run the post-deploy checks (§1).
6. Keep the old instance (deletion protection on) until the incident review signs off.

RPO is about 5 minutes (WAL upload interval). RTO is dominated by restore time, roughly 20-60 minutes
depending on size. Rehearse this quarterly on staging and record the timings here.

## 4. Rotate the JWT secret

Access tokens are HS256 with a 15-minute TTL; refresh tokens are opaque and stored hashed in the DB, so
they are **not** affected by JWT rotation.

The API signs with `JWT_SECRET` and also **verifies** with `JWT_SECRET_PREVIOUS` when it is set
(`apps/api/src/core/auth/token.service.ts`), so a scheduled rotation causes no 401s. Terraform injects both
from Secrets Manager (`jwt_secret`, `jwt_secret_previous`; the latter is seeded with the same value).

**Scheduled rotation (zero 401s):**

```bash
CUR=$(aws secretsmanager get-secret-value --secret-id procure-production/jwt_secret --query SecretString --output text)
NEW=$(openssl rand -base64 48 | tr -d '\n')
aws secretsmanager put-secret-value --secret-id procure-production/jwt_secret_previous --secret-string "$CUR"
aws secretsmanager put-secret-value --secret-id procure-production/jwt_secret --secret-string "$NEW"
aws ecs update-service --cluster $CLUSTER --service api --force-new-deployment
aws ecs update-service --cluster $CLUSTER --service worker --force-new-deployment
aws ecs wait services-stable --cluster $CLUSTER --services api worker
unset CUR NEW
```

During the rolling deploy old tasks still sign with the old key, which new tasks accept as previous; new
tokens use the new key. Nothing to undo afterwards: once 15 minutes have passed no old-key token is valid,
and the old value in `jwt_secret_previous` is only ever used for verification until the next rotation.

**Compromised key:** do **not** copy it into `jwt_secret_previous` (put the new value into both secrets
instead, so the leaked key is rejected at once), force the new deployment as above, and revoke sessions
(§5). Users see one silent refresh (the web app calls `/auth/refresh` on 401).

## 5. Revoke all sessions for a tenant

Preferred: Super Admin UI or API (audited). `POST /api/v1/platform/tenants/:id/suspend` revokes all
tenant sessions and blocks access. Use `/reactivate` afterwards if the goal was only to force re-login.

Direct database path (break-glass; record it in the incident doc):

```sql
-- as migrator / platform_user
UPDATE platform.auth_session
   SET revoked_at = now(), revoked_reason = 'ops: tenant-wide revoke <ticket>'
 WHERE tenant_id = '<tenant uuid>' AND revoked_at IS NULL
RETURNING id;
```

This stops refresh at once. Access tokens already issued stay valid for up to 15 minutes unless their
session ids are also put on the Redis revocation list. Push them there too:

```bash
# for each id returned above (TTL = access TTL + 60s)
redis-cli -u "$REDIS_URL" --tls SET "revoked:sid:<id>" 1 EX 960
```

Alternatively, suspend the tenant: the auth guard checks tenant status on **every** request, so
suspension takes effect immediately for all access tokens.

All users of all tenants (for example after a key compromise): rotate the JWT secret (§4) and run the
UPDATE above without the `tenant_id` filter.

## 6. On-call checks

**Daily (or after any page):**

- [ ] CloudWatch alarms in `procure-<env>-*` are all OK
- [ ] ECS: running = desired for api, web, worker; no service stuck mid-deployment
- [ ] ALB target 5xx below 1%; API p95 below 1.5 s
- [ ] RDS: CPU below 80%, free storage above 20%, connections below threshold; no failover events
      (`aws rds describe-events --source-type db-instance --duration 1440`)
- [ ] Redis: memory below 80%, no failover
- [ ] `RlsViolations` metric is 0. Any non-zero value is a P1 cross-tenant bug candidate; open an incident.
- [ ] Latest automated backup is under 24 h old and DR replication is `replicating`
      (`aws rds describe-db-instance-automated-backups --region ap-south-2`)

**Weekly:**

- [ ] Review `pnpm audit` / Trivy findings from CI on `main`
- [ ] ECR scan-on-push findings for the currently deployed tags
- [ ] Platform audit log: impersonation sessions match support tickets

**Severity guide:**

| Sev | Examples                                                            | Response                                        |
| --- | ------------------------------------------------------------------- | ----------------------------------------------- |
| P1  | Cross-tenant data exposure, prod down, data loss                    | Page immediately, incident channel, status page |
| P2  | One module down, sustained 5xx above 5%, login failing for a tenant | Within 30 min                                   |
| P3  | Degraded latency, failing non-critical jobs                         | Next business day                               |

## 7. Bootstrap a new environment (one time)

1. `cd infra/terraform/envs/<env> && cp backend.hcl.example backend.hcl` (fill in the state bucket) and
   run `terraform init -backend-config=backend.hcl`.
2. `terraform apply -var-file=<env>.tfvars`. The first apply creates ECR repositories, but services
   cannot start until an image exists. Push one with the Deploy workflow, or set
   `services.*.desired_count = 0` for the first apply.
3. Populate `procure-<env>/database_migrator_url` using the RDS master secret
   (`terraform output -json stack` gives `db_master_secret_arn`).
4. Run the migrate task once (Deploy workflow does it), then set the real passwords for the roles that
   migration `0001` created with dev passwords:
   ```sql
   ALTER ROLE app_user PASSWORD '<value from procure-<env>/database_url>';
   ALTER ROLE platform_user PASSWORD '<value from procure-<env>/database_platform_url>';
   ```
5. Copy the `terraform output stack` values into the GitHub environment variables listed at the top of
   `.github/workflows/deploy.yml`. Configure the OIDC deploy role (`AWS_DEPLOY_ROLE_ARN`). Require
   reviewers on the `production` environment.
6. Create DNS records for `web_hostname` / `api_hostname` pointing at the ALB.
