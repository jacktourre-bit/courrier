-- Retour arrière complet du module (aucune autre table n'est touchée).
-- ATTENTION : supprime l'historique des courriers et preuves ; exporter avant si une obligation de conservation s'applique.
BEGIN;
DROP TABLE IF EXISTS
  postal_human_tasks, postal_webhook_receipts, postal_sensitive_authorizations, postal_budgets, postal_audit_logs,
  postal_outbox, postal_approvals, postal_evidence, postal_events, postal_attachments, postal_dispatches, postal_assets,
  postal_campaign_recipients, postal_campaigns, postal_template_versions, postal_templates, postal_organizations,
  postal_contact_preferences, postal_recipient_addresses, postal_subjects, postal_sender_profiles, postal_provider_connections
CASCADE;
DROP FUNCTION IF EXISTS postal_forbid_mutation();
DROP FUNCTION IF EXISTS postal_scope_ok(uuid, uuid, boolean);
COMMIT;
