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
  initTable('providers').push({
    id: generateUUID(),
    name: 'MockEarnProvider',
    domain: 'earn',
    config: {},
    is_active: true,
    priority: 100,
  });

  // Seed a payments provider
  initTable('providers').push({
    id: generateUUID(),
    name: 'MockPayments',
    domain: 'payments',
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
          key_id: values[4],
          scopes: values[5],
          rate_limit: values[6],
          created_at: new Date(),
          last_used_at: null,
          expires_at: values[7] ? new Date(values[7] as string) : null,
          revoked_at: null,
        };
        initTable('api_keys').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT * FROM API_KEYS')) {
        const apiKeys = initTable('api_keys');
        // validateApiKey: lookup by the unique key_id.
        if (query.includes('KEY_ID =')) {
          const keyId = values[0];
          return Promise.resolve(
            apiKeys.filter(r => !r['revoked_at'] && r['key_id'] === keyId)
          );
        }
        // getApiKey: lookup by row id.
        if (query.includes('ID =')) {
          const id = values[0];
          return Promise.resolve(
            apiKeys.filter(r => !r['revoked_at'] && r['id'] === id)
          );
        }
        return Promise.resolve(apiKeys.filter(r => !r['revoked_at']));
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

      if (query.startsWith('SELECT') && query.includes('FROM PROVIDERS') && query.includes("DOMAIN = 'EARN'")) {
        // Two variants: list-by-domain, and single provider by id.
        if (query.includes('WHERE ID = ')) {
          const providerId = values[0];
          const rows = initTable('providers').filter(
            (r) => r['id'] === providerId && r['domain'] === 'earn' && r['is_active'] === true
          );
          return Promise.resolve(rows);
        }
        const rows = initTable('providers').filter(
          (r) => r['domain'] === 'earn' && r['is_active'] === true
        );
        return Promise.resolve(rows);
      }

      if (query.startsWith('SELECT') && query.includes('FROM PROVIDERS')) {
        const rows = initTable('providers').filter(r => r['is_active'] === true);
        return Promise.resolve(rows);
      }

      // ─── Earn Positions ─────────────────────────────────────────────────────
      if (query.startsWith('INSERT INTO EARN_POSITIONS')) {
        const row: MockRow = {
          id: values[0],
          user_id: values[1],
          provider_id: values[2],
          provider_strategy_id: values[3],
          provider_position_id: values[4],
          asset: values[5],
          network: values[6],
          deposited_amount: values[7],
          current_value: values[8],
          earned_yield: values[9],
          status: 'pending',
          deposit_tx_hash: null,
          deposit_transaction_id: values[10],
          unlocks_at: values[11] ? new Date(values[11] as string) : null,
          created_at: new Date(values[12] as string),
          updated_at: new Date(values[13] as string),
        };
        initTable('earn_positions').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('UPDATE EARN_POSITIONS') && query.includes("STATUS = 'WITHDRAWN'")) {
        const positionId = values[0];
        const rows = initTable('earn_positions');
        const row = rows.find(r => r['id'] === positionId);
        if (row) {
          row['status'] = 'withdrawn';
          row['updated_at'] = new Date();
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE EARN_POSITIONS')) {
        const currentValue = values[0];
        const earnedYield = values[1];
        const status = values[2];
        const positionId = values[3];
        const rows = initTable('earn_positions');
        const row = rows.find(r => r['id'] === positionId);
        if (row) {
          row['current_value'] = currentValue;
          row['earned_yield'] = earnedYield;
          row['status'] = status;
          row['updated_at'] = new Date();
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM EARN_POSITIONS')) {
        // Two variants: by-id + user, or by user only.
        const providers = initTable('providers');
        if (query.includes('WHERE EP.ID = ')) {
          const positionId = values[0];
          const userId = values[1];
          const rows = initTable('earn_positions').filter(
            (r) => r['id'] === positionId && r['user_id'] === userId
          );
          return Promise.resolve(
            rows.map((r) => {
              const provider = providers.find((p) => p['id'] === r['provider_id']);
              return { ...r, provider_name: provider?.['name'] ?? 'Unknown' };
            })
          );
        }
        const userId = values[0];
        const rows = initTable('earn_positions').filter((r) => r['user_id'] === userId);
        return Promise.resolve(
          rows.map((r) => {
            const provider = providers.find((p) => p['id'] === r['provider_id']);
            return { ...r, provider_name: provider?.['name'] ?? 'Unknown' };
          })
        );
      }

      if (query.startsWith('INSERT INTO TRANSACTIONS')) {
        // Transaction INSERTs have different value layouts for swap vs payment vs earn
        // because `type`/`domain`/`status` may be template literals or bound values.
        const isPayment = query.includes("'PAYMENT'") && query.includes("'PAYMENTS'");
        const isEarn = query.includes("'EARN_DEPOSIT'") || query.includes("'EARN_WITHDRAW'");
        let row: MockRow;
        if (isPayment) {
          // [id, userId, asset, null, amount, fee, asset, providerId, providerTxId, idem, affId, meta, now, now]
          row = {
            id: values[0],
            type: 'payment',
            domain: 'payments',
            status: 'pending',
            user_id: values[1],
            from_asset: values[2],
            to_asset: values[3],
            amount: values[4],
            fee_amount: values[5],
            fee_asset: values[6],
            provider_id: values[7],
            provider_tx_id: values[8],
            idempotency_key: values[9],
            affiliate_id: values[10],
            metadata: typeof values[11] === 'string' ? JSON.parse(values[11] as string) : values[11],
            created_at: new Date(values[12] as string),
            updated_at: new Date(values[13] as string),
            revenue_event_id: null,
            result_amount: null,
          };
        } else if (isEarn) {
          // earn layout: type/domain are SQL literals; [id, status, userId, from, to, amount, providerId, providerTxId, idem, affId, meta, now, now]
          const typeMatch = query.match(/VALUES\s*\(\s*\?\s*,\s*'([A-Z_]+)'\s*,\s*'([A-Z_]+)'/);
          const type = typeMatch ? typeMatch[1]!.toLowerCase() : 'earn_deposit';
          const domain = typeMatch ? typeMatch[2]!.toLowerCase() : 'earn';
          const rawMetadata = values[10];
          row = {
            id: values[0],
            type,
            domain,
            status: values[1],
            user_id: values[2],
            from_asset: values[3],
            to_asset: values[4],
            amount: values[5],
            provider_id: values[6],
            provider_tx_id: values[7],
            idempotency_key: values[8],
            affiliate_id: values[9],
            metadata: typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata,
            created_at: new Date(values[11] as string),
            updated_at: new Date(values[12] as string),
            revenue_event_id: null,
          };
        } else {
          // swap layout: [id, status, userId, from, to, amount, providerId, providerTxId, idem, affId, meta, now, now]
          row = {
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
            metadata: typeof values[10] === 'string' ? JSON.parse(values[10] as string) : values[10],
            created_at: new Date(values[11] as string),
            updated_at: new Date(values[12] as string),
            revenue_event_id: null,
          };
        }
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
        // Two shapes:
        //   swap:    SET status = ?, updated_at = NOW() WHERE id = ?         → [status, txId]
        //   payment: SET status = ?, result_amount = COALESCE(?, …), updated_at = NOW() WHERE id = ? → [status, paidAmount, txId]
        const hasResultAmount = query.includes('RESULT_AMOUNT');
        const status = values[0];
        const resultAmount = hasResultAmount ? values[1] : undefined;
        const txId = hasResultAmount ? values[2] : values[1];
        const rows = initTable('transactions');
        const row = rows.find(r => r['id'] === txId);
        if (row) {
          row['status'] = status;
          if (hasResultAmount && resultAmount !== null && resultAmount !== undefined) {
            row['result_amount'] = resultAmount;
          }
          row['updated_at'] = new Date();
        }
        return Promise.resolve([]);
      }

      // Domain-scoped swap webhook lookup: WHERE t.id = ? AND t.domain = 'swap'
      if (
        query.startsWith('SELECT') &&
        query.includes('FROM TRANSACTIONS') &&
        query.includes("DOMAIN = 'SWAP'")
      ) {
        const txId = values[0];
        const providers = initTable('providers');
        const rows = initTable('transactions').filter(
          r => r['id'] === txId && r['domain'] === 'swap'
        );
        return Promise.resolve(
          rows.map(r => {
            const provider = providers.find(p => p['id'] === r['provider_id']);
            return { ...r, provider_name: provider?.['name'] ?? 'Unknown' };
          })
        );
      }

      if (query.startsWith('SELECT') && query.includes('FROM TRANSACTIONS')) {
        const txId = values[0];
        // Single-arg SELECT (WHERE id = ?) — used for revenue event emission
        if (values.length === 1) {
          const rows = initTable('transactions').filter(r => r['id'] === txId);
          return Promise.resolve(rows);
        }
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

      // ─── Payments ──────────────────────────────────────────────────────────

      if (query.startsWith('INSERT INTO INVOICES')) {
        // `status` is a SQL literal in the service — not a bound value.
        // [id, txId, userId, providerId, providerInvoiceId, asset, amount, network,
        //  paymentAddress, description, callbackUrl, expiresAt, metadata, now, now]
        const row: MockRow = {
          id: values[0],
          transaction_id: values[1],
          user_id: values[2],
          provider_id: values[3],
          provider_invoice_id: values[4],
          asset: values[5],
          amount: values[6],
          network: values[7],
          payment_address: values[8],
          description: values[9],
          callback_url: values[10],
          status: 'pending',
          expires_at: new Date(values[11] as string),
          metadata: typeof values[12] === 'string' ? JSON.parse(values[12] as string) : values[12],
          created_at: new Date(values[13] as string),
          updated_at: new Date(values[14] as string),
          paid_amount: null,
          tx_hash: null,
          paid_at: null,
        };
        initTable('invoices').push(row);
        return Promise.resolve([row]);
      }

      if (query.startsWith('SELECT') && query.includes('FROM INVOICES')) {
        const invoices = initTable('invoices');
        const providers = initTable('providers');
        const transactions = initTable('transactions');

        // By (provider_id, provider_invoice_id)
        if (query.includes('PROVIDER_ID =') && query.includes('PROVIDER_INVOICE_ID =')) {
          const rows = invoices.filter(r =>
            r['provider_id'] === values[0] && r['provider_invoice_id'] === values[1]
          );
          return Promise.resolve(rows);
        }
        // By id + user_id
        if (query.includes('I.ID =') || query.includes('I.USER_ID =')) {
          const rows = invoices
            .filter(r => r['id'] === values[0] && r['user_id'] === values[1])
            .map(r => {
              const provider = providers.find(p => p['id'] === r['provider_id']);
              const tx = transactions.find(t => t['id'] === r['transaction_id']);
              return {
                ...r,
                provider_name: provider?.['name'] ?? 'MockPayments',
                affiliate_id: tx?.['affiliate_id'] ?? null,
                revenue_event_id: tx?.['revenue_event_id'] ?? null,
              };
            });
          return Promise.resolve(rows);
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE INVOICES')) {
        const rows = initTable('invoices');
        // Last value is the id
        const id = values[values.length - 1];
        const row = rows.find(r => r['id'] === id);
        if (row) {
          // status, paid_amount, tx_hash, paid_at
          if (values[0] !== undefined) row['status'] = values[0];
          if (values[1] !== undefined && values[1] !== null) row['paid_amount'] = values[1];
          if (values[2] !== undefined && values[2] !== null) row['tx_hash'] = values[2];
          if (values[3] !== undefined && values[3] !== null) {
            row['paid_at'] = typeof values[3] === 'string' ? new Date(values[3]) : values[3];
          }
          row['updated_at'] = new Date();
        }
        return Promise.resolve([]);
      }

      if (query.startsWith('INSERT INTO PAYMENT_WEBHOOK_EVENTS')) {
        const providerId = values[1];
        const providerEventId = values[2];
        const table = initTable('payment_webhook_events');
        // Idempotency via UNIQUE (provider_id, provider_event_id)
        if (table.some(r => r['provider_id'] === providerId && r['provider_event_id'] === providerEventId)) {
          return Promise.resolve([]);
        }
        const id = values[0] as string;
        const row: MockRow = {
          id,
          provider_id: providerId,
          provider_event_id: providerEventId,
          provider_invoice_id: values[3],
          invoice_id: values[4],
          event_type: values[5],
          signature_valid: values[6],
          payload: values[7],
          processed: values[8] ?? false,
          received_at: new Date(),
          processed_at: null,
          error: null,
        };
        table.push(row);
        // If RETURNING id, the caller expects [{id}]
        if (query.includes('RETURNING ID')) {
          return Promise.resolve([{ id }]);
        }
        return Promise.resolve([row]);
      }

      if (query.startsWith('UPDATE PAYMENT_WEBHOOK_EVENTS')) {
        const id = values[values.length - 1];
        const row = initTable('payment_webhook_events').find(r => r['id'] === id);
        if (row) {
          row['processed'] = true;
          row['processed_at'] = new Date();
          if (query.includes('ERROR =')) row['error'] = values[0];
        }
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
