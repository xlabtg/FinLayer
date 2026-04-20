-- Migration: 003_payments
-- Description: Payments module — invoices, provider webhook events with idempotency

BEGIN;

-- ─── Invoices ─────────────────────────────────────────────────────────────────
-- Domain-specific invoice record. Each invoice is backed by an entry in
-- `transactions` (type='payment') so the unified ledger and revenue model
-- continue to work unchanged.

CREATE TABLE IF NOT EXISTS invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id      UUID         NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    user_id             UUID         NOT NULL REFERENCES users(id),
    provider_id         UUID         NOT NULL REFERENCES providers(id),
    provider_invoice_id VARCHAR(255) NOT NULL,

    asset               VARCHAR(20)  NOT NULL,
    amount              NUMERIC(36,18) NOT NULL,
    network             VARCHAR(50)  NOT NULL DEFAULT '',
    payment_address     VARCHAR(255) NOT NULL,
    description         TEXT,
    callback_url        VARCHAR(1000),

    status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'expired', 'overpaid', 'underpaid')),
    paid_amount         NUMERIC(36,18),
    tx_hash             VARCHAR(255),

    expires_at          TIMESTAMPTZ  NOT NULL,
    paid_at             TIMESTAMPTZ,

    metadata            JSONB        NOT NULL DEFAULT '{}',

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (provider_id, provider_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id          ON invoices (user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_transaction_id   ON invoices (transaction_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status           ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_expires_at       ON invoices (expires_at);
CREATE INDEX IF NOT EXISTS idx_invoices_provider_invoice ON invoices (provider_id, provider_invoice_id);

-- Updated-at trigger for invoices
CREATE TRIGGER trigger_updated_at_invoices
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Webhook Events (idempotent) ──────────────────────────────────────────────
-- Stores each inbound provider webhook delivery. Uniqueness on
-- (provider_id, provider_event_id) makes replayed webhook deliveries no-ops,
-- which is essential for MoonPay/Transak/NowPayments retry semantics.

CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id        UUID         NOT NULL REFERENCES providers(id),
    provider_event_id  VARCHAR(255) NOT NULL,
    provider_invoice_id VARCHAR(255),
    invoice_id         UUID         REFERENCES invoices(id),

    event_type         VARCHAR(100) NOT NULL,
    signature          VARCHAR(500),
    signature_valid    BOOLEAN      NOT NULL DEFAULT FALSE,
    payload            JSONB        NOT NULL DEFAULT '{}',

    processed          BOOLEAN      NOT NULL DEFAULT FALSE,
    processed_at       TIMESTAMPTZ,
    error              TEXT,

    received_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (provider_id, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_invoice_id ON payment_webhook_events (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_provider   ON payment_webhook_events (provider_id, received_at DESC);

-- ─── Revenue events: extend for payments fees ─────────────────────────────────
-- The existing revenue_events table already supports source_domain='payments'
-- (CHECK constraint covers it). Widen allowed transaction types to include
-- 'payment_refund' for completeness, but keep the single ledger approach.

-- Add payment_refund to transactions.type check (drop-and-recreate is safest)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'transactions_type_check'
    ) THEN
        ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
    END IF;
END $$;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_type_check
    CHECK (type IN ('swap', 'payment', 'payment_refund', 'earn_deposit', 'earn_withdraw'));

-- ─── Seed: Default payment providers ──────────────────────────────────────────

INSERT INTO providers (name, domain, config, is_active, priority)
VALUES
    ('MoonPay', 'payments', '{"api_url": "https://api.moonpay.com", "requires_api_key": true, "supports_fiat_onramp": true}', TRUE, 100),
    ('Transak', 'payments', '{"api_url": "https://api.transak.com", "requires_api_key": true, "supports_fiat_onramp": true}', TRUE, 90),
    ('NowPayments', 'payments', '{"api_url": "https://api.nowpayments.io/v1", "requires_api_key": true, "supports_crypto_invoices": true}', TRUE, 80)
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE invoices IS 'Payment invoices. Backed by a transactions row for unified accounting.';
COMMENT ON TABLE payment_webhook_events IS 'Idempotent inbound provider webhook deliveries.';

COMMIT;
