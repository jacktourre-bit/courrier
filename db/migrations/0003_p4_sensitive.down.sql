BEGIN;
DROP TABLE IF EXISTS postal_retention_policies;
ALTER TABLE postal_assets DROP COLUMN IF EXISTS purged_at;
ALTER TABLE postal_attachments DROP COLUMN IF EXISTS justification, DROP COLUMN IF EXISTS added_by;
ALTER TABLE postal_sensitive_authorizations DROP CONSTRAINT IF EXISTS postal_sensitive_hds_cert;
ALTER TABLE postal_sensitive_authorizations
  DROP COLUMN IF EXISTS dpa_ref, DROP COLUMN IF EXISTS qualification, DROP COLUMN IF EXISTS certificate_ref,
  DROP COLUMN IF EXISTS certificate_scope, DROP COLUMN IF EXISTS certificate_expires_at,
  DROP COLUMN IF EXISTS allowed_attachment_categories_json, DROP COLUMN IF EXISTS allowed_recipient_categories_json,
  DROP COLUMN IF EXISTS revoked_at;
COMMIT;
