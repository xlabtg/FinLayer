-- Migration: 009_revenue_events_transaction_fk
-- Description: Ensure circular revenue event and transaction foreign keys exist.
-- Fixes issue #66.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute source_column
          ON source_column.attrelid = c.conrelid
         AND source_column.attnum = ANY (c.conkey)
        JOIN pg_attribute target_column
          ON target_column.attrelid = c.confrelid
         AND target_column.attnum = ANY (c.confkey)
        WHERE c.contype = 'f'
          AND c.conrelid = 'revenue_events'::regclass
          AND c.confrelid = 'transactions'::regclass
          AND source_column.attname = 'transaction_id'
          AND target_column.attname = 'id'
    ) THEN
        ALTER TABLE revenue_events
            ADD CONSTRAINT fk_revenue_events_transaction
            FOREIGN KEY (transaction_id) REFERENCES transactions(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute source_column
          ON source_column.attrelid = c.conrelid
         AND source_column.attnum = ANY (c.conkey)
        JOIN pg_attribute target_column
          ON target_column.attrelid = c.confrelid
         AND target_column.attnum = ANY (c.confkey)
        WHERE c.contype = 'f'
          AND c.conrelid = 'transactions'::regclass
          AND c.confrelid = 'revenue_events'::regclass
          AND source_column.attname = 'revenue_event_id'
          AND target_column.attname = 'id'
    ) THEN
        ALTER TABLE transactions
            ADD CONSTRAINT fk_transactions_revenue_event
            FOREIGN KEY (revenue_event_id) REFERENCES revenue_events(id);
    END IF;
END $$;

COMMIT;
