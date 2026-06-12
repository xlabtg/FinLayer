import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { generateUUID } from '@finlayer/utils';

import { createMockSql } from './setup.js';

const phase4MigrationUrl = new URL('../db/migrations/003_wallet_phase4.sql', import.meta.url);
const uniqueMigrationUrl = new URL(
  '../db/migrations/005_affiliate_payout_items_unique_revenue_event.sql',
  import.meta.url
);

function extractCreateTableBody(sql: string, tableName: string): string {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`, 'i')
  );
  expect(match).not.toBeNull();
  return match![1]!.replace(/\s+/g, ' ').trim();
}

describe('affiliate payout item revenue event uniqueness', () => {
  test('fresh schema defines a unique constraint for revenue_event_id', async () => {
    const migration = await readFile(phase4MigrationUrl, 'utf8');
    const tableBody = extractCreateTableBody(migration, 'affiliate_payout_items');

    expect(tableBody).toContain(
      'CONSTRAINT affiliate_payout_items_revenue_event_id_key UNIQUE (revenue_event_id)'
    );
  });

  test('upgrade migration adds the same constraint for already migrated databases', async () => {
    const migration = await readFile(uniqueMigrationUrl, 'utf8');

    expect(migration).toContain('affiliate_payout_items_revenue_event_id_key');
    expect(migration).toMatch(/ALTER TABLE affiliate_payout_items\s+ADD CONSTRAINT/i);
    expect(migration).toMatch(/UNIQUE\s+\(revenue_event_id\)/i);
  });

  test('duplicate revenue_event_id rows are rejected across payouts', async () => {
    const sql = createMockSql();
    const eventId = generateUUID();

    await sql`
      INSERT INTO affiliate_payout_items (payout_id, revenue_event_id, amount)
      VALUES (${generateUUID()}, ${eventId}, ${'1.00'})
    `;

    await expect(sql`
      INSERT INTO affiliate_payout_items (payout_id, revenue_event_id, amount)
      VALUES (${generateUUID()}, ${eventId}, ${'2.00'})
    `).rejects.toThrow('affiliate_payout_items_revenue_event_id_key');
  });
});
