-- Module « Courriers & Correspondances » — migration réversible (voir 0001_postal_module.down.sql).
-- Compatible PostgreSQL >= 14 (testée sur 16). Aucune table existante n'est modifiée.
--
-- Isolation : RLS FORCÉE sur toutes les tables, pilotée par les paramètres de
-- session posés par le backend dans chaque transaction :
--   postal.tenant_id, postal.legal_entity_ids (liste CSV), postal.is_system ('on' pour les workers).
-- L'application doit se connecter avec un rôle NON superutilisateur et sans BYPASSRLS.

BEGIN;

CREATE OR REPLACE FUNCTION postal_scope_ok(t uuid, le uuid, nullable_le boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('postal.is_system', true), 'off') = 'on'
      OR (
        t::text = nullif(current_setting('postal.tenant_id', true), '')
        AND (
          (le IS NULL AND nullable_le)
          OR le::text = ANY (string_to_array(nullif(current_setting('postal.legal_entity_ids', true), ''), ','))
        )
      )
$$;

CREATE OR REPLACE FUNCTION postal_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % en ajout seul (journal immuable)', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

-- ------------------------------------------------------------------ Configuration

CREATE TABLE postal_provider_connections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('manuscry', 'servicepostal')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  credentials_secret_ref text NOT NULL CHECK (credentials_secret_ref ~ '^(env|vault):'),
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'error')),
  last_tested_at timestamptz,
  capabilities_json jsonb NOT NULL DEFAULT '{}',
  settings_json jsonb NOT NULL DEFAULT '{}',
  webhook_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, provider, environment)
);

CREATE TABLE postal_sender_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  center_id uuid,
  business_name text NOT NULL,
  postal_address_json jsonb NOT NULL,
  contact text,
  signature_asset_id uuid,
  default_provider text CHECK (default_provider IN ('manuscry', 'servicepostal')),
  envelope_display_name text,
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX ON postal_sender_profiles (legal_entity_id, center_id);

-- Annuaire autonome. Dans une application hôte, remplacer par une vue sur le
-- référentiel patients/contacts (mêmes colonnes) : aucune duplication requise.
CREATE TABLE postal_subjects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  center_id uuid,
  type text NOT NULL CHECK (type IN ('patient', 'contact')),
  civility text,
  first_name text,
  last_name text,
  company text,
  birth_date date,
  birth_md text,
  birth_date_reliable boolean NOT NULL DEFAULT false,
  deceased boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  litigation boolean NOT NULL DEFAULT false,
  has_legal_representative boolean NOT NULL DEFAULT false,
  public_reference text,
  CHECK (birth_md IS NOT DISTINCT FROM to_char(birth_date, 'MM-DD'))
);
CREATE INDEX ON postal_subjects (legal_entity_id, birth_md) WHERE NOT deceased AND NOT archived;

CREATE TABLE postal_recipient_addresses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('patient', 'organization', 'contact')),
  subject_id uuid NOT NULL,
  address_json jsonb NOT NULL,
  verified_at timestamptz,
  verification_source text,
  validity_status text NOT NULL CHECK (validity_status IN ('valid', 'unverified', 'invalid', 'npai')),
  version integer NOT NULL,
  UNIQUE (legal_entity_id, subject_type, subject_id, version)
);

CREATE TABLE postal_contact_preferences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('transactional', 'administrative', 'relationship', 'marketing', 'legal', 'birthday')),
  channel text NOT NULL CHECK (channel = 'postal'),
  allowed boolean NOT NULL,
  legal_basis text,
  evidence_id text,
  source text NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ON postal_contact_preferences (legal_entity_id, subject_type, subject_id, purpose, updated_at DESC);

CREATE TABLE postal_organizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid,
  center_id uuid,
  category text NOT NULL,
  name text NOT NULL,
  branch text,
  service text,
  address_json jsonb NOT NULL,
  channel_policy jsonb NOT NULL,
  verified_at timestamptz,
  source text,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1
);

-- --------------------------------------------------------------------- Modèles

CREATE TABLE postal_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('formal', 'handwritten')),
  provider text NOT NULL CHECK (provider IN ('manuscry', 'servicepostal')),
  purpose text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
  current_version_id uuid
);

CREATE TABLE postal_template_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES postal_templates (id),
  version integer NOT NULL,
  allowed_merge_fields_json jsonb NOT NULL,
  content_json jsonb NOT NULL,
  provider_fields_json jsonb,
  declared_sensitivity text NOT NULL CHECK (declared_sensitivity IN ('public', 'personal_non_health', 'personal_sensitive', 'health')),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
  approvals_json jsonb NOT NULL DEFAULT '[]',
  content_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (template_id, version)
);

-- ------------------------------------------------------------------- Campagnes

