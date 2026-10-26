-- 0005 Permission registry, data scope, field access, location tree.
-- Owner: Permissions agent (contract frozen by Architect, Phase 2).
--
-- Permission key grammar (ADR-0005):
--   tab     : <tab>                       e.g. admin.users, master.item, indent
--   action  : <tab>:action.<name>         e.g. admin.users:action.add, master.item:action.import
--   view    : <tab>:view.<name>           e.g. master.item:view.inactive, indent:view.draft
-- A tab is shown in the sidebar iff the user holds <tab>:action.view.

-- Platform-wide registry: modules, buttons, status views that ship with the product.
CREATE TABLE platform.permission_def (
  key              text PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('tab', 'action', 'view')),
  tab_key          text NOT NULL,                 -- = key for tabs
  label            text NOT NULL,                 -- i18n key or plain English
  description      text,
  group_label      text,                          -- sidebar / permission-screen grouping: 'Administration', 'Configuration', 'Masters', 'Procurement' ...
  requires_feature text REFERENCES platform.feature_catalog(key),
  requires_setting text,                          -- boolean tenant setting that must be true, e.g. 'flow.indent.enabled'
  sort_order       int NOT NULL DEFAULT 0,
  CHECK ((kind = 'tab') = (key = tab_key))
);
-- app_user has no direct access to platform tables (rls-lint); it reads the registry through this function.
CREATE OR REPLACE FUNCTION app.platform_permission_defs()
RETURNS SETOF platform.permission_def LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
  SELECT * FROM platform.permission_def
$$;
REVOKE ALL ON FUNCTION app.platform_permission_defs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_permission_defs() TO app_user, platform_user;
GRANT SELECT ON platform.permission_def TO platform_user;

-- Tenant-generated entries (one tab + actions + views per master; later: workflow stages, custom forms).
CREATE TABLE app.permission_def (
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  key              text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('tab', 'action', 'view')),
  tab_key          text NOT NULL,
  label            text NOT NULL,
  description      text,
  group_label      text,
  requires_feature text,
  requires_setting text,
  sort_order       int NOT NULL DEFAULT 0,
  source           text NOT NULL CHECK (source IN ('master', 'form', 'workflow', 'report')),
  source_id        uuid,
  PRIMARY KEY (tenant_id, key),
  CHECK ((kind = 'tab') = (key = tab_key))
);
CREATE INDEX permission_def_source ON app.permission_def (tenant_id, source, source_id);
SELECT app.enable_tenant_rls('app.permission_def');

-- Data scope: which location nodes a role/user may act on. No rows for a user (directly or via roles) = no
-- location-scoped data. tab_key NULL = applies to every tab; a tab-specific row narrows/extends for that tab.
CREATE TABLE app.scope_grant (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant_id(),
  role_id             uuid REFERENCES app.role(id),
  user_id             uuid REFERENCES app.tenant_user(id),
  tab_key             text,
  all_nodes           boolean NOT NULL DEFAULT false,   -- true = whole tree (node_id NULL)
  node_id             uuid,
  include_descendants boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  CHECK ((role_id IS NULL) <> (user_id IS NULL)),
  CHECK (all_nodes = (node_id IS NULL))
);
CREATE INDEX scope_grant_role ON app.scope_grant (tenant_id, role_id);
CREATE INDEX scope_grant_user ON app.scope_grant (tenant_id, user_id);
SELECT app.enable_tenant_rls('app.scope_grant');

