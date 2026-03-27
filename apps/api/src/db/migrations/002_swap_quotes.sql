-- Migration: 002_swap_quotes
-- Description: Ephemeral swap quote storage for quote → execute flow

BEGIN;

CREATE TABLE IF NOT EXISTS swap_quotes (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id                 UUID        NOT NULL REFERENCES providers(id),
    provider_quote_id           VARCHAR(255) NOT NULL,
    user_id                     UUID        NOT NULL REFERENCES users(id),

    from_asset                  VARCHAR(20) NOT NULL,
    to_asset                    VARCHAR(20) NOT NULL,
    from_amount                 NUMERIC(36,18) NOT NULL,
    to_amount                   NUMERIC(36,18) NOT NULL,
    rate                        NUMERIC(36,18) NOT NULL,
    network_fee                 NUMERIC(36,18) NOT NULL DEFAULT 0,
    fee_asset                   VARCHAR(20),
    platform_fee                NUMERIC(36,18) NOT NULL DEFAULT 0,

    estimated_duration_seconds  INTEGER NOT NULL DEFAULT 600,
    expires_at                  TIMESTAMPTZ NOT NULL,
    min_amount                  NUMERIC(36,18) NOT NULL,
    max_amount                  NUMERIC(36,18) NOT NULL,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swap_quotes_user_id   ON swap_quotes (user_id);
CREATE INDEX IF NOT EXISTS idx_swap_quotes_expires_at ON swap_quotes (expires_at);

-- Auto-delete expired quotes (requires pg_cron in production, handled by application in dev)
COMMENT ON TABLE swap_quotes IS 'Ephemeral quote storage. Quotes expire and should be cleaned up periodically.';

COMMIT;