CREATE TABLE postal_campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  center_id uuid,
  type text NOT NULL,
  provider text NOT NULL,
  provider_campaign_id text,
  template_version_id uuid NOT NULL REFERENCES postal_template_versions (id),
  purpose text NOT NULL,
  scheduling_rules_json jsonb NOT NULL DEFAULT '{}',
  budget_cents bigint,
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'active', 'paused', 'archived')),
  approved_by text,
  approved_at timestamptz,
  created_by text NOT NULL
);

CREATE TABLE postal_campaign_recipients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES postal_campaigns (id),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  event_key text NOT NULL,
  year integer NOT NULL,
  eligibility_snapshot_json jsonb NOT NULL,
  dispatch_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('queued', 'skipped', 'dispatched')),
  reason text,
  -- Un seul enregistrement par personne + campagne (donc société) + événement + année (§5.2.4).
  UNIQUE (campaign_id, event_key, year, subject_id)
);

-- ---------------------------------------------------------------------- Envois

CREATE TABLE postal_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sensitivity text NOT NULL,
  kind text NOT NULL,
  retention_policy text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL
);

CREATE TABLE postal_dispatches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  center_id uuid,
  source_type text NOT NULL,
  source_id uuid,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('transactional', 'administrative', 'relationship', 'marketing', 'legal')),
  provider text NOT NULL CHECK (provider IN ('manuscry', 'servicepostal')),
  provider_uid text,
  provider_campaign_id text,
  provider_letter_id text,
  provider_lead_id text,
  idempotency_key text NOT NULL,
  event_key text,
  reference text NOT NULL CHECK (char_length(reference) <= 50),
  recipient_snapshot_json jsonb NOT NULL,
  sender_snapshot_json jsonb NOT NULL,
  template_version_id uuid REFERENCES postal_template_versions (id),
  merge_values_json jsonb NOT NULL DEFAULT '{}',
  document_hash text,
  document_asset_id uuid REFERENCES postal_assets (id),
  preview_asset_id uuid REFERENCES postal_assets (id),
  approval_hash text,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public', 'personal_non_health', 'personal_sensitive', 'health')),
  postage_class text NOT NULL CHECK (postage_class IN ('lrar', 'lr', 'ecopli', 'verte', 'vertesuivi', 'performance', 'perfsuivi', 'handwritten')),
  options_json jsonb NOT NULL DEFAULT '{}',
  approval_policy text NOT NULL,
  scheduled_for date,
  status text NOT NULL CHECK (status IN (
    'DRAFT', 'READY_FOR_PREVIEW', 'PREVIEWED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'SUBMITTED', 'IN_PRODUCTION',
    'POSTAL_DEPOSITED', 'IN_TRANSIT', 'DELIVERED', 'REJECTED', 'CANCEL_REQUESTED', 'CANCELLED', 'RETURNED', 'FAILED_VALIDATION',
    'FAILED_PROVIDER', 'INSUFFICIENT_FUNDS', 'UNKNOWN_SUBMISSION_STATUS', 'EVIDENCE_PENDING')),
  status_before_cancel text,
  raw_provider_status text,
  last_synced_at timestamptz,
  quote_ht_cents bigint,
  quote_ttc_cents bigint,
  quote_postage_cents bigint,
  quote_service_cents bigint,
  currency text NOT NULL DEFAULT 'EUR',
  page_count integer,
  approved_at timestamptz,
  approved_by text,
  submitted_at timestamptz,
  delivered_at timestamptz,
  incident text,
  tracking_number text,
  submission_attempted_at timestamptz,
  campaign_id uuid REFERENCES postal_campaigns (id),
  created_by text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX ON postal_dispatches (legal_entity_id, status, scheduled_for);
CREATE INDEX ON postal_dispatches (provider, provider_uid);
CREATE INDEX ON postal_dispatches (provider, reference);
CREATE INDEX ON postal_dispatches (subject_type, subject_id);
-- Garde-fou base de données contre le double envoi d'un même événement (ex. anniversaire 2027).
CREATE UNIQUE INDEX postal_dispatches_event_once ON postal_dispatches (legal_entity_id, subject_type, subject_id, event_key)
  WHERE event_key IS NOT NULL AND status NOT IN ('CANCELLED', 'REJECTED', 'FAILED_VALIDATION', 'FAILED_PROVIDER');

CREATE TABLE postal_attachments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid NOT NULL REFERENCES postal_dispatches (id),
  asset_id uuid NOT NULL REFERENCES postal_assets (id),
  filename text NOT NULL,
  mime_type text NOT NULL,
  checksum_sha256 text NOT NULL,
  sensitivity text NOT NULL,
  category text NOT NULL,
  page_count integer,
  order_index integer NOT NULL
);

