-- Migration 001: guard the ledger against concurrent-append races.
-- Run: wrangler d1 execute trivium-ledger --file=migrations/001-ledger-race-guard.sql
--
-- Step 1 removes the dead contact-us-form test task whose chain was broken
-- by the race this migration prevents. Its agents never committed, its fork
-- tokens expired, and the task was abandoned.
-- Step 2 adds the unique index that turns future races into retried
-- constraint errors instead of silently broken chains.

DELETE FROM ledger WHERE task_id = 'e1a7cc75-7fe5-4967-94a2-0d8f9bd3eb8a';
DELETE FROM forks WHERE task_id = 'e1a7cc75-7fe5-4967-94a2-0d8f9bd3eb8a';
DELETE FROM tasks WHERE id = 'e1a7cc75-7fe5-4967-94a2-0d8f9bd3eb8a';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_task_prev ON ledger(task_id, prev_hash);
