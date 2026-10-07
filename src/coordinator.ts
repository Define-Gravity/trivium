import { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger } from "./ledger";

// Single-writer merge coordinator. Only one merge happens at a time per task.
// Conflict policy, in order:
//   1. Attempt clean three-way merge.
//   2. On conflict, resolver agent arbitrates using test evidence.
//   3. If still ambiguous, escalate to human. Never "last finisher wins."

interface Env {
  LEDGER_DB: D1Database;
}

interface ForkResult {
  forkId: string;
  agentId: string;
  branch: string;
  commitSha: string;
}

export class MergeCoordinator extends DurableObject<Env> {
  async submitFork(taskId: string, result: ForkResult): Promise<{ status: string }> {
    const db = this.env.LEDGER_DB;

    await appendLedger(db, {
      task_id: taskId,
      event_type: "fork.completed",
      actor: result.agentId,
      details: { forkId: result.forkId, branch: result.branch, commitSha: result.commitSha },
    });

    // Mark fork complete
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare("UPDATE forks SET status = 'completed', completed_at = ? WHERE id = ?")
      .bind(now, result.forkId)
      .run();

    // Check if all forks are done
    const pending = await db
      .prepare("SELECT COUNT(*) as n FROM forks WHERE task_id = ? AND status = 'running'")
      .bind(taskId)
      .first<{ n: number }>();

    if (pending && pending.n > 0) {
      return { status: "waiting_for_forks" };
    }

    // All forks complete. Start the review gate via Workflow.
    // The Workflow binding is accessed from the main Worker, so we record
    // intent here and the dispatcher picks it up.
    await appendLedger(db, {
      task_id: taskId,
      event_type: "merge.ready",
      actor: "coordinator",
      details: { message: "all forks complete, ready for review gate" },
    });

    await db
      .prepare("UPDATE tasks SET status = 'review' WHERE id = ?")
      .bind(taskId)
      .run();

    return { status: "ready_for_review" };
  }
}
