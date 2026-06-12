import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';

const initialSchemaUrl = new URL('../db/migrations/001_initial_schema.sql', import.meta.url);
const repairMigrationUrl = new URL(
  '../db/migrations/009_revenue_events_transaction_fk.sql',
  import.meta.url
);

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function extractCreateTableBody(sql: string, tableName: string): string {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`, 'i')
  );
  expect(match).not.toBeNull();
  return normalizeSql(match![1]!);
}

function findSqlIndex(sql: string, pattern: RegExp, description: string): number {
  const index = sql.search(pattern);
  expect(index, `${description} not found`).toBeGreaterThanOrEqual(0);
  return index;
}

const revenueEventsTransactionFk =
  /ADD CONSTRAINT fk_revenue_events_transaction[\s\S]*?FOREIGN KEY\s+\(transaction_id\)\s+REFERENCES transactions\(id\)/i;
const transactionsRevenueEventFk =
  /ADD CONSTRAINT fk_transactions_revenue_event[\s\S]*?FOREIGN KEY\s+\(revenue_event_id\)\s+REFERENCES revenue_events\(id\)/i;

describe('revenue_events transaction foreign key', () => {
  test('fresh schema defers the circular FK until transactions exists', async () => {
    const migration = await readFile(initialSchemaUrl, 'utf8');
    const revenueEventsBody = extractCreateTableBody(migration, 'revenue_events');

    expect(revenueEventsBody).toMatch(/transaction_id UUID/);
    expect(revenueEventsBody).not.toMatch(
      /transaction_id\s+UUID\s+REFERENCES\s+transactions\s*\(\s*id\s*\)/i
    );

    const transactionsCreateIndex = findSqlIndex(
      migration,
      /CREATE TABLE IF NOT EXISTS transactions\s*\(/i,
      'transactions table'
    );
    const transactionFkIndex = findSqlIndex(
      migration,
      revenueEventsTransactionFk,
      'revenue_events transaction FK'
    );

    expect(transactionFkIndex).toBeGreaterThan(transactionsCreateIndex);
  });

  test('repair migration adds the same FK only when it is missing', async () => {
    const migration = await readFile(repairMigrationUrl, 'utf8');

    expect(migration).toMatch(/pg_constraint/i);
    expect(migration).toMatch(/source_column\.attname = 'transaction_id'/i);
    expect(migration).toMatch(/source_column\.attname = 'revenue_event_id'/i);
    expect(migration).toMatch(revenueEventsTransactionFk);
    expect(migration).toMatch(transactionsRevenueEventFk);
  });
});
