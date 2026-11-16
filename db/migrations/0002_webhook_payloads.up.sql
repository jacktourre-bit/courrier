-- Conservation chiffrée du contenu brut des webhooks (preuve de notification reçue).
BEGIN;
ALTER TABLE postal_webhook_receipts ADD COLUMN payload_asset_id uuid REFERENCES postal_assets (id);
CREATE INDEX ON postal_webhook_receipts (dispatch_id);
COMMIT;
