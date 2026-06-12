-- Migration: 007_affiliate_payout_items_unique_revenue_event
-- Description: Ensure each revenue event can be attached to only one payout item.
-- Fixes issue #28.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'affiliate_payout_items_revenue_event_id_key'
          AND conrelid = 'affiliate_payout_items'::regclass
    ) THEN
        ALTER TABLE affiliate_payout_items
            ADD CONSTRAINT affiliate_payout_items_revenue_event_id_key
            UNIQUE (revenue_event_id);
    END IF;
END $$;

COMMIT;
