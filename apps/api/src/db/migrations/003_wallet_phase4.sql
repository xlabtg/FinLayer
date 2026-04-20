-- Migration: 003_wallet_phase4
-- Description: Phase 4 — HD wallet storage, payout batches, and extended wallet fields.
--
-- Security note: Encrypted mnemonics are stored server-side ONLY to enable deterministic
-- address derivation for development and internal key custody. Production deployments
-- should migrate to MPC (Fireblocks / Lit Protocol) or hardware-backed HSMs.

BEGIN;

-- ─── User Wallets (one HD seed per user) ──────────────────────────────────────
--
-- Stores an encrypted BIP39 mnemonic keyed by a server-side ENCRYPTION_KEY.
-- The encryption key MUST be rotated + re-encrypted on compromise.

CREATE TABLE IF NOT EXISTS user_wallets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    encrypted_mnemonic  TEXT         NOT NULL,      -- AES-256-GCM, format: iv:authTag:ciphertext (base64)
    encryption_version  INTEGER      NOT NULL DEFAULT 1,
    derivation_scheme   VARCHAR(20)  NOT NULL DEFAULT 'BIP44',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_wallets_user_id ON user_wallets (user_id);

-- Extend wallet_addresses with BIP44 derivation info and soft-delete
ALTER TABLE wallet_addresses
    ADD COLUMN IF NOT EXISTS derivation_path VARCHAR(100),
    ADD COLUMN IF NOT EXISTS account_index   INTEGER,
    ADD COLUMN IF NOT EXISTS address_index   INTEGER,
    ADD COLUMN IF NOT EXISTS public_key      TEXT;

CREATE INDEX IF NOT EXISTS idx_wallet_addresses_network_address
    ON wallet_addresses (network, address);

-- ─── Affiliate Payout Batches ─────────────────────────────────────────────────
--
-- Each row represents an aggregated payout attempt for a given affiliate at a
-- scheduled interval. Revenue events are linked via affiliate_payout_items.

CREATE TABLE IF NOT EXISTS affiliate_payouts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id    UUID          NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    amount          NUMERIC(36,18) NOT NULL,
    asset           VARCHAR(20)   NOT NULL DEFAULT 'USDC',
    payout_address  VARCHAR(255),
    status          VARCHAR(20)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
    tx_hash         VARCHAR(255),
    event_count     INTEGER       NOT NULL DEFAULT 0,
    scheduled_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    error_message   TEXT,
    metadata        JSONB         NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_affiliate ON affiliate_payouts (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_status    ON affiliate_payouts (status);

-- Link table: which revenue events contributed to which payout.
CREATE TABLE IF NOT EXISTS affiliate_payout_items (
    payout_id        UUID NOT NULL REFERENCES affiliate_payouts(id) ON DELETE CASCADE,
    revenue_event_id UUID NOT NULL REFERENCES revenue_events(id),
    amount           NUMERIC(36,18) NOT NULL,
    PRIMARY KEY (payout_id, revenue_event_id)
);

-- Updated-at trigger for new tables
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['user_wallets','affiliate_payouts']
    LOOP
        EXECUTE format('
            CREATE TRIGGER trigger_updated_at_%s
            BEFORE UPDATE ON %s
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        ', t, t);
    END LOOP;
END $$;

COMMIT;
