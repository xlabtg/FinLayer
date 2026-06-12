import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';

const initialSchemaUrl = new URL('../db/migrations/001_initial_schema.sql', import.meta.url);
const pendingAffiliateIndexMigrationUrl = new URL(
  '../db/migrations/008_revenue_events_pending_affiliate_index.sql',
  import.meta.url
);

const expectedIndex =
  /CREATE INDEX IF NOT EXISTS idx_revenue_events_pending_affiliate\s+ON revenue_events\s+\(affiliate_id\)\s+WHERE distributed_at IS NULL/i;

describe('revenue_events pending affiliate index', () => {
  test('fresh schema defines a partial index for pending affiliate revenue events', async () => {
    const migration = await readFile(initialSchemaUrl, 'utf8');

    expect(migration).toMatch(expectedIndex);
  });

  test('upgrade migration adds the same partial index for existing databases', async () => {
    const migration = await readFile(pendingAffiliateIndexMigrationUrl, 'utf8');

    expect(migration).toMatch(expectedIndex);
  });
});
