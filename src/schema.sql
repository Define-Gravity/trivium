-- Trivium ledger schema
-- All timestamps are Unix epoch integers.
-- The ledger table is append-only and hash-chained. Never update or delete rows.

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  instructions TEXT NOT NULL,
  constraints TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  budget_tokens INTEGER NOT NULL,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  agent_count INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS forks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  token_expiry INTEGER NOT NULL,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_forks_task ON forks(task_id);
