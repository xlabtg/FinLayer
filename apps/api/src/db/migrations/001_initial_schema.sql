-- FinLayer Initial Schema Migration
-- Migration: 001_initial_schema
-- Description: Core tables for multi-domain financial OS

BEGIN;

-- ─── Extensions ───────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- For gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- For fuzzy text search

-- ─── Users & Auth ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata    JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL,
    key_hash    VARCHAR(255) NOT NULL UNIQUE,  -- bcrypt hash, NEVER store plain key
    key_prefix  VARCHAR(50)  NOT NULL,         -- e.g. "fl_live" for display
    key_id      VARCHAR(64)  NOT NULL,         -- public unique id embedded in the key, for O(1) lookup (unique index below)
    scopes      TEXT[]       NOT NULL DEFAULT '{}',
    rate_limit  INTEGER      NOT NULL DEFAULT 60,  -- requests per minute
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ  -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id   ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys (key_prefix);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);

-- ─── Providers ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS providers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL UNIQUE,
    domain      VARCHAR(20)  NOT NULL CHECK (domain IN ('swap', 'payments', 'earn')),
    config      JSONB        NOT NULL DEFAULT '{}',
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    priority    INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_providers_domain    ON providers (domain);
CREATE INDEX IF NOT EXISTS idx_providers_is_active ON providers (is_active);

