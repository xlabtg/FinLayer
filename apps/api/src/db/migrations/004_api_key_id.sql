-- FinLayer Migration: 004_api_key_id
-- Description: Add a unique, indexable `key_id` to api_keys so a key can be
--   located with a single O(1) lookup and verified with exactly one
--   bcrypt.compare. Fixes the `LIMIT 20` prefix-scan that made authentication
--   non-deterministic with >20 active keys and enabled a bcrypt CPU-DoS.
--   See issue #14.
--
-- NOTE: `key_id` is embedded in the plaintext key (`<prefix>_<keyId>_<secret>`),
--   which is never stored, so pre-existing keys cannot be backfilled and must be
--   rotated. The column is therefore nullable (Postgres allows multiple NULLs
--   under a UNIQUE index); all newly created keys always carry a key_id.

BEGIN;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);

COMMIT;
