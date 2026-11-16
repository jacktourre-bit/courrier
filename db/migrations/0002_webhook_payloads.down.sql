BEGIN;
ALTER TABLE postal_webhook_receipts DROP COLUMN IF EXISTS payload_asset_id;
COMMIT;
