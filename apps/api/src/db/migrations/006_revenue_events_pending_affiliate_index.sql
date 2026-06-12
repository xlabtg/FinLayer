-- Migration: 006_revenue_events_pending_affiliate_index
-- Description: Add a partial index for pending affiliate revenue event scans.
-- Fixes issue #29.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_revenue_events_pending_affiliate
    ON revenue_events (affiliate_id)
    WHERE distributed_at IS NULL;

COMMIT;
