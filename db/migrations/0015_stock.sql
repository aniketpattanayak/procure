-- 0015 Stock (Phase 5): movement ledger, balances, batches, valuation, re-order rules. Owner: Stock agent
-- (contract frozen by Architect). ADR-0016. GRN, return-to-vendor, transfer, adjustment, count, issue request,
-- store issue and store return are SYSTEM document types on the documents core; they post stock only through the
-- StockLedger service (never by updating balances directly).

CREATE TABLE app.stock_batch (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id      uuid NOT NULL REFERENCES app.master_record(id),
  batch_no     text NOT NULL,
  mfg_date     date,
  expiry_date  date,
  vendor_id    uuid REFERENCES app.master_record(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, item_id, batch_no)
);
CREATE INDEX stock_batch_expiry ON app.stock_batch (tenant_id, expiry_date) WHERE expiry_date IS NOT NULL;
SELECT app.enable_tenant_rls('app.stock_batch');

-- Append-only movement ledger. One row per (item, node, batch, status) change. qty_in/qty_out in the item's base UoM.
CREATE TABLE app.stock_movement (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id          uuid NOT NULL REFERENCES app.master_record(id),
  node_id          uuid NOT NULL REFERENCES app.location_node(id),
  batch_id         uuid REFERENCES app.stock_batch(id),
  stock_status     text NOT NULL CHECK (stock_status IN ('available', 'quarantine', 'rejected')),
  movement_type    text NOT NULL CHECK (movement_type IN ('opening', 'receipt', 'issue', 'return', 'transfer_out', 'transfer_in',
                     'adjustment_in', 'adjustment_out', 'block', 'unblock', 'reject', 'rtv', 'count_in', 'count_out', 'reversal')),
  qty_in           numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_in >= 0),
  qty_out          numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty_out >= 0),
  unit_cost        numeric(18,6) NOT NULL DEFAULT 0,      -- valuation rate applied to this movement
  value            numeric(18,4) NOT NULL DEFAULT 0,      -- signed: + for in, − for out
  document_id      uuid REFERENCES app.document(id),
  line_id          uuid REFERENCES app.document_line(id),
  pair_id          uuid,                                   -- links the two sides of a block/unblock/transfer
  reason           text,
  actor_id         uuid,
  at               timestamptz NOT NULL DEFAULT now(),
  idempotency_key  text,
  CHECK ((qty_in > 0) <> (qty_out > 0))
);
CREATE UNIQUE INDEX stock_movement_idem ON app.stock_movement (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_movement_item ON app.stock_movement (tenant_id, item_id, node_id, at DESC, id);
CREATE INDEX stock_movement_doc ON app.stock_movement (tenant_id, document_id);
CREATE INDEX stock_movement_at ON app.stock_movement (tenant_id, at DESC, id);
SELECT app.enable_tenant_rls('app.stock_movement');

-- Maintained in the same transaction as each movement (StockLedger). Never written any other way.
CREATE TABLE app.stock_balance (
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id       uuid NOT NULL REFERENCES app.master_record(id),
  node_id       uuid NOT NULL REFERENCES app.location_node(id),
  batch_key     uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', -- batch id or zero uuid for non-batch items
  stock_status  text NOT NULL CHECK (stock_status IN ('available', 'quarantine', 'rejected')),
  qty           numeric(18,4) NOT NULL DEFAULT 0,
  value         numeric(18,4) NOT NULL DEFAULT 0,
  last_movement_id bigint,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, node_id, batch_key, stock_status)
);
CREATE INDEX stock_balance_node ON app.stock_balance (tenant_id, node_id, item_id);
SELECT app.enable_tenant_rls('app.stock_balance');

-- Weighted-average cost per item × valuation node (the node itself; the tenant setting decides WAC vs FIFO).
CREATE TABLE app.item_avg_cost (
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id    uuid NOT NULL REFERENCES app.master_record(id),
  node_id    uuid NOT NULL REFERENCES app.location_node(id),
  qty        numeric(18,4) NOT NULL DEFAULT 0,
  value      numeric(18,4) NOT NULL DEFAULT 0,
  avg_cost   numeric(18,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, node_id)
);
SELECT app.enable_tenant_rls('app.item_avg_cost');

-- FIFO layers: each receipt opens a layer; issues consume oldest first.
CREATE TABLE app.valuation_layer (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id       uuid NOT NULL REFERENCES app.master_record(id),
  node_id       uuid NOT NULL REFERENCES app.location_node(id),
  movement_id   bigint NOT NULL REFERENCES app.stock_movement(id),
  received_at   timestamptz NOT NULL,
  qty_in        numeric(18,4) NOT NULL,
  qty_left      numeric(18,4) NOT NULL CHECK (qty_left >= 0),
  unit_cost     numeric(18,6) NOT NULL
);
CREATE INDEX valuation_layer_open ON app.valuation_layer (tenant_id, item_id, node_id, received_at, id) WHERE qty_left > 0;
SELECT app.enable_tenant_rls('app.valuation_layer');

CREATE TABLE app.reorder_rule (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  item_id       uuid NOT NULL REFERENCES app.master_record(id),
  node_id       uuid NOT NULL REFERENCES app.location_node(id),
  min_qty       numeric(18,4) NOT NULL CHECK (min_qty >= 0),
  reorder_qty   numeric(18,4) NOT NULL CHECK (reorder_qty > 0),
  max_qty       numeric(18,4),
  auto_indent   boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  last_alert_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, item_id, node_id)
);
SELECT app.enable_tenant_rls('app.reorder_rule');
CREATE TRIGGER reorder_rule_touch BEFORE UPDATE ON app.reorder_rule FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

GRANT SELECT, INSERT ON app.stock_batch, app.stock_movement, app.valuation_layer TO app_user, platform_user;
GRANT UPDATE (qty_left) ON app.valuation_layer TO app_user, platform_user;
GRANT SELECT, INSERT, UPDATE ON app.stock_balance, app.item_avg_cost TO app_user, platform_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.reorder_rule TO app_user, platform_user;
REVOKE UPDATE, DELETE ON app.stock_movement FROM app_user, platform_user;

INSERT INTO platform.permission_def (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order) VALUES
  ('stock',                          'tab',    'stock',  'Stock',                    'Store', 'store', NULL, 500),
  ('stock:action.view',              'action', 'stock',  'View stock and ledger',    NULL, 'store', NULL, 1),
  ('stock:action.view_value',        'action', 'stock',  'See stock values',         NULL, 'store', NULL, 2),
  ('stock:action.opening',           'action', 'stock',  'Post opening balances',    NULL, 'store', NULL, 3),
  ('stock:action.reorder',           'action', 'stock',  'Manage re-order levels',   NULL, 'store', NULL, 4),
  ('stock:action.block',             'action', 'stock',  'Block / unblock stock',    NULL, 'store', NULL, 5),
  ('stock:view.available',           'view',   'stock',  'Available',                NULL, 'store', NULL, 1),
  ('stock:view.quarantine',          'view',   'stock',  'Quarantine / blocked',     NULL, 'store', NULL, 2),
  ('stock:view.rejected',            'view',   'stock',  'Rejected',                 NULL, 'store', NULL, 3);
