-- 0004 Reference data: feature and limit catalogs (platform-wide, not tenant-specific).
-- New modules register here; plans and permission registry read from these rows.

INSERT INTO platform.feature_catalog (key, name, kind, sort_order, description) VALUES
  ('indent',          'Indent',                'module',     10, 'Purchase requisitions'),
  ('vendor_quotes',   'Vendor quotes & selection', 'module', 20, 'Quote log, comparison, vendor selection'),
  ('purchase',        'Purchase orders',       'module',     30, 'POs, follow-ups, amendments'),
  ('grn',             'Goods receipt',         'module',     40, 'GRN and verification chain'),
  ('store',           'Store & inventory',     'module',     50, 'Stock ledger, transfers, adjustments, counts, issue/return'),
  ('reports',         'Reports',               'module',     60, 'Ready-made reports and dashboards'),
  ('report_builder',  'Report builder',        'capability', 70, 'Design custom reports'),
  ('form_builder',    'Form builder',          'capability', 80, 'Tenant may manage form fields and masters'),
  ('workflow_designer','Workflow designer',    'capability', 90, 'Tenant may design approval workflows'),
  ('pdf_templates',   'PDF templates',         'capability', 100, 'Custom PDF layouts'),
  ('email',           'Email',                 'channel',    110, 'Email sending'),
  ('whatsapp',        'WhatsApp',              'channel',    120, 'WhatsApp Business sending'),
  ('api_access',      'API & webhooks',        'capability', 130, 'REST API keys and outgoing webhooks'),
  ('two_factor',      'Two-factor login',      'capability', 140, 'OTP second factor')
ON CONFLICT (key) DO NOTHING;

INSERT INTO platform.limit_catalog (key, name, unit, meter, feature_key, sort_order) VALUES
  ('max_users',            'Active users',             'count',    'live_count', NULL,         10),
  ('max_locations',        'Locations',                'count',    'live_count', NULL,         20),
  ('custom_forms',         'Custom forms / masters',   'count',    'live_count', 'form_builder', 30),
  ('whatsapp_per_month',   'WhatsApp messages / month','messages', 'monthly',    'whatsapp',   40),
  ('whatsapp_templates',   'WhatsApp templates',       'count',    'live_count', 'whatsapp',   50),
  ('email_per_month',      'Emails / month',           'messages', 'monthly',    'email',      60),
  ('storage_gb',           'Storage',                  'GB',       'lifetime',   NULL,         70),
  ('api_calls_per_month',  'API calls / month',        'calls',    'monthly',    'api_access', 80),
  ('webhook_endpoints',    'Webhook endpoints',        'count',    'live_count', 'api_access', 90)
ON CONFLICT (key) DO NOTHING;
