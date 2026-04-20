-- Migration: 003_earn_providers
-- Description: Seed Aave V3 and Compound V3 earn providers + strategy metadata table

BEGIN;

-- Optional per-provider strategy cache used for listing / APY feed.
-- Adapters may populate this via background sync, or services may query adapters live.
CREATE TABLE IF NOT EXISTS earn_strategies (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id           UUID         NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    provider_strategy_id  VARCHAR(255) NOT NULL,
    asset                 VARCHAR(20)  NOT NULL,
    network               VARCHAR(50)  NOT NULL,
    apy                   NUMERIC(10,6) NOT NULL DEFAULT 0,
    apy_30d               NUMERIC(10,6) NOT NULL DEFAULT 0,
    risk_level            VARCHAR(10)  NOT NULL DEFAULT 'medium'
                          CHECK (risk_level IN ('low', 'medium', 'high')),
    min_deposit           NUMERIC(36,18) NOT NULL DEFAULT 0,
    max_deposit           NUMERIC(36,18),
    lock_period_days      INTEGER      NOT NULL DEFAULT 0,
    protocol              VARCHAR(100) NOT NULL,
    description           TEXT         NOT NULL DEFAULT '',
    is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
    metadata              JSONB        NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (provider_id, provider_strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_earn_strategies_provider ON earn_strategies (provider_id);
CREATE INDEX IF NOT EXISTS idx_earn_strategies_asset    ON earn_strategies (asset);
CREATE INDEX IF NOT EXISTS idx_earn_strategies_active   ON earn_strategies (is_active);

CREATE TRIGGER trigger_updated_at_earn_strategies
BEFORE UPDATE ON earn_strategies
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Seed Aave V3 Provider ───────────────────────────────────────────────────
INSERT INTO providers (name, domain, config, is_active, priority)
VALUES (
    'AaveV3',
    'earn',
    '{"protocol": "Aave V3", "rpc_url_env": "AAVE_RPC_URL", "requires_wallet": true}',
    TRUE,
    90
)
ON CONFLICT (name) DO NOTHING;

-- ─── Seed Compound V3 Provider ───────────────────────────────────────────────
INSERT INTO providers (name, domain, config, is_active, priority)
VALUES (
    'CompoundV3',
    'earn',
    '{"protocol": "Compound V3", "rpc_url_env": "COMPOUND_RPC_URL", "requires_wallet": true}',
    TRUE,
    80
)
ON CONFLICT (name) DO NOTHING;

COMMIT;
