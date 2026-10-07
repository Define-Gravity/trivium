import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger, verifyLedger } from "./ledger";
import { checkBudget } from "./governor";

export { MergeCoordinator } from "./coordinator";
export { ReviewGate } from "./review";


// Dispatcher: the entry point. Creates tasks, forks repos, serves the dashboard.
// POST /task        create a task (body: repo, instructions, budget_tokens)
// GET  /tasks       list tasks
// GET  /tasks/:id   task detail with ledger
// GET  /ledger/:id  verify and return the hash chain

interface Env {
  LEDGER_DB: D1Database;
  MERGE_COORDINATOR: DurableObjectNamespace;
  REVIEW_GATE: Workflow;
  ARTIFACTS: Artifacts;
}

interface TaskRequest {
  repo: string;
  instructions: string;
  budget_tokens?: number;
  agent_count?: number;
}

const DEFAULT_BUDGET = 100000;
const DEFAULT_AGENTS = 3;
const TOKEN_TTL_SECONDS = 900; // 15 minutes per fork

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/task") {
      return createTask(request, env);
    }
    if (request.method === "GET" && url.pathname === "/tasks") {
      const tasks = await env.LEDGER_DB.prepare(
        "SELECT id, repo, status, budget_tokens, spent_tokens, created_at FROM tasks ORDER BY created_at DESC LIMIT 50"
      ).all();
      return json(tasks.results);
    }
    const taskMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9-]+)$/);
    if (request.method === "GET" && taskMatch) {
      return taskDetail(env, taskMatch[1]);
    }
    const ledgerMatch = url.pathname.match(/^\/ledger\/([a-zA-Z0-9-]+)$/);
    if (request.method === "GET" && ledgerMatch) {
      const valid = await verifyLedger(env.LEDGER_DB, ledgerMatch[1]);
      const rows = await env.LEDGER_DB.prepare(
        "SELECT seq, event_type, actor, details, prev_hash, hash, created_at FROM ledger WHERE task_id = ? ORDER BY seq ASC"
      ).bind(ledgerMatch[1]).all();
      return json({ valid, events: rows.results });
    }
    const forksMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9-]+)\/forks$/);
    if (request.method === "GET" && forksMatch) {
      const forks = await env.LEDGER_DB.prepare(
        "SELECT id, agent_id, repo_name, token, token_expiry, status FROM forks WHERE task_id = ?"
      ).bind(forksMatch[1]).all();
      return json({ forks: forks.results });
    }
    const completeMatch = url.pathname.match(/^\/forks\/([a-zA-Z0-9-]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const body = await request.json() as { commit_sha?: string };
      const fork = await env.LEDGER_DB.prepare(
        "SELECT * FROM forks WHERE id = ?"
      ).bind(completeMatch[1]).first();
      if (!fork) return json({ error: "fork not found" }, 404);

      const stub = env.MERGE_COORDINATOR.get(env.MERGE_COORDINATOR.idFromName(fork.task_id as string));
      const result = await stub.submitFork(fork.task_id as string, {
        forkId: fork.id as string,
        agentId: fork.agent_id as string,
        branch: "main",
        commitSha: body.commit_sha ?? "unknown",
      });
      return json(result);
    }

    return json({ error: "not found" }, 404);
  },
};

async function createTask(request: Request, env: Env): Promise<Response> {
  let body: TaskRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.repo || typeof body.repo !== "string") {
    return json({ error: "repo is required" }, 400);
  }
  if (!body.instructions || typeof body.instructions !== "string") {
    return json({ error: "instructions are required" }, 400);
  }

  const taskId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const budget = body.budget_tokens ?? DEFAULT_BUDGET;
  const agentCount = Math.min(Math.max(body.agent_count ?? DEFAULT_AGENTS, 1), 5);

  await env.LEDGER_DB.prepare(
    "INSERT INTO tasks (id, repo, instructions, status, budget_tokens, agent_count, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)"
  ).bind(taskId, body.repo, body.instructions, budget, agentCount, now).run();

  await appendLedger(env.LEDGER_DB, {
    task_id: taskId,
    event_type: "task.created",
    actor: "dispatcher",
    details: { repo: body.repo, budget_tokens: budget, agent_count: agentCount },
  });


// Create the baseline repo, then fork it once per agent.
// Each fork gets a short-lived repo-scoped write token.
const shortId = taskId.slice(0, 8);
const baselineName = `${body.repo}-baseline-${shortId}`;
await env.ARTIFACTS.create(baselineName, { setDefaultBranch: "main" });
const baseline = await env.ARTIFACTS.get(baselineName);
if (!baseline) throw new Error("baseline repo not found after create");

const now2 = Math.floor(Date.now() / 1000);
for (let i = 0; i < agentCount; i++) {
  const forkId = crypto.randomUUID();
  const agentId = `agent-${i + 1}`;
  const forkName = `${body.repo}-fork-${i + 1}-${shortId}`;
  await baseline.fork(forkName, { defaultBranchOnly: true });
  const forkHandle = await env.ARTIFACTS.get(forkName);
  if (!forkHandle) throw new Error(`fork ${forkName} not found after fork`);
  const token = await forkHandle.createToken("write", TOKEN_TTL_SECONDS);

  await env.LEDGER_DB.prepare(
    "INSERT INTO forks (id, task_id, agent_id, repo_name, token, token_expiry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(forkId, taskId, agentId, forkName, JSON.stringify(token), now2 + TOKEN_TTL_SECONDS, now2).run();

  await appendLedger(env.LEDGER_DB, {
    task_id: taskId,
    event_type: "fork.created",
    actor: "dispatcher",
    details: { forkId, agentId, repo: forkName, token_ttl_seconds: TOKEN_TTL_SECONDS },
  });
}


  await env.LEDGER_DB.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").bind(taskId).run();

  return json({ task_id: taskId, status: "running", forks: agentCount }, 201);
}

async function taskDetail(env: Env, taskId: string): Promise<Response> {
  const task = await env.LEDGER_DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();
  if (!task) return json({ error: "task not found" }, 404);
  const forks = await env.LEDGER_DB.prepare("SELECT * FROM forks WHERE task_id = ?").bind(taskId).all();
  const budget = await checkBudget(env.LEDGER_DB, taskId, 0);
  return json({ task, forks: forks.results, budget });
}

