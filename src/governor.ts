import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger } from "./ledger";

// Cost governor. Tracks token spend per task in real time.
// Kills the run when the budget ceiling is hit. No exceptions.

export interface BudgetCheck {
  allowed: boolean;
  spent: number;
  budget: number;
}

export async function checkBudget(
  db: D1Database,
  taskId: string,
  additionalTokens: number
): Promise<BudgetCheck> {
  const task = await db
    .prepare("SELECT budget_tokens, spent_tokens, status FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ budget_tokens: number; spent_tokens: number; status: string }>();

  if (!task) return { allowed: false, spent: 0, budget: 0 };
  if (task.status === "killed") return { allowed: false, spent: task.spent_tokens, budget: task.budget_tokens };

  const projected = task.spent_tokens + additionalTokens;
  if (projected > task.budget_tokens) {
    await killTask(db, taskId, `budget ceiling hit: ${projected} > ${task.budget_tokens} tokens`);
    return { allowed: false, spent: task.spent_tokens, budget: task.budget_tokens };
  }
  return { allowed: true, spent: task.spent_tokens, budget: task.budget_tokens };
}

export async function recordSpend(
  db: D1Database,
  taskId: string,
  tokens: number
): Promise<void> {
  await db
    .prepare("UPDATE tasks SET spent_tokens = spent_tokens + ? WHERE id = ?")
    .bind(tokens, taskId)
    .run();
}

export async function killTask(
  db: D1Database,
  taskId: string,
  reason: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE tasks SET status = 'killed', completed_at = ? WHERE id = ?")
    .bind(now, taskId)
    .run();
  await db
    .prepare("UPDATE forks SET status = 'killed' WHERE task_id = ? AND status = 'running'")
    .bind(taskId)
    .run();
  await appendLedger(db, {
    task_id: taskId,
    event_type: "task.killed",
    actor: "governor",
    details: { reason },
  });
}
