-- P4 : qualification HDS/DPA des autorisations sensibles, justification des pièces,
-- purge de conservation. Réversible (0003_p4_sensitive.down.sql).
BEGIN;
ALTER TABLE postal_sensitive_authorizations
  ADD COLUMN dpa_ref text NOT NULL DEFAULT '',
  ADD COLUMN qualification text NOT NULL DEFAULT 'hds_certified' CHECK (qualification IN ('hds_certified', 'hds_out_of_scope_justified')),
  ADD COLUMN certificate_ref text,
  ADD COLUMN certificate_scope text,
  ADD COLUMN certificate_expires_at timestamptz,
  ADD COLUMN allowed_attachment_categories_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN allowed_recipient_categories_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN revoked_at timestamptz;
ALTER TABLE postal_sensitive_authorizations ALTER COLUMN dpa_ref DROP DEFAULT;
ALTER TABLE postal_sensitive_authorizations ADD CONSTRAINT postal_sensitive_hds_cert CHECK (
  qualification <> 'hds_certified' OR (certificate_ref IS NOT NULL AND certificate_scope IS NOT NULL AND certificate_expires_at IS NOT NULL)
);
-- Toute autorisation antérieure (sans DPA ni certificat) est neutralisée.
UPDATE postal_sensitive_authorizations SET revoked_at = now() WHERE dpa_ref = '';

ALTER TABLE postal_attachments ADD COLUMN justification text, ADD COLUMN added_by text;
ALTER TABLE postal_assets ADD COLUMN purged_at timestamptz;

CREATE TABLE postal_retention_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  asset_kind text NOT NULL,
  retain_days integer NOT NULL CHECK (retain_days > 0),
  legal_basis text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);
ALTER TABLE postal_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE postal_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY postal_retention_policies_scope ON postal_retention_policies
  USING (postal_scope_ok(tenant_id, legal_entity_id, false)) WITH CHECK (postal_scope_ok(tenant_id, legal_entity_id, false));
CREATE INDEX ON postal_assets (legal_entity_id, kind, created_at) WHERE purged_at IS NULL;
COMMIT;
