-- 0016 Tenants that hold stock, for the nightly stock drift check (stock module runs as app_user; same pattern as
-- app.wf_sla_due_tenants / app.report_due_tenants). Returns tenant ids only; the check then works inside tenantTx.
-- Owner: Stock agent (Phase 5, ADR-0016 §7).
CREATE OR REPLACE FUNCTION app.stock_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT b.tenant_id FROM app.item_avg_cost b
$$;
REVOKE ALL ON FUNCTION app.stock_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stock_tenants() TO app_user, platform_user;
