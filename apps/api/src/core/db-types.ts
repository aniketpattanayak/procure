import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types. Keep in sync with db/migrations (Architect reviews).
 * Column names are snake_case as in SQL; Kysely is used without a camel-case plugin
 * so SQL in EXPLAIN plans and code read the same.
 */
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T = unknown> = ColumnType<T, T | string | undefined, T | string>;

export interface FeatureCatalogTable { key: string; name: string; description: string | null; kind: string; sort_order: number }
export interface LimitCatalogTable { key: string; name: string; unit: string; meter: 'live_count' | 'monthly' | 'lifetime'; feature_key: string | null; sort_order: number }

export interface PlanTable {
  id: Generated<string>; code: string; name: string; description: string | null;
  price: ColumnType<string, string | number, string | number>; currency: string; billing_cycle: string; trial_days: number;
  is_active: Generated<boolean>; created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number>;
}
export interface PlanFeatureTable { plan_id: string; feature_key: string }
export interface PlanLimitTable { plan_id: string; limit_key: string; value: ColumnType<string | null, number | string | null, number | string | null> }

export interface TenantTable {
  id: Generated<string>; code: string; name: string; legal_name: string | null; logo_url: string | null;
  tax_ids: Json<Record<string, string>>; address: Json<Record<string, string>>; timezone: Generated<string>; currency: Generated<string>;
  fy_start_month: Generated<number>; status: Generated<'active' | 'suspended' | 'archived'>; status_reason: string | null;
  created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number>;
}
export interface SubscriptionTable {
  id: Generated<string>; tenant_id: string; plan_id: string; status: string; start_date: ColumnType<string, string, string>;
  renewal_date: ColumnType<string | null, string | null | undefined, string | null>; trial_ends_on: ColumnType<string | null, string | null | undefined, string | null>;
  effective_from: Ts; effective_to: TsNullable; change_reason: string | null; created_by: string | null; created_at: Generated<Date>;
}
export interface TenantOverrideTable { tenant_id: string; kind: 'feature' | 'limit'; key: string; value: Json; reason: string | null; set_by: string | null; set_at: Generated<Date> }
export interface TenantOverrideHistoryTable { id: Generated<string>; tenant_id: string; kind: string; key: string; old_value: Json | null; new_value: Json | null; reason: string | null; changed_by: string | null; changed_at: Generated<Date> }
export interface UsageMeterTable { tenant_id: string; limit_key: string; period: string; used: ColumnType<string, number | string, number | string>; warned_80: Generated<boolean>; warned_100: Generated<boolean>; updated_at: Generated<Date> }
export interface PlatformUserTable {
  id: Generated<string>; email: string; name: string; role: Generated<'owner' | 'support' | 'billing'>; password_hash: string;
  is_active: Generated<boolean>; must_change_password: Generated<boolean>; failed_logins: Generated<number>; locked_until: TsNullable;
  last_login_at: TsNullable; created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number>;
}
export interface AuthSessionTable {
  id: Generated<string>; subject_type: 'platform' | 'tenant'; subject_id: string; tenant_id: string | null; family_id: string;
  refresh_hash: string; replaced_by: string | null; impersonated_by: string | null; ip: string | null; user_agent: string | null;
  created_at: Generated<Date>; last_used_at: Generated<Date>; expires_at: Ts; revoked_at: TsNullable; revoked_reason: string | null;
}
export interface AuditLogTable {
  id: Generated<string>; tenant_id: ColumnType<string, string | undefined, never>; actor_id: string | null; impersonated_by?: string | null;
  action: string; entity: string; entity_id: string | null; before: Json | null; after: Json | null; ip: string | null; user_agent: string | null;
  at: ColumnType<Date, Date | string | undefined, never>; prev_hash: string | null; hash: string;
  /** SEC8-015 (0022): 'sha256' (legacy rows) | 'hmac-sha256'. */
  hash_alg: ColumnType<'sha256' | 'hmac-sha256', 'sha256' | 'hmac-sha256' | undefined, never>;
}
export interface PlatformAuditLogTable extends Omit<AuditLogTable, 'tenant_id' | 'impersonated_by'> { tenant_id: string | null }
export interface GlobalTemplateTable { id: Generated<string>; kind: string; key: string; name: string; description: string | null; content: Json; is_active: Generated<boolean>; created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number> }

