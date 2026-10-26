-- 0014 (Architect): let tenant queries use parallel workers, and give the reports scheduler a cross-tenant
-- "who is due" lookup that needs no platform role (same pattern as app.wf_sla_due_tenants).

-- current_setting() values are synchronised to parallel workers, so this is safe to run in them.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.report_due_tenants(p_now timestamptz) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT s.tenant_id FROM app.report_schedule s
  WHERE s.is_active AND s.next_run_at IS NOT NULL AND s.next_run_at <= p_now
  UNION
  SELECT DISTINCT e.tenant_id FROM app.export_job e
  WHERE e.status = 'ready' AND e.expires_at IS NOT NULL AND e.expires_at <= p_now
$$;
REVOKE ALL ON FUNCTION app.report_due_tenants(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.report_due_tenants(timestamptz) TO app_user, platform_user;
