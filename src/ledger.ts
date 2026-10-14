import type { D1Database } from "@cloudflare/workers-types";

// Append-only, hash-chained audit ledger.
// Every entry includes the hash of the previous entry for this task.
// If any entry is modified or removed, the chain breaks and verification fails.

export interface LedgerEvent {
  task_id: string;
  event_type: string;
  actor: string;
  details: Record<string, unknown>;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function appendLedger(
  db: D1Database,
  event: LedgerEvent
): Promise<void> {
  // Retry on concurrent appends. Two writers can read the same last hash
  // at the same time; the unique index on (task_id, prev_hash) rejects the
  // loser, so re-read the chain tip and try again instead of writing a
  // row that would silently break the chain.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const now = Math.floor(Date.now() / 1000);

    // Get the hash of the most recent entry for this task.
    // First entry uses a fixed genesis hash.
    const last = await db
      .prepare("SELECT hash FROM ledger WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(event.task_id)
      .first<{ hash: string }>();
    const prevHash = last?.hash ?? "GENESIS";

    const detailsJson = JSON.stringify(event.details);
    const hashInput = [prevHash, event.task_id, event.event_type, event.actor, detailsJson, String(now)].join("|");
    const hash = await sha256Hex(hashInput);

    try {
      await db
        .prepare(
          "INSERT INTO ledger (task_id, event_type, actor, details, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(event.task_id, event.event_type, event.actor, detailsJson, prevHash, hash, now)
        .run();
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTEMPTS && msg.includes("UNIQUE constraint failed")) {
        continue;
      }
      throw e;
    }
  }
}

// Verify the full chain for a task. Returns false on first break.
export async function verifyLedger(db: D1Database, taskId: string): Promise<boolean> {
  const rows = await db
    .prepare("SELECT event_type, actor, details, prev_hash, hash, created_at FROM ledger WHERE task_id = ? ORDER BY seq ASC")
    .bind(taskId)
    .all<{ event_type: string; actor: string; details: string; prev_hash: string; hash: string; created_at: number }>();

  let expectedPrev = "GENESIS";
  for (const row of rows.results) {
    if (row.prev_hash !== expectedPrev) return false;
    const hashInput = [row.prev_hash, taskId, row.event_type, row.actor, row.details, String(row.created_at)].join("|");
    const computed = await sha256Hex(hashInput);
    if (computed !== row.hash) return false;
    expectedPrev = row.hash;
  }
  return true;
}