-- ─── Affiliates ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code            VARCHAR(50)  NOT NULL UNIQUE,  -- human-readable e.g. "BOT_42"
    commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.4,
    payout_address  VARCHAR(255),
    total_earned    NUMERIC(36,18) NOT NULL DEFAULT 0,
    total_paid_out  NUMERIC(36,18) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliates_user_id ON affiliates (user_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_code    ON affiliates (code);

CREATE TABLE IF NOT EXISTS affiliate_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id    UUID         NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    target_url      VARCHAR(1000) NOT NULL,
    short_code      VARCHAR(30)  NOT NULL UNIQUE,
    label           VARCHAR(255),
    clicks          INTEGER      NOT NULL DEFAULT 0,
    conversions     INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_affiliate_id ON affiliate_links (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_links_short_code   ON affiliate_links (short_code);

-- ─── Revenue Events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS revenue_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID,        -- FK added below after transactions exists
    source_domain   VARCHAR(20)  NOT NULL CHECK (source_domain IN ('swap', 'payments', 'earn')),
    total_fee       NUMERIC(36,18) NOT NULL,
    fee_asset       VARCHAR(20)  NOT NULL,
    platform_share  NUMERIC(5,4) NOT NULL DEFAULT 0.6,  -- 60%
    affiliate_share NUMERIC(5,4) NOT NULL DEFAULT 0.4,  -- 40%
    affiliate_id    UUID         REFERENCES affiliates(id),
    affiliate_link_id UUID       REFERENCES affiliate_links(id),
    distributed_at  TIMESTAMPTZ,
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_events_pending_affiliate
    ON revenue_events (affiliate_id)
    WHERE distributed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_events_affiliate_link
    ON revenue_events (affiliate_link_id);

-- ─── Unified Transaction Ledger ───────────────────────────────────────────────
-- Critical: Single table enables unified accounting & cross-domain analytics

CREATE TABLE IF NOT EXISTS transactions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type              VARCHAR(20)  NOT NULL CHECK (type IN ('swap', 'payment', 'earn_deposit', 'earn_withdraw')),
    domain            VARCHAR(20)  NOT NULL CHECK (domain IN ('swap', 'payments', 'earn')),
    status            VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded', 'expired')),

    -- Who
    user_id           UUID         NOT NULL REFERENCES users(id),

    -- Asset flow
    from_asset        VARCHAR(20)  NOT NULL,
    to_asset          VARCHAR(20),
    amount            NUMERIC(36,18) NOT NULL,
    result_amount     NUMERIC(36,18),
    fee_amount        NUMERIC(36,18),
    fee_asset         VARCHAR(20),

    -- Provider & routing
    provider_id       UUID         REFERENCES providers(id),
    provider_tx_id    VARCHAR(255),  -- External provider TX ID

    -- Idempotency
    idempotency_key   VARCHAR(128) UNIQUE,

    -- Metadata (domain-specific flexible JSON)
    metadata          JSONB        NOT NULL DEFAULT '{}',

    -- Affiliate & revenue
    affiliate_id      UUID         REFERENCES affiliates(id),
    affiliate_link_id UUID         REFERENCES affiliate_links(id),
    revenue_event_id  UUID,        -- FK to revenue_events (circular, handled below)

    -- Timestamps
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Add circular FKs after both tables exist.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute source_column
          ON source_column.attrelid = c.conrelid
         AND source_column.attnum = ANY (c.conkey)
        JOIN pg_attribute target_column
          ON target_column.attrelid = c.confrelid
         AND target_column.attnum = ANY (c.confkey)
        WHERE c.contype = 'f'
          AND c.conrelid = 'revenue_events'::regclass
          AND c.confrelid = 'transactions'::regclass
          AND source_column.attname = 'transaction_id'
          AND target_column.attname = 'id'
    ) THEN
        ALTER TABLE revenue_events
            ADD CONSTRAINT fk_revenue_events_transaction
            FOREIGN KEY (transaction_id) REFERENCES transactions(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute source_column
          ON source_column.attrelid = c.conrelid
         AND source_column.attnum = ANY (c.conkey)
        JOIN pg_attribute target_column
          ON target_column.attrelid = c.confrelid
         AND target_column.attnum = ANY (c.confkey)
        WHERE c.contype = 'f'
          AND c.conrelid = 'transactions'::regclass
          AND c.confrelid = 'revenue_events'::regclass
          AND source_column.attname = 'revenue_event_id'
          AND target_column.attname = 'id'
    ) THEN
        ALTER TABLE transactions
            ADD CONSTRAINT fk_transactions_revenue_event
            FOREIGN KEY (revenue_event_id) REFERENCES revenue_events(id);
    END IF;
END $$;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_created    ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type_status     ON transactions (type, status);
CREATE INDEX IF NOT EXISTS idx_transactions_provider        ON transactions (provider_id);
CREATE INDEX IF NOT EXISTS idx_transactions_affiliate       ON transactions (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_transactions_affiliate_link  ON transactions (affiliate_link_id);
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_transactions_provider_tx_id  ON transactions (provider_tx_id);

-- ─── Swap-specific metadata: stored in transactions.metadata JSONB ─────────────
-- Earn positions

CREATE TABLE IF NOT EXISTS earn_positions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id),
    provider_id     UUID         NOT NULL REFERENCES providers(id),
    provider_strategy_id VARCHAR(255) NOT NULL,
    provider_position_id VARCHAR(255),
    asset           VARCHAR(20)  NOT NULL,
    network         VARCHAR(50)  NOT NULL,
    deposited_amount NUMERIC(36,18) NOT NULL,
    current_value   NUMERIC(36,18) NOT NULL DEFAULT 0,
    earned_yield    NUMERIC(36,18) NOT NULL DEFAULT 0,
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'withdrawn')),
    deposit_tx_hash VARCHAR(255),
    deposit_transaction_id UUID REFERENCES transactions(id),
    unlocks_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_earn_positions_user_id ON earn_positions (user_id);
CREATE INDEX IF NOT EXISTS idx_earn_positions_status  ON earn_positions (status);

-- ─── Wallet Addresses ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_addresses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID         NOT NULL REFERENCES users(id),
    asset       VARCHAR(20)  NOT NULL,
    network     VARCHAR(50)  NOT NULL,
    address     VARCHAR(255) NOT NULL,
    label       VARCHAR(255),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, asset, network)
);

CREATE INDEX IF NOT EXISTS idx_wallet_addresses_user_id ON wallet_addresses (user_id);

-- ─── Updated-At Trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['providers','affiliates','transactions','earn_positions']
    LOOP
        EXECUTE format('
            CREATE TRIGGER trigger_updated_at_%s
            BEFORE UPDATE ON %s
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        ', t, t);
    END LOOP;
END $$;

-- ─── Seed: Default ChangeNOW Provider ────────────────────────────────────────

INSERT INTO providers (name, domain, config, is_active, priority)
VALUES (
    'ChangeNOW',
    'swap',
    '{"api_url": "https://api.changenow.io/v2", "requires_api_key": true}',
    TRUE,
    100
)
ON CONFLICT (name) DO NOTHING;

COMMIT;