// ---- app schema (tenant tables; tenant_id defaults from context) ----
type TenantId = ColumnType<string, string | undefined, never>;
export interface TenantUserTable {
  id: Generated<string>; tenant_id: TenantId; email: string; name: string; phone: string | null; password_hash: string;
  is_tenant_admin: Generated<boolean>; is_active: Generated<boolean>; must_change_password: Generated<boolean>;
  failed_logins: Generated<number>; locked_until: TsNullable; two_factor: Generated<'off' | 'email' | 'whatsapp'>;
  reporting_manager_id: string | null; custom: Json<Record<string, unknown>>; last_login_at: TsNullable; password_changed_at: TsNullable;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>; is_deleted: Generated<boolean>;
}
export interface RoleTable { id: Generated<string>; tenant_id: TenantId; key: string; name: string; description: string | null; is_system: Generated<boolean>; created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number>; is_deleted: Generated<boolean> }
export interface UserRoleTable { tenant_id: TenantId; user_id: string; role_id: string }
export interface PermissionGrantTable { id: Generated<string>; tenant_id: TenantId; role_id: string | null; user_id: string | null; perm_key: string; effect: Generated<'allow' | 'deny'>; created_at: Generated<Date>; created_by: string | null }
export interface TenantSettingTable { tenant_id: TenantId; key: string; value: Json; updated_at: Generated<Date>; updated_by: string | null }
export interface NotificationTable { id: Generated<string>; tenant_id: TenantId; user_id: string; kind: string; title: string; body: string | null; link: string | null; data: Json<Record<string, unknown>>; read_at: TsNullable; created_at: Generated<Date> }


