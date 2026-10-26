-- 0019 Nightly maintenance jobs (platform/devops release gaps). Jobs run as app_user; these SECURITY DEFINER helpers
-- return tenant ids only (same pattern as app.stock_tenants / app.wf_sla_due_tenants) and the jobs then work inside
-- tenantTx per tenant.

-- Tenants holding orphan-file candidates (never attached, or detached) older than p_before: FilesCleanupJob.
CREATE OR REPLACE FUNCTION app.file_orphan_tenants(p_before timestamptz) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT f.tenant_id FROM app.file_object f
  WHERE f.attached_to IS NULL AND NOT f.is_deleted AND f.created_at < p_before
$$;
REVOKE ALL ON FUNCTION app.file_orphan_tenants(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.file_orphan_tenants(timestamptz) TO app_user, platform_user;

-- Of p_ids, the files of the CURRENT tenant (app.tenant_id) that are still referenced without `attached_to`:
-- vendor quote attachments (app.vendor_quote.file_ids), outbound message attachments
-- (app.outbound_message.attachment_file_ids) and the company logo (platform.tenant.logo_url pointing at
-- /files/<id>/content). Orphan cleanup never deletes these. Definer only because platform.tenant is not readable by
-- app_user; it is scoped to the current tenant, so it can't be used to probe other tenants.
CREATE OR REPLACE FUNCTION app.file_ids_referenced(p_ids uuid[]) RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  WITH t AS (SELECT app.current_tenant_id() AS id), ids AS (SELECT unnest(p_ids) AS id)
  SELECT ids.id FROM ids, t WHERE t.id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM app.vendor_quote q WHERE q.tenant_id = t.id AND q.file_ids @> ARRAY[ids.id])
    OR EXISTS (SELECT 1 FROM app.outbound_message m WHERE m.tenant_id = t.id AND m.attachment_file_ids @> ARRAY[ids.id])
    OR EXISTS (SELECT 1 FROM platform.tenant pt WHERE pt.id = t.id AND pt.logo_url ILIKE '%/files/' || ids.id::text || '/content%')
  )
$$;
REVOKE ALL ON FUNCTION app.file_ids_referenced(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.file_ids_referenced(uuid[]) TO app_user, platform_user;

-- Tenants with quantity-ledger summaries, for the nightly quantity-ledger drift check (ADR-0010).
CREATE OR REPLACE FUNCTION app.qty_ledger_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT s.tenant_id FROM app.line_qty_summary s
$$;
REVOKE ALL ON FUNCTION app.qty_ledger_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.qty_ledger_tenants() TO app_user, platform_user;
