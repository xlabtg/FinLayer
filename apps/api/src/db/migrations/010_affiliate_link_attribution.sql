-- Migration: 010_affiliate_link_attribution
-- Description: Preserve affiliate link attribution on transactions/revenue events.

BEGIN;

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS affiliate_link_id UUID REFERENCES affiliate_links(id);

ALTER TABLE revenue_events
    ADD COLUMN IF NOT EXISTS affiliate_link_id UUID REFERENCES affiliate_links(id);

CREATE INDEX IF NOT EXISTS idx_transactions_affiliate_link
    ON transactions (affiliate_link_id);

CREATE INDEX IF NOT EXISTS idx_revenue_events_affiliate_link
    ON revenue_events (affiliate_link_id);

COMMIT;
