-- 0006 Form engine, masters, record references, files.
-- Owner: Form & master engine agent (contract frozen by Architect, Phase 2).

-- A form is any screen rendered from a definition: masters, the user form, and (Phase 4+) transaction headers/lines.
CREATE TABLE app.form_def (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant_id(),
  key                 text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('master', 'system', 'transaction')),
  is_system           boolean NOT NULL DEFAULT false,   -- shipped form; system fields cannot be removed
  current_version_id  uuid,                             -- latest published version; NULL until first publish
  draft               jsonb,                            -- unpublished edits (FormDefinition JSON); NULL = no draft
  draft_updated_at    timestamptz,
  draft_updated_by    uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.form_def');
CREATE TRIGGER form_def_touch BEFORE UPDATE ON app.form_def FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Immutable published versions. Records point at the version they were saved with.
CREATE TABLE app.form_version (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  form_id      uuid NOT NULL REFERENCES app.form_def(id),
  version      int NOT NULL CHECK (version >= 1),
  definition   jsonb NOT NULL,                      -- FormDefinition (packages/schema/src/forms.ts)
  change_note  text,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  UNIQUE (form_id, version)
);
SELECT app.enable_tenant_rls('app.form_version');
REVOKE UPDATE, DELETE ON app.form_version FROM app_user, platform_user;
ALTER TABLE app.form_def ADD CONSTRAINT form_def_current_version_fk FOREIGN KEY (current_version_id) REFERENCES app.form_version(id);

CREATE TABLE app.master_def (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id(),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name        text NOT NULL,                 -- singular, e.g. 'Item Category'
  plural_name text NOT NULL,                 -- e.g. 'Item Categories' (sidebar label)
  description text,
  form_id     uuid NOT NULL REFERENCES app.form_def(id),
  is_system   boolean NOT NULL DEFAULT false, -- engine-required master (item, vendor, uom); cannot be deactivated
  is_active   boolean NOT NULL DEFAULT true,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb, -- MasterSettings: code generation, display template, default sort
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, form_id)
);
SELECT app.enable_tenant_rls('app.master_def');
CREATE TRIGGER master_def_touch BEFORE UPDATE ON app.master_def FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One table for every master's records. code + name are the universal system fields; all other field values
-- (system and custom) live in `data`, keyed by field key, validated against form_version.definition.
-- Lookup values are stored as the referenced record id (uuid string), never the text.
CREATE TABLE app.master_record (
  id              uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id(),
  master_id       uuid NOT NULL REFERENCES app.master_def(id),
  code            citext NOT NULL,
  name            text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_version_id uuid NOT NULL REFERENCES app.form_version(id),
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(code::text, '') || ' ' || coalesce(name, ''))) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  is_deleted      boolean NOT NULL DEFAULT false,
  deleted_reason  text
);
CREATE UNIQUE INDEX master_record_code ON app.master_record (tenant_id, master_id, code) WHERE NOT is_deleted;
CREATE INDEX master_record_list ON app.master_record (tenant_id, master_id, is_active, name, id) WHERE NOT is_deleted;
CREATE INDEX master_record_data ON app.master_record USING gin (data jsonb_path_ops);
CREATE INDEX master_record_search ON app.master_record USING gin (search);
CREATE INDEX master_record_name_trgm_fallback ON app.master_record (tenant_id, master_id, lower(name) text_pattern_ops) WHERE NOT is_deleted;
SELECT app.enable_tenant_rls('app.master_record');
CREATE TRIGGER master_record_touch BEFORE UPDATE ON app.master_record FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Reference index: every lookup value saved anywhere. Used to block deleting referenced records and to
-- answer "where is this used". Maintained by the service in the same transaction as the save.
CREATE TABLE app.record_ref (
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id(),
  from_kind   text NOT NULL,                -- 'master_record' | 'tenant_user' | 'location_node' | (Phase 4) 'document' | 'document_line'
  from_id     uuid NOT NULL,
  from_field  text NOT NULL,                -- field key ('<grid>.<column>' for grid cells)
  to_kind     text NOT NULL,                -- 'master_record' | 'location_node' | 'tenant_user'
  to_id       uuid NOT NULL,
  PRIMARY KEY (tenant_id, from_kind, from_id, from_field, to_id)
);
CREATE INDEX record_ref_to ON app.record_ref (tenant_id, to_kind, to_id);
SELECT app.enable_tenant_rls('app.record_ref');

-- Uploaded files. Bytes live in object storage (S3 in prod, local disk in dev); this is the catalogue.
CREATE TABLE app.file_object (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  storage_key  text NOT NULL UNIQUE,
  filename     text NOT NULL,
  mime         text NOT NULL,                -- sniffed from content, not trusted from the client
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL,
  scan_status  text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'error')),
  width        int,                          -- images
  height       int,
  attached_to  jsonb,                        -- {kind, id, field} once saved on a record; NULL = orphan (GC after 24 h)
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  is_deleted   boolean NOT NULL DEFAULT false
);
CREATE INDEX file_object_orphans ON app.file_object (tenant_id, created_at) WHERE attached_to IS NULL AND NOT is_deleted;
SELECT app.enable_tenant_rls('app.file_object');

GRANT SELECT, INSERT, UPDATE, DELETE ON app.form_def, app.master_def, app.master_record, app.record_ref, app.file_object TO app_user, platform_user;
GRANT SELECT, INSERT ON app.form_version TO app_user, platform_user;

-- Storage meter. limit_catalog 'storage_gb' is configured in GB; the meter row ('lifetime') counts BYTES.
-- Returns allowed + new used bytes + limit bytes (NULL unlimited) + crossed warning threshold.
CREATE OR REPLACE FUNCTION app.consume_storage(p_bytes bigint)
RETURNS TABLE (allowed boolean, used_bytes bigint, limit_bytes bigint, crossed text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
DECLARE
  t uuid := app.current_tenant_id();
  gb bigint;
  lim bigint;
  m platform.usage_meter;
  after bigint;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no tenant context'; END IF;
  gb := platform.effective_limit('storage_gb', t);
  lim := CASE WHEN gb IS NULL THEN NULL ELSE gb * 1073741824 END;
  INSERT INTO platform.usage_meter (tenant_id, limit_key, period) VALUES (t, 'storage_gb', 'lifetime') ON CONFLICT DO NOTHING;
  SELECT * INTO m FROM platform.usage_meter WHERE tenant_id = t AND limit_key = 'storage_gb' AND period = 'lifetime' FOR UPDATE;
  after := greatest(0, m.used + p_bytes);
  IF p_bytes > 0 AND lim IS NOT NULL AND after > lim THEN
    RETURN QUERY SELECT false, m.used::bigint, lim, NULL::text;
    RETURN;
  END IF;
  crossed := NULL;
  IF lim IS NOT NULL AND lim > 0 AND p_bytes > 0 THEN
    IF after >= lim AND NOT m.warned_100 THEN crossed := '100';
    ELSIF after * 100 >= lim * 80 AND NOT m.warned_80 THEN crossed := '80';
    END IF;
  END IF;
  UPDATE platform.usage_meter
     SET used = after, updated_at = now(),
         warned_80 = warned_80 OR crossed IN ('80', '100'),
         warned_100 = warned_100 OR crossed = '100'
   WHERE tenant_id = t AND limit_key = 'storage_gb' AND period = 'lifetime';
  RETURN QUERY SELECT true, after, lim, crossed;
END$$;
REVOKE ALL ON FUNCTION app.consume_storage(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_storage(bigint) TO app_user, platform_user;