// ---- Phase 2 (0005, 0006) ----
export interface PlatformPermissionDefTable { key: string; kind: 'tab' | 'action' | 'view'; tab_key: string; label: string; description: string | null; group_label: string | null; requires_feature: string | null; requires_setting: string | null; sort_order: number }
export interface AppPermissionDefTable extends PlatformPermissionDefTable { tenant_id: TenantId; source: 'master' | 'form' | 'workflow' | 'report'; source_id: string | null }
export interface ScopeGrantTable { id: Generated<string>; tenant_id: TenantId; role_id: string | null; user_id: string | null; tab_key: string | null; all_nodes: Generated<boolean>; node_id: string | null; include_descendants: Generated<boolean>; created_at: Generated<Date>; created_by: string | null }
export interface FieldAccessTable { id: Generated<string>; tenant_id: TenantId; form_key: string; field_key: string; role_id: string | null; user_id: string | null; mode: 'hidden' | 'readonly' | 'editable'; created_at: Generated<Date>; created_by: string | null }
export interface LocationNodeTable {
  id: Generated<string>; tenant_id: TenantId; parent_id: string | null; code: string; name: string;
  /** Maintained by triggers; never written by the app. */
  path: ColumnType<string, never, never>; depth: ColumnType<number, never, never>;
  sort_order: Generated<number>; is_active: Generated<boolean>; custom: Json<Record<string, unknown>>;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface FormDefTable {
  id: Generated<string>; tenant_id: TenantId; key: string; name: string; kind: 'master' | 'system' | 'transaction'; is_system: Generated<boolean>;
  current_version_id: string | null; draft: Json | null; draft_updated_at: TsNullable; draft_updated_by: string | null;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface FormVersionTable { id: Generated<string>; tenant_id: TenantId; form_id: string; version: number; definition: Json; change_note: string | null; published_at: Generated<Date>; published_by: string | null }
export interface MasterDefTable {
  id: Generated<string>; tenant_id: TenantId; key: string; name: string; plural_name: string; description: string | null; form_id: string;
  is_system: Generated<boolean>; is_active: Generated<boolean>; settings: Json<Record<string, unknown>>;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface MasterRecordTable {
  id: Generated<string>; tenant_id: TenantId; master_id: string; code: string; name: string; is_active: Generated<boolean>;
  data: Json<Record<string, unknown>>; form_version_id: string; search: ColumnType<string, never, never>;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
  is_deleted: Generated<boolean>; deleted_reason: string | null;
}
export interface RecordRefTable { tenant_id: TenantId; from_kind: string; from_id: string; from_field: string; to_kind: string; to_id: string }
export interface FileObjectTable {
  id: Generated<string>; tenant_id: TenantId; storage_key: string; filename: string; mime: string; size_bytes: ColumnType<string, number | string, number | string>;
  sha256: string; scan_status: Generated<'pending' | 'clean' | 'infected' | 'error'>; width: number | null; height: number | null;
  attached_to: Json<{ kind: string; id: string; field: string }> | null; created_at: Generated<Date>; created_by: string | null; is_deleted: Generated<boolean>;
}

// ---- Phase 3 (0008 documents, 0009 workflow) ----
type Num = ColumnType<string, string | number, string | number>;
type NumNullable = ColumnType<string | null, string | number | null | undefined, string | number | null>;
type DateCol = ColumnType<string, string | undefined, string>;
type DateNullable = ColumnType<string | null, string | null | undefined, string | null>;
export interface DocTypeTable {
  id: Generated<string>; tenant_id: TenantId; key: string; name: string; plural_name: string; description: string | null;
  kind: 'system' | 'custom'; module_key: string | null; header_form_id: string; line_form_id: string | null;
  settings: Json<Record<string, unknown>>; is_active: Generated<boolean>;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface NumberingSeriesTable {
  id: Generated<string>; tenant_id: TenantId; doc_type_id: string; name: string; location_node_id: string | null; pattern: string;
  reset: Generated<'never' | 'fy' | 'month'>; is_active: Generated<boolean>;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface NumberingCounterTable { tenant_id: TenantId; series_id: string; period: string; value: ColumnType<string, number | string | undefined, number | string> }
export interface DocumentTable {
  id: Generated<string>; tenant_id: TenantId; doc_type_id: string; number: string | null; number_series_id: string | null;
  status_key: Generated<string>; location_node_id: string; doc_date: DateCol; required_by: DateNullable; party_id: string | null;
  currency: string | null; total_amount: NumNullable; custom: Json<Record<string, unknown>>; form_version_id: string; line_form_version_id: string | null;
  is_locked: Generated<boolean>; rev_no: Generated<number>; submitted_at: TsNullable; submitted_by: string | null; closed_at: TsNullable; closed_reason: string | null;
  cancelled_at: TsNullable; cancelled_reason: string | null;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>; is_deleted: Generated<boolean>;
}
export interface DocumentLineTable {
  id: Generated<string>; tenant_id: TenantId; document_id: string; doc_type_id: string; line_no: number; item_id: string | null; uom_id: string | null;
  qty: Num; rate: NumNullable; amount: NumNullable; required_date: DateNullable; location_node_id: string; status_key: Generated<string>;
  custom: Json<Record<string, unknown>>; cancelled_reason: string | null;
  created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>; is_deleted: Generated<boolean>;
}
export interface LineEventTable {
  id: Generated<string>; tenant_id: TenantId; line_id: string; document_id: string; event_type: string; qty: Num; ref_line_id: string | null;
  wf_action_id: string | null; stage_key: string | null; reason: string | null; actor_id: string | null; at: Generated<Date>;
}
export interface LineQtySummaryTable {
  line_id: string; tenant_id: TenantId; document_id: string;
  requested: Generated<string>; approved: Generated<string>; held: Generated<string>; rejected: Generated<string>; cancelled: Generated<string>;
  short_closed: Generated<string>; over_approved: Generated<string>; selected: Generated<string>; ordered: Generated<string>; received: Generated<string>;
  accepted: Generated<string>; rejected_at_receipt: Generated<string>; issued: Generated<string>; returned: Generated<string>;
  last_event_id: string | null; updated_at: Generated<Date>;
}
export interface LineLinkTable { id: Generated<string>; tenant_id: TenantId; from_line_id: string; to_line_id: string; link_type: string; qty: Num; created_at: Generated<Date>; created_by: string | null; is_cancelled: Generated<boolean> }
export interface CommentTable { id: Generated<string>; tenant_id: TenantId; entity_kind: string; entity_id: string; parent_id: string | null; body: string; mentions: ColumnType<string[], string[] | undefined, string[]>; created_at: Generated<Date>; created_by: string; edited_at: TsNullable; is_deleted: Generated<boolean> }
export interface AttachmentTable { id: Generated<string>; tenant_id: TenantId; entity_kind: string; entity_id: string; file_id: string; note: string | null; created_at: Generated<Date>; created_by: string; is_deleted: Generated<boolean> }
export interface SavedViewTable { id: Generated<string>; tenant_id: TenantId; scope_key: string; name: string; owner_user_id: string | null; shared_role_ids: ColumnType<string[], string[] | undefined, string[]>; config: Json<Record<string, unknown>>; is_default: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; version: Generated<number> }
export interface OutboxEventTable { id: Generated<string>; tenant_id: TenantId; event_type: string; aggregate_kind: string; aggregate_id: string | null; payload: Json<Record<string, unknown>>; created_at: Generated<Date>; published_at: TsNullable; attempts: Generated<number>; last_error: string | null }
export interface AuditCheckTable { id: Generated<string>; tenant_id: string | null; checked_at: Generated<Date>; rows_checked: ColumnType<string, number | string, number | string>; ok: boolean; first_bad_id: ColumnType<string | null, number | string | null | undefined, number | string | null>; detail: string | null }
export interface WorkflowDefTable { id: Generated<string>; tenant_id: TenantId; doc_type_id: string; name: string; current_version_id: string | null; draft: Json | null; draft_updated_at: TsNullable; draft_updated_by: string | null; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number> }
export interface WorkflowVersionTable { id: Generated<string>; tenant_id: TenantId; workflow_id: string; version: number; definition: Json; change_note: string | null; published_at: Generated<Date>; published_by: string | null }
export interface WfInstanceTable { id: Generated<string>; tenant_id: TenantId; document_id: string; workflow_version_id: string; status: 'running' | 'completed' | 'cancelled'; started_at: Generated<Date>; started_by: string | null; completed_at: TsNullable; cancel_reason: string | null }
export interface WfStageStateTable { tenant_id: TenantId; instance_id: string; stage_key: string; status: 'pending' | 'active' | 'done' | 'skipped' | 'disabled'; skip_reason: string | null; entered_at: TsNullable; due_at: TsNullable; next_reminder_at: TsNullable; reminders_sent: Generated<number>; escalated_at: TsNullable; completed_at: TsNullable }
export interface WfLineStateTable { tenant_id: TenantId; instance_id: string; line_id: string; stage_key: string; pending_qty: Num; held_qty: Num; entered_at: Generated<Date>; updated_at: Generated<Date> }
export interface WfActionTable { id: Generated<string>; tenant_id: TenantId; instance_id: string; document_id: string; stage_key: string; action: string; actor_id: string | null; on_behalf_of: string | null; comment: string | null; decisions: Json<unknown[]>; target_stage: string | null; target_user_id: string | null; idempotency_key: string | null; at: Generated<Date> }
export interface WfAssignmentTable { id: Generated<string>; tenant_id: TenantId; instance_id: string; stage_key: string; user_id: string; reason: 'forward' | 'escalation'; created_at: Generated<Date>; created_by: string | null; is_active: Generated<boolean> }

// ---- Phases 4, 6, 7 (0011 procurement, 0012 notify, 0013 reports) ----
type UuidArr = ColumnType<string[], string[] | undefined, string[]>;
export interface VendorQuoteTable {
  id: Generated<string>; tenant_id: TenantId; indent_line_id: string; item_id: string | null; vendor_id: string; version: Generated<number>;
  supersedes_id: string | null; is_current: Generated<boolean>; quoted_rate: Num; currency: Generated<string>; uom_id: string | null; moq: NumNullable;
  lead_time_days: number | null; valid_until: DateNullable; payment_terms_id: string | null; freight: ColumnType<string, string | number | undefined, string | number>;
  freight_basis: Generated<'lump_sum' | 'per_unit'>; tax_pct: ColumnType<string, string | number | undefined, string | number>; slabs: Json<unknown[]>;
  notes: string | null; file_ids: UuidArr; custom: Json<Record<string, unknown>>; logged_at: Generated<Date>; created_at: Generated<Date>; created_by: string;
}
export interface PoFollowupTable {
  id: Generated<string>; tenant_id: TenantId; document_id: string; line_id: string | null; contact_mode: Generated<string>; contact_person: string | null;
  promised_date: DateNullable; revised_expected_date: DateNullable; reason: string | null; notes: string | null; created_at: Generated<Date>; created_by: string;
}
export interface DocumentRevisionTable { id: Generated<string>; tenant_id: TenantId; document_id: string; rev_no: number; snapshot: Json; diff: Json | null; reason: string | null; status: Generated<'open' | 'approved' | 'rejected' | 'withdrawn'>; created_at: Generated<Date>; created_by: string | null }
export interface LineTaxTable { tenant_id: TenantId; line_id: string; document_id: string; component: 'cgst' | 'sgst' | 'igst' | 'cess'; rate_pct: Num; taxable_amount: Num; tax_amount: Num }
export interface ProviderCredentialTable { id: Generated<string>; tenant_id: string | null; channel: 'email' | 'whatsapp'; provider: 'ses' | 'smtp' | 'meta' | 'bsp' | 'log'; config: Json<Record<string, unknown>>; secret: string | null; is_active: Generated<boolean>; created_at: Generated<Date>; updated_at: Generated<Date>; version: Generated<number> }
export interface WhatsappTemplateTable { id: Generated<string>; name: string; language: Generated<string>; category: string; header_kind: Generated<string>; body: string; variables: Json<unknown[]>; meta_status: Generated<string>; is_active: Generated<boolean>; created_at: Generated<Date> }
export interface TenantWhatsappTemplateTable { tenant_id: string; template_id: string; approved_by: string | null; approved_at: Generated<Date> }
export interface MessageTemplateTable {
  id: Generated<string>; tenant_id: TenantId; channel: 'pdf' | 'email' | 'whatsapp' | 'inapp'; doc_type_key: string | null; key: string; name: string;
  subject: string | null; body: string; whatsapp_template_id: string | null; whatsapp_variables: Json<unknown[]>; pdf_options: Json<Record<string, unknown>>;
  is_default: Generated<boolean>; is_active: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number>;
}
export interface TriggerRuleTable {
  id: Generated<string>; tenant_id: TenantId; name: string; event_type: string; doc_type_key: string | null; condition: string | null;
  channel: 'email' | 'whatsapp' | 'inapp'; template_id: string; recipients: Json<unknown[]>; attach_pdf_template_id: string | null;
  mode: Generated<'auto' | 'manual'>; is_active: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; version: Generated<number>;
}
export interface OutboundMessageTable {
  id: Generated<string>; tenant_id: TenantId; channel: 'email' | 'whatsapp' | 'inapp'; idempotency_key: string; trigger_rule_id: string | null; template_id: string | null;
  template_version: number | null; document_id: string | null; recipient: string; recipient_name: string | null; subject: string | null; body_preview: string | null;
  attachment_file_ids: UuidArr; status: Generated<string>; provider: string | null; provider_message_id: string | null; error: string | null; attempts: Generated<number>;
  manual: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; sent_at: TsNullable; delivered_at: TsNullable; read_at: TsNullable;
  render_hidden: ColumnType<{ header: string[]; line: string[] } | null, string | null | undefined, string | null>;
}
export interface GeneratedPdfTable { id: Generated<string>; tenant_id: TenantId; document_id: string; template_id: string; template_version: number; document_version: number; access_key: Generated<string>; hidden_fields: ColumnType<{ header: string[]; line: string[] } | null, string | null | undefined, string | null>; file_id: string | null; status: Generated<'queued' | 'rendering' | 'ready' | 'failed'>; error: string | null; created_at: Generated<Date>; created_by: string | null }
export interface WebhookEndpointTable { id: Generated<string>; tenant_id: TenantId; url: string; description: string | null; events: ColumnType<string[], string[], string[]>; secret: string; is_active: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; version: Generated<number> }
export interface WebhookDeliveryTable { id: Generated<string>; tenant_id: TenantId; endpoint_id: string; outbox_id: ColumnType<string, number | string, number | string>; event_type: string; status: Generated<'pending' | 'delivered' | 'failed'>; attempts: Generated<number>; response_code: number | null; response_body: string | null; next_attempt_at: TsNullable; created_at: Generated<Date>; delivered_at: TsNullable }
export interface ReportDefTable { id: Generated<string>; tenant_id: TenantId; key: string; name: string; description: string | null; kind: 'builtin' | 'custom'; definition: Json; owner_user_id: string | null; shared_role_ids: UuidArr; is_active: Generated<boolean>; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; updated_by: string | null; version: Generated<number> }
export interface ReportScheduleTable { id: Generated<string>; tenant_id: TenantId; report_id: string; cron: string; format: Generated<'xlsx' | 'csv' | 'pdf'>; recipients: Json<unknown[]>; filters: Json<Record<string, unknown>>; run_as_user_id: string; next_run_at: TsNullable; last_run_at: TsNullable; is_active: Generated<boolean>; created_at: Generated<Date>; created_by: string | null }
export interface DashboardDefTable { id: Generated<string>; tenant_id: TenantId; name: string; layout: Json; owner_user_id: string | null; shared_role_ids: UuidArr; is_default_for_role_ids: UuidArr; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; version: Generated<number> }
export interface ExportJobTable { id: Generated<string>; tenant_id: TenantId; kind: 'report' | 'list' | 'master' | 'import'; source: Json<Record<string, unknown>>; format: 'xlsx' | 'csv' | 'pdf'; status: Generated<'queued' | 'running' | 'ready' | 'failed' | 'expired'>; row_count: ColumnType<string | null, number | string | null | undefined, number | string | null>; file_id: string | null; error: string | null; requested_by: string; created_at: Generated<Date>; started_at: TsNullable; finished_at: TsNullable; expires_at: TsNullable }

// ---- Phase 5 (0015 stock) ----
export interface StockBatchTable { id: Generated<string>; tenant_id: TenantId; item_id: string; batch_no: string; mfg_date: DateNullable; expiry_date: DateNullable; vendor_id: string | null; created_at: Generated<Date> }
export interface StockMovementTable {
  id: Generated<string>; tenant_id: TenantId; item_id: string; node_id: string; batch_id: string | null; stock_status: 'available' | 'quarantine' | 'rejected';
  movement_type: string; qty_in: ColumnType<string, string | number | undefined, never>; qty_out: ColumnType<string, string | number | undefined, never>;
  unit_cost: ColumnType<string, string | number | undefined, never>; value: ColumnType<string, string | number | undefined, never>;
  document_id: string | null; line_id: string | null; pair_id: string | null; reason: string | null; actor_id: string | null; at: Generated<Date>; idempotency_key: string | null;
}
export interface StockBalanceTable { tenant_id: TenantId; item_id: string; node_id: string; batch_key: Generated<string>; stock_status: 'available' | 'quarantine' | 'rejected'; qty: Num; value: Num; last_movement_id: string | null; updated_at: Generated<Date> }
export interface ItemAvgCostTable { tenant_id: TenantId; item_id: string; node_id: string; qty: Num; value: Num; avg_cost: Num; updated_at: Generated<Date> }
export interface ValuationLayerTable { id: Generated<string>; tenant_id: TenantId; item_id: string; node_id: string; movement_id: string; received_at: Date | string; qty_in: Num; qty_left: Num; unit_cost: Num }
export interface ReorderRuleTable { id: Generated<string>; tenant_id: TenantId; item_id: string; node_id: string; min_qty: Num; reorder_qty: Num; max_qty: NumNullable; auto_indent: Generated<boolean>; is_active: Generated<boolean>; last_alert_at: TsNullable; created_at: Generated<Date>; created_by: string | null; updated_at: Generated<Date>; version: Generated<number> }

export interface DB {
  'platform.feature_catalog': FeatureCatalogTable;
  'platform.limit_catalog': LimitCatalogTable;
  'platform.plan': PlanTable;
  'platform.plan_feature': PlanFeatureTable;
  'platform.plan_limit': PlanLimitTable;
  'platform.tenant': TenantTable;
  'platform.subscription': SubscriptionTable;
  'platform.tenant_override': TenantOverrideTable;
  'platform.tenant_override_history': TenantOverrideHistoryTable;
  'platform.usage_meter': UsageMeterTable;
  'platform.platform_user': PlatformUserTable;
  'platform.auth_session': AuthSessionTable;
  'platform.audit_log': PlatformAuditLogTable;
  'platform.global_template': GlobalTemplateTable;
  'app.tenant_user': TenantUserTable;
  'app.role': RoleTable;
  'app.user_role': UserRoleTable;
  'app.permission_grant': PermissionGrantTable;
  'app.tenant_setting': TenantSettingTable;
  'app.audit_log': AuditLogTable;
  'app.notification': NotificationTable;
  'platform.permission_def': PlatformPermissionDefTable;
  'app.permission_def': AppPermissionDefTable;
  'app.scope_grant': ScopeGrantTable;
  'app.field_access': FieldAccessTable;
  'app.location_node': LocationNodeTable;
  'app.form_def': FormDefTable;
  'app.form_version': FormVersionTable;
  'app.master_def': MasterDefTable;
  'app.master_record': MasterRecordTable;
  'app.record_ref': RecordRefTable;
  'app.file_object': FileObjectTable;
  'app.doc_type': DocTypeTable;
  'app.numbering_series': NumberingSeriesTable;
  'app.numbering_counter': NumberingCounterTable;
  'app.document': DocumentTable;
  'app.document_line': DocumentLineTable;
  'app.line_event': LineEventTable;
  'app.line_qty_summary': LineQtySummaryTable;
  'app.line_link': LineLinkTable;
  'app.comment': CommentTable;
  'app.attachment': AttachmentTable;
  'app.saved_view': SavedViewTable;
  'app.outbox_event': OutboxEventTable;
  'platform.audit_check': AuditCheckTable;
  'app.workflow_def': WorkflowDefTable;
  'app.workflow_version': WorkflowVersionTable;
  'app.wf_instance': WfInstanceTable;
  'app.wf_stage_state': WfStageStateTable;
  'app.wf_line_state': WfLineStateTable;
  'app.wf_action': WfActionTable;
  'app.wf_assignment': WfAssignmentTable;
  'app.vendor_quote': VendorQuoteTable;
  'app.po_followup': PoFollowupTable;
  'app.document_revision': DocumentRevisionTable;
  'app.line_tax': LineTaxTable;
  'platform.provider_credential': ProviderCredentialTable;
  'platform.whatsapp_template': WhatsappTemplateTable;
  'platform.tenant_whatsapp_template': TenantWhatsappTemplateTable;
  'app.message_template': MessageTemplateTable;
  'app.trigger_rule': TriggerRuleTable;
  'app.outbound_message': OutboundMessageTable;
  'app.generated_pdf': GeneratedPdfTable;
  'app.webhook_endpoint': WebhookEndpointTable;
  'app.webhook_delivery': WebhookDeliveryTable;
  'app.report_def': ReportDefTable;
  'app.report_schedule': ReportScheduleTable;
  'app.dashboard_def': DashboardDefTable;
  'app.export_job': ExportJobTable;
  'app.stock_batch': StockBatchTable;
  'app.stock_movement': StockMovementTable;
  'app.stock_balance': StockBalanceTable;
  'app.item_avg_cost': ItemAvgCostTable;
  'app.valuation_layer': ValuationLayerTable;
  'app.reorder_rule': ReorderRuleTable;
}
