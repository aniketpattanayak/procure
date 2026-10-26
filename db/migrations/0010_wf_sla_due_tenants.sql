-- 0010 Tenants with due SLA work, for the cross-tenant SLA scan (workflow module runs as app_user).
-- Returns tenant ids only; the scan then works inside tenantTx per tenant. Owner: Architect (requested by workflow agent).
CREATE OR REPLACE FUNCTION app.wf_sla_due_tenants(p_now timestamptz) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT DISTINCT s.tenant_id FROM app.wf_stage_state s
  WHERE s.status = 'active'
    AND ((s.next_reminder_at IS NOT NULL AND s.next_reminder_at <= p_now)
      OR (s.due_at IS NOT NULL AND s.escalated_at IS NULL AND s.due_at <= p_now))
$$;
REVOKE ALL ON FUNCTION app.wf_sla_due_tenants(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.wf_sla_due_tenants(timestamptz) TO app_user, platform_user;