CREATE TABLE postal_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid NOT NULL REFERENCES postal_dispatches (id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  raw_status text,
  mapped_status text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload_digest text NOT NULL,
  UNIQUE (provider, provider_event_id, dispatch_id)
);
CREATE INDEX ON postal_events (dispatch_id, occurred_at);

CREATE TABLE postal_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid NOT NULL REFERENCES postal_dispatches (id),
  kind text NOT NULL CHECK (kind IN ('final_document', 'deposit_proof', 'tracking', 'scanned_ar', 'preview')),
  secured_asset_id uuid NOT NULL REFERENCES postal_assets (id),
  sha256 text NOT NULL,
  obtained_at timestamptz NOT NULL,
  source text NOT NULL,
  retention_policy text NOT NULL,
  UNIQUE (dispatch_id, kind)
);

CREATE TABLE postal_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid NOT NULL REFERENCES postal_dispatches (id),
  step text NOT NULL,
  approver_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'reject', 'invalidated')),
  reason text,
  approval_hash text NOT NULL,
  "timestamp" timestamptz NOT NULL
);
CREATE INDEX ON postal_approvals (dispatch_id, approval_hash);

CREATE TABLE postal_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid NOT NULL REFERENCES postal_dispatches (id),
  action text NOT NULL CHECK (action IN ('SUBMIT', 'CANCEL', 'RECONCILE', 'FETCH_EVIDENCE', 'PROVIDER_VALIDATE', 'PROVIDER_BLOCK')),
  payload_json jsonb NOT NULL DEFAULT '{}',
  payload_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'done', 'dead', 'human_task')),
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NOT NULL,
  last_error text,
  locked_until timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX ON postal_outbox (status, next_retry_at);
CREATE INDEX ON postal_outbox (dispatch_id);

CREATE TABLE postal_audit_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid,
  actor_id text,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  "timestamp" timestamptz NOT NULL,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON postal_audit_logs (tenant_id, legal_entity_id, "timestamp" DESC);

CREATE TABLE postal_budgets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  center_id uuid,
  campaign_id uuid REFERENCES postal_campaigns (id),
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  limit_cents bigint NOT NULL CHECK (limit_cents >= 0),
  alert_thresholds double precision[] NOT NULL DEFAULT '{0.5,0.8,1}'
);

CREATE TABLE postal_sensitive_authorizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  provider text NOT NULL,
  template_id uuid NOT NULL REFERENCES postal_templates (id),
  document_ref text NOT NULL,
  validated_by text NOT NULL,
  validated_at timestamptz NOT NULL,
  expires_at timestamptz
);

CREATE TABLE postal_webhook_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid,
  provider text NOT NULL,
  dedup_key text NOT NULL,
  event_type text NOT NULL,
  payload_digest text NOT NULL,
  dispatch_id uuid,
  result text NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (provider, dedup_key)
);

CREATE TABLE postal_human_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  dispatch_id uuid,
  kind text NOT NULL,
  message text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text
);
CREATE INDEX ON postal_human_tasks (legal_entity_id, status);

-- ------------------------------------------------------------ Journaux immuables

CREATE TRIGGER postal_audit_logs_immutable BEFORE UPDATE OR DELETE ON postal_audit_logs FOR EACH ROW EXECUTE FUNCTION postal_forbid_mutation();
CREATE TRIGGER postal_approvals_immutable BEFORE UPDATE OR DELETE ON postal_approvals FOR EACH ROW EXECUTE FUNCTION postal_forbid_mutation();
CREATE TRIGGER postal_events_immutable BEFORE UPDATE OR DELETE ON postal_events FOR EACH ROW EXECUTE FUNCTION postal_forbid_mutation();
CREATE TRIGGER postal_evidence_immutable BEFORE UPDATE OR DELETE ON postal_evidence FOR EACH ROW EXECUTE FUNCTION postal_forbid_mutation();

-- ----------------------------------------------------------------------------- RLS

DO $$
DECLARE
  t text;
  nullable boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'postal_provider_connections', 'postal_sender_profiles', 'postal_subjects', 'postal_recipient_addresses',
    'postal_contact_preferences', 'postal_organizations', 'postal_templates', 'postal_template_versions',
    'postal_campaigns', 'postal_campaign_recipients', 'postal_assets', 'postal_dispatches', 'postal_attachments',
    'postal_events', 'postal_evidence', 'postal_approvals', 'postal_outbox', 'postal_audit_logs', 'postal_budgets',
    'postal_sensitive_authorizations', 'postal_webhook_receipts', 'postal_human_tasks'
  ] LOOP
    nullable := t IN ('postal_audit_logs', 'postal_organizations', 'postal_webhook_receipts');
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (postal_scope_ok(tenant_id, legal_entity_id, %L)) WITH CHECK (postal_scope_ok(tenant_id, legal_entity_id, %L))',
      t || '_scope', t, nullable, nullable);
  END LOOP;
END $$;

COMMIT;
