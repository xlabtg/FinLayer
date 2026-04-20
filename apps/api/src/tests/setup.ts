/**
 * Test setup — in-memory SQLite-like stub for DB operations.
 * Tests use a mock SQL implementation to avoid needing a real PostgreSQL.
 */

import type { SQL } from 'postgres';
import { generateUUID, nowISO } from '@finlayer/utils';

interface MockRow {
  [key: string]: unknown;
}

/**
 * Very simple in-memory "SQL" mock that covers the patterns used in services.
 * For each table, stores rows as an array and supports basic INSERT/SELECT/UPDATE.
 */
export function createMockSql(): SQL & { _tables: Map<string, MockRow[]> } {
  const tables = new Map<string, MockRow[]>();
  const initTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  // Seed providers table
  initTable('providers').push({
    id: generateUUID(),
    name: 'MockProvider',
    domain: 'swap',
    config: {},
    is_active: true,
    priority: 100,
  });

  // Create a simple SQL mock
  const mockSql = new Proxy(
    function (strings: TemplateStringsArray, ...values: unknown[]) {
      // Parse the SQL to determine the operation
      const query = strings.join('?').trim().toUpperCase();

      if (query.startsWith('SELECT 1')) {
        return Promise.resolve([{ '?column?': 1 }]);
      }

      if (query.startsWith('INSERT INTO API_KEYS')) {
        const row: MockRow = {
          id: generateUUID(),
          user_id: values[0],
          name: values[1],
          key_hash: values[2],
          key_prefix: values[3],
          scopes: values[4],
          rate_limit: values[5],
          created_at: new Date(),
          last_used_at: null,
          expires_at: values[6] ? new Date(values[6] as string) : null,
          revoked_at: null,
        };
        initTable('api_keys').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT * FROM API_KEYS')) {
        const rows = initTable('api_keys').filter(r => !r['revoked_at']);
        return Promise.resolve(rows);
      }

      if (query.startsWith('INSERT INTO SWAP_QUOTES')) {
        const row: MockRow = {
          id: values[0],
          provider_id: values[1],
          provider_quote_id: values[2],
          user_id: values[3],
          from_asset: values[4],
          to_asset: values[5],
          from_amount: values[6],
          to_amount: values[7],
          rate: values[8],
          network_fee: values[9],
          fee_asset: values[10],
          platform_fee: values[11],
          estimated_duration_seconds: values[12],
          expires_at: new Date(values[13] as string),
          min_amount: values[14],
          max_amount: values[15],
          created_at: new Date(),
        };
        initTable('swap_quotes').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT') && query.includes('SWAP_QUOTES')) {
        const quoteId = values[0];
        const userId = values[1];
        const rows = initTable('swap_quotes').filter(r =>
          r['id'] === quoteId && r['user_id'] === userId
        );
        if (rows.length > 0) {
          // Join with providers
          const providers = initTable('providers');
          return Promise.resolve(rows.map(r => {
            const provider = providers.find(p => p['id'] === r['provider_id']);
            return { ...r, provider_name: provider?.['name'] ?? 'Unknown' };
          }));
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM PROVIDERS')) {
        const rows = initTable('providers').filter(r => r['is_active'] === true);
        return Promise.resolve(rows);
      }

      if (query.startsWith('INSERT INTO TRANSACTIONS')) {
        // The swap service inlines 'swap', 'swap' as literals for type/domain,
        // so only 13 template values are bound (id, status, user_id, ..., updated_at).
        const parseMaybeJson = (v: unknown) => {
          if (typeof v !== 'string') return v;
          try { return JSON.parse(v); } catch { return v; }
        };
        const row: MockRow = {
          id: values[0],
          type: 'swap',
          domain: 'swap',
          status: values[1],
          user_id: values[2],
          from_asset: values[3],
          to_asset: values[4],
          amount: values[5],
          provider_id: values[6],
          provider_tx_id: values[7],
          idempotency_key: values[8],
          affiliate_id: values[9],
          metadata: parseMaybeJson(values[10]),
          created_at: new Date(values[11] as string),
          updated_at: new Date(values[12] as string),
          revenue_event_id: null,
        };
        initTable('transactions').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM TRANSACTIONS') && query.includes('IDEMPOTENCY_KEY')) {
        const key = values[0];
        const rows = initTable('transactions').filter(r => r['idempotency_key'] === key);
        return Promise.resolve(rows);
      }

      if (query.startsWith('INSERT INTO REVENUE_EVENTS')) {
        const row: MockRow = {
          id: values[0],
          transaction_id: values[1],
          source_domain: values[2],
          total_fee: values[3],
          fee_asset: values[4],
          platform_share: values[5],
          affiliate_share: values[6],
          affiliate_id: values[7],
          distributed_at: null,
          created_at: new Date(),
        };
        initTable('revenue_events').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('UPDATE TRANSACTIONS') && query.includes('REVENUE_EVENT_ID')) {
        const revenueEventId = values[0];
        const txId = values[1];
        const rows = initTable('transactions');
        const row = rows.find(r => r['id'] === txId);
        if (row) row['revenue_event_id'] = revenueEventId;
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE TRANSACTIONS') && query.includes('STATUS')) {
        const status = values[0];
        const txId = values[1];
        const rows = initTable('transactions');
        const row = rows.find(r => r['id'] === txId);
        if (row) {
          row['status'] = status;
          row['updated_at'] = new Date();
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM TRANSACTIONS')) {
        const txId = values[0];
        const userId = values[1];
        const rows = initTable('transactions').filter(r =>
          r['id'] === txId && r['user_id'] === userId
        );
        if (rows.length > 0) {
          const providers = initTable('providers');
          return Promise.resolve(rows.map(r => {
            const provider = providers.find(p => p['id'] === r['provider_id']);
            return { ...r, provider_name: provider?.['name'] ?? 'Unknown' };
          }));
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE API_KEYS')) {
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE AFFILIATES')) {
        return Promise.resolve([]);
      }

      // ─── Wallet tables ─────────────────────────────────────────────────────

      if (query.startsWith('SELECT') && query.includes('FROM USER_WALLETS')) {
        const userId = values[0];
        const rows = initTable('user_wallets').filter(r => r['user_id'] === userId);
        return Promise.resolve(rows);
      }

      if (query.startsWith('INSERT INTO USER_WALLETS')) {
        const row: MockRow = {
          id: values[0],
          user_id: values[1],
          encrypted_mnemonic: values[2],
          encryption_version: values[3],
          derivation_scheme: values[4],
          created_at: new Date(),
          updated_at: new Date(),
        };
        initTable('user_wallets').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM WALLET_ADDRESSES')) {
        const addresses = initTable('wallet_addresses');
        // Detect filter variants used by the service
        if (query.includes('USER_ID') && query.includes('ASSET') && query.includes('NETWORK')) {
          const [userId, asset, network] = values as [string, string, string];
          const rows = addresses.filter(r =>
            r['user_id'] === userId && r['asset'] === asset && r['network'] === network
          );
          return Promise.resolve(rows);
        }
        if (/\bID\s*=/.test(query) && query.includes('USER_ID')) {
          const [id, userId] = values as [string, string];
          const rows = addresses.filter(r => r['id'] === id && r['user_id'] === userId);
          return Promise.resolve(rows);
        }
        if (query.includes('USER_ID')) {
          const [userId] = values as [string];
          const rows = addresses.filter(r => r['user_id'] === userId);
          return Promise.resolve(rows);
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('INSERT INTO WALLET_ADDRESSES')) {
        const row: MockRow = {
          id: values[0],
          user_id: values[1],
          asset: values[2],
          network: values[3],
          address: values[4],
          label: values[5],
          derivation_path: values[6],
          account_index: values[7],
          address_index: values[8],
          public_key: values[9],
          created_at: new Date(),
        };
        initTable('wallet_addresses').push(row);
        return Promise.resolve([row]);
      }

      // ─── Affiliate payout scheduler tables ─────────────────────────────────

      if (query.includes('FROM AFFILIATES A') && query.includes('JOIN REVENUE_EVENTS')) {
        // Aggregated eligibility scan — group undistributed events per affiliate.
        const affiliates = initTable('affiliates');
        const events = initTable('revenue_events');
        const result: MockRow[] = [];
        for (const aff of affiliates) {
          if (!aff['payout_address']) continue;
          const pending = events.filter(e =>
            e['affiliate_id'] === aff['id'] && !e['distributed_at']
          );
          if (pending.length === 0) continue;
          const total = pending.reduce((acc, e) => {
            return acc + (parseFloat(String(e['total_fee'])) * parseFloat(String(e['affiliate_share'])));
          }, 0);
          result.push({
            affiliate_id: aff['id'],
            payout_address: aff['payout_address'],
            total_pending: total.toFixed(8),
            event_count: String(pending.length),
          });
        }
        return Promise.resolve(result);
      }

      if (query.startsWith('SELECT ID, TOTAL_FEE, AFFILIATE_SHARE') && query.includes('REVENUE_EVENTS')) {
        const [affiliateId] = values as [string];
        const events = initTable('revenue_events').filter(e =>
          e['affiliate_id'] === affiliateId && !e['distributed_at']
        );
        return Promise.resolve(events.map(e => ({
          id: e['id'],
          total_fee: e['total_fee'],
          affiliate_share: e['affiliate_share'],
        })));
      }

      if (query.startsWith('INSERT INTO AFFILIATE_PAYOUTS')) {
        const row: MockRow = {
          id: values[0],
          affiliate_id: values[1],
          amount: values[2],
          asset: values[3],
          payout_address: values[4],
          status: 'pending',
          event_count: values[5],
          scheduled_at: new Date(),
          processed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        initTable('affiliate_payouts').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('INSERT INTO AFFILIATE_PAYOUT_ITEMS')) {
        const row: MockRow = {
          payout_id: values[0],
          revenue_event_id: values[1],
          amount: values[2],
        };
        initTable('affiliate_payout_items').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('UPDATE REVENUE_EVENTS') && query.includes('DISTRIBUTED_AT')) {
        const [eventId] = values as [string];
        const row = initTable('revenue_events').find(r => r['id'] === eventId);
        if (row) row['distributed_at'] = new Date();
        return Promise.resolve([]);
      }

      // Default: return empty
      return Promise.resolve([]);
    },
    {
      get(target, prop) {
        if (prop === '_tables') return tables;
        if (prop === 'begin') {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(target);
        }
        if (prop === 'unsafe') {
          return (_sql: string) => Promise.resolve([]);
        }
        if (prop === 'end') {
          return () => Promise.resolve();
        }
        return (target as Record<string, unknown>)[prop as string];
      },
    }
  ) as SQL & { _tables: Map<string, MockRow[]> };

  return mockSql;
}

/** Create a test user and return their userId */
export function createTestUserId(): string {
  return generateUUID();
}