-- Field-level access. Role rows: most restrictive wins (hidden > readonly). A user row overrides roles,
-- including 'editable' to lift a role restriction for that one user.
CREATE TABLE app.field_access (
  id         uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  form_key   text NOT NULL,
  field_key  text NOT NULL,                 -- grid columns: '<grid>.<column>'
  role_id    uuid REFERENCES app.role(id),
  user_id    uuid REFERENCES app.tenant_user(id),
  mode       text NOT NULL CHECK (mode IN ('hidden', 'readonly', 'editable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK ((role_id IS NULL) <> (user_id IS NULL)),
  CHECK (role_id IS NULL OR mode <> 'editable')
);
CREATE UNIQUE INDEX field_access_role ON app.field_access (tenant_id, form_key, field_key, role_id) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX field_access_user ON app.field_access (tenant_id, form_key, field_key, user_id) WHERE user_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.field_access');

-- Location tree. path = ltree of node labels 'n<uuid hex>' from root to node; maintained by triggers.
-- "All descendants of X" = path <@ X.path (GiST index).
CREATE TABLE app.location_node (
  id         uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  parent_id  uuid REFERENCES app.location_node(id),
  code       citext NOT NULL,
  name       text NOT NULL,
  path       ltree NOT NULL,
  depth      int NOT NULL CHECK (depth BETWEEN 1 AND 50),
  sort_order int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  custom     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE INDEX location_node_path ON app.location_node USING gist (path);
CREATE INDEX location_node_parent ON app.location_node (tenant_id, parent_id, sort_order);
SELECT app.enable_tenant_rls('app.location_node');
CREATE TRIGGER location_node_touch BEFORE UPDATE ON app.location_node FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE app.scope_grant ADD CONSTRAINT scope_grant_node_fk FOREIGN KEY (node_id) REFERENCES app.location_node(id);

CREATE OR REPLACE FUNCTION app.location_label(id uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'n' || replace(id::text, '-', '')
$$;

CREATE OR REPLACE FUNCTION app.location_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path ltree;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := app.location_label(NEW.id)::ltree;
  ELSE
    SELECT path INTO parent_path FROM app.location_node WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN RAISE EXCEPTION 'parent location not found' USING ERRCODE = 'foreign_key_violation'; END IF;
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'cannot move a location under itself or its own descendant' USING ERRCODE = 'check_violation';
    END IF;
    NEW.path := parent_path || app.location_label(NEW.id)::ltree;
  END IF;
  NEW.depth := nlevel(NEW.path);
  RETURN NEW;
END$$;

CREATE TRIGGER location_node_path_ins BEFORE INSERT ON app.location_node
  FOR EACH ROW EXECUTE FUNCTION app.location_set_path();
CREATE TRIGGER location_node_path_move BEFORE UPDATE OF parent_id ON app.location_node
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id) EXECUTE FUNCTION app.location_set_path();

-- After a move, rewrite every descendant's path prefix in one statement.
CREATE OR REPLACE FUNCTION app.location_move_subtree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE app.location_node
     SET path = NEW.path || subpath(path, nlevel(OLD.path)),
         depth = nlevel(NEW.path) + nlevel(path) - nlevel(OLD.path)
   WHERE path <@ OLD.path AND id <> NEW.id;
  RETURN NULL;
END$$;
CREATE TRIGGER location_node_subtree AFTER UPDATE OF parent_id ON app.location_node
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id) EXECUTE FUNCTION app.location_move_subtree();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.permission_def, app.scope_grant, app.field_access, app.location_node TO app_user, platform_user;

-- ---------------------------------------------------------------------------------------------
-- Seed: platform registry for Phase 1–2 surfaces. Later phases append rows in their own migrations.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permission_def (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order) VALUES
  -- Administration
  ('admin.users',                         'tab',    'admin.users',     'Users',              'Administration', NULL, NULL, 900),
  ('admin.users:action.view',             'action', 'admin.users',     'View users',         NULL, NULL, NULL, 1),
  ('admin.users:action.add',              'action', 'admin.users',     'Add user',           NULL, NULL, NULL, 2),
  ('admin.users:action.edit',             'action', 'admin.users',     'Edit user',          NULL, NULL, NULL, 3),
  ('admin.users:action.deactivate',       'action', 'admin.users',     'Deactivate / activate', NULL, NULL, NULL, 4),
  ('admin.users:action.reset_password',   'action', 'admin.users',     'Reset password / unlock', NULL, NULL, NULL, 5),
  ('admin.users:action.force_logout',     'action', 'admin.users',     'View sessions / force logout', NULL, NULL, NULL, 6),
  ('admin.users:action.manage_permissions','action','admin.users',     'Set user permissions', NULL, NULL, NULL, 7),
  ('admin.users:view.active',             'view',   'admin.users',     'Active',             NULL, NULL, NULL, 1),
  ('admin.users:view.inactive',           'view',   'admin.users',     'Inactive',           NULL, NULL, NULL, 2),
  ('admin.roles',                         'tab',    'admin.roles',     'Roles',              'Administration', NULL, NULL, 910),
  ('admin.roles:action.view',             'action', 'admin.roles',     'View roles',         NULL, NULL, NULL, 1),
  ('admin.roles:action.add',              'action', 'admin.roles',     'Add role',           NULL, NULL, NULL, 2),
  ('admin.roles:action.edit',             'action', 'admin.roles',     'Edit role',          NULL, NULL, NULL, 3),
  ('admin.roles:action.delete',           'action', 'admin.roles',     'Delete role',        NULL, NULL, NULL, 4),
  ('admin.roles:action.manage_permissions','action','admin.roles',     'Set role permissions', NULL, NULL, NULL, 5),
  ('admin.locations',                     'tab',    'admin.locations', 'Locations',          'Administration', NULL, NULL, 920),
  ('admin.locations:action.view',         'action', 'admin.locations', 'View locations',     NULL, NULL, NULL, 1),
  ('admin.locations:action.add',          'action', 'admin.locations', 'Add location',       NULL, NULL, NULL, 2),
  ('admin.locations:action.edit',         'action', 'admin.locations', 'Rename / edit',      NULL, NULL, NULL, 3),
  ('admin.locations:action.move',         'action', 'admin.locations', 'Move',               NULL, NULL, NULL, 4),
  ('admin.locations:action.deactivate',   'action', 'admin.locations', 'Deactivate / delete', NULL, NULL, NULL, 5),
  ('admin.locations:view.active',         'view',   'admin.locations', 'Active',             NULL, NULL, NULL, 1),
  ('admin.locations:view.inactive',       'view',   'admin.locations', 'Inactive',           NULL, NULL, NULL, 2),
  ('admin.settings',                      'tab',    'admin.settings',  'Settings',           'Administration', NULL, NULL, 930),
  ('admin.settings:action.view',          'action', 'admin.settings',  'View settings',      NULL, NULL, NULL, 1),
  ('admin.settings:action.edit',          'action', 'admin.settings',  'Change settings and labels', NULL, NULL, NULL, 2),
  ('admin.usage',                         'tab',    'admin.usage',     'Usage',              'Administration', NULL, NULL, 940),
  ('admin.usage:action.view',             'action', 'admin.usage',     'View plan usage',    NULL, NULL, NULL, 1),
  -- Configuration (form builder is a plan feature Super Admin grants)
  ('config.forms',                        'tab',    'config.forms',    'Forms',              'Configuration', 'form_builder', NULL, 800),
  ('config.forms:action.view',            'action', 'config.forms',    'View form designs',  NULL, 'form_builder', NULL, 1),
  ('config.forms:action.edit',            'action', 'config.forms',    'Edit form drafts',   NULL, 'form_builder', NULL, 2),
  ('config.forms:action.publish',         'action', 'config.forms',    'Publish forms',      NULL, 'form_builder', NULL, 3),
  ('config.masters',                      'tab',    'config.masters',  'Master designer',    'Configuration', 'form_builder', NULL, 810),
  ('config.masters:action.view',          'action', 'config.masters',  'View master designs', NULL, 'form_builder', NULL, 1),
  ('config.masters:action.add',           'action', 'config.masters',  'Create master',      NULL, 'form_builder', NULL, 2),
  ('config.masters:action.edit',          'action', 'config.masters',  'Edit master settings', NULL, 'form_builder', NULL, 3);
