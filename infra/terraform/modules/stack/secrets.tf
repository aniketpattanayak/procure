# Secrets Manager entries. Terraform creates the containers and initial random values; the values
# for database role passwords must match the roles in Postgres (see runbook "Bootstrap a new environment").
# Rotation of JWT secret: see runbook "Rotate JWT secret".

resource "random_password" "jwt" {
  length  = 64
  special = false
}

# HMAC key for signed file URLs (FILE_URL_SECRET) and AES-256 key for provider credentials at rest (PROVIDER_KEY,
# a 64-char hex string is used as-is). Rotating PROVIDER_KEY requires re-entering provider credentials (runbook).
resource "random_id" "file_url_secret" {
  byte_length = 32
}

resource "random_id" "provider_key" {
  byte_length = 32
}

# HMAC-SHA256 key of the audit hash chain (AUDIT_HASH_KEY, SEC8-015). Lives only here, never in the database. Rotation
# moves the old value into audit_hash_key_previous (runbook "Secrets"); rows are never re-hashed.
resource "random_id" "audit_hash_key" {
  byte_length = 32
}

resource "random_password" "app_user" {
  length  = 40
  special = false
}

resource "random_password" "platform_user" {
  length  = 40
  special = false
}

locals {
  db_host = aws_db_instance.this.address
  secret_values = {
    jwt_secret              = random_password.jwt.result
    # Verification-only key during a rotation (runbook §4). Seeded equal to jwt_secret: the API rejects an empty value.
    jwt_secret_previous     = random_password.jwt.result
    file_url_secret         = random_id.file_url_secret.hex
    provider_key            = random_id.provider_key.hex
    audit_hash_key          = random_id.audit_hash_key.hex
    # Verification-only old audit keys (comma-separated). Seeded equal to audit_hash_key: an empty secret is not allowed.
    audit_hash_key_previous = random_id.audit_hash_key.hex
    database_url            = "postgres://app_user:${random_password.app_user.result}@${local.db_host}:5432/procure?sslmode=require"
    database_platform_url   = "postgres://platform_user:${random_password.platform_user.result}@${local.db_host}:5432/procure?sslmode=require"
    redis_url               = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secret_values
  name                    = "${var.name}/${each.key}"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secret_values
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = each.value

  # Values are rotated out-of-band (runbook); Terraform only seeds them.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Migrator URL is assembled at runtime by the migrate task from the RDS-managed master secret.
resource "aws_secretsmanager_secret" "migrator_url" {
  name                    = "${var.name}/database_migrator_url"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.environment == "production" ? 30 : 7
  description             = "postgres://procure_owner:<password from RDS master secret>@host:5432/procure?sslmode=require. Populate after first apply."
}
