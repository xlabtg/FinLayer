/**
 * Test setup — in-memory SQLite-like stub for DB operations.
 * Tests use a mock SQL implementation to avoid needing a real PostgreSQL.
 */

import type { SQL } from 'postgres';
import { addNumericStrings, generateUUID, multiplyNumericStrings } from '@finlayer/utils';

interface MockRow {
  [key: string]: unknown;
}

/**
 * Very simple in-memory "SQL" mock that covers the patterns used in services.
 * For each table, stores rows as an array and supports basic INSERT/SELECT/UPDATE.
 */
export function createMockSql(): SQL & { _tables: Map<string, MockRow[]> } {
  const tables = new Map<string, MockRow[]>();
  const lockedRevenueEventIds = new Set<string>();
  const initTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  // Split a comma-separated clause at the top level only, so commas inside
  // function calls like COALESCE(?, col) don't break parsing.
  const splitTopLevel = (str: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
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
    function (
      this: { _revenueEventLocks?: Set<string> } | void,
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) {
      const transactionLocks = this?._revenueEventLocks;
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

      // ─── Affiliates ────────────────────────────────────────────────────────

      if (query.startsWith('SELECT') && query.includes('FROM AFFILIATES') && query.includes('WHERE ID =')) {
        const affiliateId = values[0];
        const rows = initTable('affiliates').filter(r => r['id'] === affiliateId);
        return Promise.resolve(rows);
      }

      if (query.startsWith('SELECT') && query.includes('FROM AFFILIATES') && query.includes('WHERE USER_ID =')) {
        const userId = values[0];
        const rows = initTable('affiliates').filter(r => r['user_id'] === userId);
        return Promise.resolve(rows);
      }

      if (query.startsWith('INSERT INTO AFFILIATES')) {
        const row: MockRow = {
          id: values[0],
          user_id: values[1],
          code: values[2],
          commission_rate: values[3],
          payout_address: null,
          total_earned: '0',
          total_paid_out: '0',
          created_at: new Date(),
          updated_at: new Date(),
        };
        initTable('affiliates').push(row);
        return Promise.resolve([row]);
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
        // Generic column-aware parser. Bound `${...}` values arrive as `?`
        // placeholders in `query` (and as entries in `values`), while inline
        // SQL literals (e.g. 'swap', 'pending') stay in the query text. This
        // tolerates any column order/subset — including the partial reservation
        // INSERTs and the `ON CONFLICT (idempotency_key) DO NOTHING` clause used
        // by the TOCTOU fix.
        const colMatch = query.match(/INSERT INTO TRANSACTIONS\s*\(([\s\S]*?)\)\s*VALUES/);
        const cols = (colMatch?.[1] ?? '')
          .split(',')
          .map((c) => c.trim().toLowerCase());

        const afterValues = query.slice(query.indexOf('VALUES') + 'VALUES'.length);
        const open = afterValues.indexOf('(');
        const close = afterValues.indexOf(')', open);
        const valTokens = splitTopLevel(afterValues.slice(open + 1, close)).map((t) => t.trim());

        const row: MockRow = {};
        let vi = 0;
        for (let i = 0; i < cols.length; i++) {
          const token = valTokens[i] ?? '?';
          let val: unknown;
          if (token === '?') {
            val = values[vi++];
          } else if (token === 'NULL') {
            val = null;
          } else if (token.startsWith("'")) {
            // Inline string literal — these are only type/domain/status, which
            // are lowercase in the DB (the query has been upper-cased).
            val = token.slice(1, -1).toLowerCase();
          } else {
            val = token;
          }
          row[cols[i]!] = val;
        }

        // Normalise common columns.
        if (typeof row['metadata'] === 'string') {
          row['metadata'] = JSON.parse(row['metadata'] as string);
        }
        for (const dateCol of ['created_at', 'updated_at']) {
          if (typeof row[dateCol] === 'string') row[dateCol] = new Date(row[dateCol] as string);
        }
        // Fill in columns the services read back later but didn't set here.
        for (const def of ['to_asset', 'provider_tx_id', 'revenue_event_id', 'result_amount', 'fee_amount', 'fee_asset', 'affiliate_id']) {
          if (!(def in row)) row[def] = null;
        }

        const txTable = initTable('transactions');
        // ON CONFLICT (idempotency_key) DO NOTHING — a duplicate reservation
        // inserts nothing and returns no rows, exactly like Postgres.
        if (
          query.includes('ON CONFLICT') &&
          row['idempotency_key'] != null &&
          txTable.some((r) => r['idempotency_key'] === row['idempotency_key'])
        ) {
          return Promise.resolve([]);
        }
        txTable.push(row);
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

      if (query.startsWith('DELETE FROM TRANSACTIONS')) {
        // Used to release an idempotency reservation when the provider call
        // fails, so the same key can be retried.
        const id = values[0];
        const rows = initTable('transactions');
        const idx = rows.findIndex((r) => r['id'] === id);
        if (idx >= 0) rows.splice(idx, 1);
        return Promise.resolve([]);
      }

      if (query.startsWith('UPDATE TRANSACTIONS')) {
        // Generic SET parser: handles `col = ?`, `col = NOW()` and
        // `col = COALESCE(?, col)`, in any order. The single WHERE placeholder
        // (`WHERE id = ?`) is the last bound value consumed.
        const setStr = query.slice(query.indexOf(' SET ') + 5, query.indexOf(' WHERE '));
        const assignments = splitTopLevel(setStr);
        const updates: { col: string; coalesce: boolean; value: unknown }[] = [];
        let vi = 0;
        for (const assignment of assignments) {
          const eq = assignment.indexOf('=');
          const col = assignment.slice(0, eq).trim().toLowerCase();
          const expr = assignment.slice(eq + 1).trim();
          if (expr === '?') {
            updates.push({ col, coalesce: false, value: values[vi++] });
          } else if (expr.startsWith('NOW(')) {
            updates.push({ col, coalesce: false, value: new Date() });
          } else if (expr.startsWith('COALESCE')) {
            updates.push({ col, coalesce: true, value: values[vi++] });
          } else if (expr === 'NULL') {
            updates.push({ col, coalesce: false, value: null });
          } else if (expr.startsWith("'")) {
            updates.push({ col, coalesce: false, value: expr.slice(1, -1).toLowerCase() });
          } else {
            updates.push({ col, coalesce: false, value: expr });
          }
        }
        const txId = values[vi];
        const row = initTable('transactions').find((r) => r['id'] === txId);
        if (row) {
          for (const u of updates) {
            if (u.coalesce && (u.value === null || u.value === undefined)) continue;
            if (u.col === 'metadata' && typeof u.value === 'string') {
              row[u.col] = JSON.parse(u.value);
            } else if (
              (u.col === 'created_at' || u.col === 'updated_at') &&
              typeof u.value === 'string'
            ) {
              row[u.col] = new Date(u.value);
            } else {
              row[u.col] = u.value;
            }
          }
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
        const amount = String(values[0] ?? '0');
        const affiliateId = values[1];
        const row = initTable('affiliates').find(r => r['id'] === affiliateId);
        if (row && query.includes('TOTAL_EARNED')) {
          row['total_earned'] = addNumericStrings(String(row['total_earned'] ?? '0'), amount);
          row['updated_at'] = new Date();
        }
        if (row && query.includes('TOTAL_PAID_OUT')) {
          row['total_paid_out'] = addNumericStrings(String(row['total_paid_out'] ?? '0'), amount);
          row['updated_at'] = new Date();
        }
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
            return addNumericStrings(
              acc,
              multiplyNumericStrings(String(e['total_fee']), String(e['affiliate_share']))
            );
          }, '0');
          result.push({
            affiliate_id: aff['id'],
            payout_address: aff['payout_address'],
            total_pending: total,
            event_count: String(pending.length),
          });
        }
        return Promise.resolve(result);
      }

      if (query.startsWith('SELECT ID, TOTAL_FEE, AFFILIATE_SHARE') && query.includes('REVENUE_EVENTS')) {
        const [affiliateId] = values as [string];
        let events = initTable('revenue_events').filter(e =>
          e['affiliate_id'] === affiliateId && !e['distributed_at']
        );
        if (query.includes('FOR UPDATE') && query.includes('SKIP LOCKED')) {
          events = events.filter(e => !lockedRevenueEventIds.has(String(e['id'])));
          for (const event of events) {
            const eventId = String(event['id']);
            lockedRevenueEventIds.add(eventId);
            transactionLocks?.add(eventId);
          }
        }
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

        // Status row lock lookup used by payments state transitions.
        if (query.startsWith('SELECT STATUS FROM INVOICES')) {
          const rows = invoices
            .filter(r => r['id'] === values[0])
            .map(r => ({ status: r['status'] }));
          return Promise.resolve(rows);
        }
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
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            const transactionLocks = new Set<string>();
            const tx = target.bind({ _revenueEventLocks: transactionLocks });
            try {
              return await fn(tx);
            } finally {
              for (const eventId of transactionLocks) {
                lockedRevenueEventIds.delete(eventId);
              }
            }
          };
        }
        if (prop === 'unsafe') {
          return (_sql: string) => Promise.resolve([]);
        }
        if (prop === 'end') {
          return () => Promise.resolve();
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }
  ) as SQL & { _tables: Map<string, MockRow[]> };

  return mockSql;
}

/** Create a test user and return their userId */
export function createTestUserId(): string {
  return generateUUID();
}
