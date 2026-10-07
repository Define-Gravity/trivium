import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger, verifyLedger } from "./ledger";
import { checkBudget } from "./governor";

export { MergeCoordinator } from "./coordinator";
export { ReviewGate } from "./review";


// Dispatcher: the entry point. Creates tasks, forks repos, serves the dashboard.
// POST /projects              create a project with persistent repo
// POST /projects/:id/import    import from GitHub URL into project repo
// GET  /projects               list projects
// POST /task                   create a task (body: repo, instructions, budget_tokens, project_id?)
// GET  /tasks                  list tasks
// GET  /tasks/:id              task detail with ledger
// GET  /ledger/:id             verify and return the hash chain
// POST /tasks/:id/merge-real   merge winner into project main (real git merge)

interface Env {
  LEDGER_DB: D1Database;
  MERGE_COORDINATOR: DurableObjectNamespace;
  REVIEW_GATE: Workflow;
  ARTIFACTS: Artifacts;
}

interface TaskRequest {
  repo: string;
  instructions: string;
  constraints?: string[];
  budget_tokens?: number;
  agent_count?: number;
  project_id?: string;
}

interface ProjectRequest {
  name: string;
}

interface ImportRequest {
  github_url: string;
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
      const task = await env.LEDGER_DB.prepare(
        "SELECT constraints FROM tasks WHERE id = ?"
      ).bind(forksMatch[1]).first() as { constraints: string } | null;
      const forks = await env.LEDGER_DB.prepare(
        "SELECT id, agent_id, repo_name, token, token_expiry, status FROM forks WHERE task_id = ?"
      ).bind(forksMatch[1]).all();
      let constraints: string[] = [];
      try {
        constraints = JSON.parse(task?.constraints ?? "[]");
      } catch {
        constraints = [];
      }
      return json({ forks: forks.results, constraints });
    }
    const completeMatch = url.pathname.match(/^\/forks\/([a-zA-Z0-9-]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const body = await request.json() as { commit_sha?: string };
      const fork = await env.LEDGER_DB.prepare(
        "SELECT * FROM forks WHERE id = ?"
      ).bind(completeMatch[1]).first();
      if (!fork) return json({ error: "fork not found" }, 404);

      const commitSha = body.commit_sha ?? "unknown";
      await env.LEDGER_DB.prepare(
        "UPDATE forks SET commit_sha = ?, status = 'completed', completed_at = ? WHERE id = ?"
      ).bind(commitSha, Math.floor(Date.now() / 1000), fork.id).run();

      const stub = env.MERGE_COORDINATOR.get(env.MERGE_COORDINATOR.idFromName(fork.task_id as string));
      const result = await stub.submitFork(fork.task_id as string, {
        forkId: fork.id as string,
        agentId: fork.agent_id as string,
        branch: "main",
        commitSha,
      });
      return json(result);
    }
    const reviewMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9-]+)\/review$/);
    if (request.method === "POST" && reviewMatch) {
      const taskId = reviewMatch[1];
      const forks = await env.LEDGER_DB.prepare(
        "SELECT id, agent_id, repo_name, commit_sha FROM forks WHERE task_id = ? AND status = 'completed'"
      ).bind(taskId).all();

      // Run the review inline. Workflows do not execute in local dev,
      // so the dispatcher performs the same steps directly: fetch the
      // fork content from Artifacts, run the static scanners, tier the
      // risk, then approve, quarantine, or escalate. The ReviewGate
      // Workflow class remains for deployed environments.
      const { runAllScans } = await import("./scanners");
      const { writeReviewNote } = await import("./notes");
      const reviewed: { forkId: string; status: string }[] = [];

      // Write a review note to the agent's commit in the fork repo.
      // Notes are the post-hoc record: verbose, immutable-ish, and readable
      // via git. The dispatcher writes them, agents cannot forge them.
      async function recordNote(
        f: { id: string; agent_id: string; repo_name: string; commit_sha: string | null },
        passed: boolean,
        findings: string[],
        tier: "standard" | "high",
        decision: "approved" | "quarantined" | "awaiting_human"
      ) {
        if (!f.commit_sha || f.commit_sha === "unknown") return;
        try {
          await writeReviewNote(env, f.repo_name, f.commit_sha, {
            task_id: taskId,
            fork_id: f.id,
            agent_id: f.agent_id,
            commit_sha: f.commit_sha,
            passed,
            findings,
            risk_tier: tier,
            decision,
            reviewed_at: Math.floor(Date.now() / 1000),
          });
        } catch (e) {
          // Notes are best-effort. The D1 ledger remains the source of truth
          // for review outcomes; a failed note write must not block the gate.
          console.error(`note write failed for ${f.id}:`, e);
        }
      }

      for (const fork of forks.results) {
        const f = fork as { id: string; agent_id: string; repo_name: string; commit_sha: string | null };

        // Fetch
        const repo = await env.ARTIFACTS.get(f.repo_name);
        if (!repo) throw new Error(`repo ${f.repo_name} not found`);
        const file = await repo.readFile({ ref: "main", path: "hello.js" });
        const content = typeof file === "string" ? file : JSON.stringify(file);
        await appendLedger(env.LEDGER_DB, {
          task_id: taskId,
          event_type: "gate.fetched",
          actor: "review-gate",
          details: { forkId: f.id, repo: f.repo_name, bytes: content.length },
        });

        // Scan
        const scanResult = runAllScans(content);
        await appendLedger(env.LEDGER_DB, {
          task_id: taskId,
          event_type: "gate.scans",
          actor: "review-gate",
          details: { forkId: f.id, passed: scanResult.passed, findings: scanResult.findings },
        });

        if (!scanResult.passed) {
          await env.LEDGER_DB.prepare("UPDATE forks SET status = 'quarantined' WHERE id = ?").bind(f.id).run();
          await appendLedger(env.LEDGER_DB, {
            task_id: taskId,
            event_type: "fork.quarantined",
            actor: "review-gate",
            details: { forkId: f.id, agentId: f.agent_id, reason: scanResult.findings },
          });
          await recordNote(f, false, scanResult.findings, "standard", "quarantined");
          reviewed.push({ forkId: f.id, status: "quarantined" });
          continue;
        }

        // Risk tier
        const highRisk = /(auth|login|password|secret|credential|\.github\/workflows|Dockerfile|terraform|\.tf|crypto|encrypt)/i.test(content);
        const tierName = highRisk ? "high" : "standard";
        await appendLedger(env.LEDGER_DB, {
          task_id: taskId,
          event_type: "gate.tier",
          actor: "review-gate",
          details: { forkId: f.id, tier: tierName },
        });

        if (tierName === "high") {
          await env.LEDGER_DB.prepare("UPDATE forks SET status = 'awaiting_human' WHERE id = ?").bind(f.id).run();
          await appendLedger(env.LEDGER_DB, {
            task_id: taskId,
            event_type: "fork.escalated",
            actor: "review-gate",
            details: { forkId: f.id, agentId: f.agent_id, reason: "high-risk path requires human review" },
          });
          await recordNote(f, true, scanResult.findings, "high", "awaiting_human");
          reviewed.push({ forkId: f.id, status: "awaiting_human" });
          continue;
        }

        // Approve
        await env.LEDGER_DB.prepare("UPDATE forks SET status = 'approved' WHERE id = ?").bind(f.id).run();
        await appendLedger(env.LEDGER_DB, {
          task_id: taskId,
          event_type: "fork.approved",
          actor: "review-gate",
          details: { forkId: f.id, agentId: f.agent_id, branch: "main" },
        });
        await recordNote(f, true, scanResult.findings, tierName, "approved");
        reviewed.push({ forkId: f.id, status: "approved" });
      }

      await appendLedger(env.LEDGER_DB, {
        task_id: taskId,
        event_type: "review.completed",
        actor: "dispatcher",
        details: { reviewed },
      });

      return json({ reviewed });
    }
    const mergeMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9-]+)\/merge$/);
    if (request.method === "POST" && mergeMatch) {
      const taskId = mergeMatch[1];
      const winner = await env.LEDGER_DB.prepare(
        "SELECT id, agent_id, repo_name, commit_sha FROM forks WHERE task_id = ? AND status = 'approved' ORDER BY created_at ASC LIMIT 1"
      ).bind(taskId).first() as { id: string; agent_id: string; repo_name: string; commit_sha: string } | null;

      if (!winner) {
        return json({ error: "no approved forks to merge" }, 409);
      }

      const now = Math.floor(Date.now() / 1000);
      await env.LEDGER_DB.prepare(
        "UPDATE forks SET status = 'merged' WHERE id = ?"
      ).bind(winner.id).run();
      await env.LEDGER_DB.prepare(
        "UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?"
      ).bind(now, taskId).run();

      await appendLedger(env.LEDGER_DB, {
        task_id: taskId,
        event_type: "task.merged",
        actor: "coordinator",
        details: { winner_fork: winner.id, agent: winner.agent_id, repo: winner.repo_name },
      });

      return json({ merged: winner.repo_name, agent: winner.agent_id });
    }
    // Real merge: actually merge winner's branch into project main via git.
    // Used when task has a project_id. Creates a merge commit with decision trailers.
    const mergeRealMatch = url.pathname.match(/^\/tasks\/([a-zA-Z0-9-]+)\/merge-real$/);
    if (request.method === "POST" && mergeRealMatch) {
      return mergeReal(request, env, mergeRealMatch[1]);
    }
    // Project endpoints
    if (request.method === "POST" && url.pathname === "/projects") {
      return createProject(request, env);
    }
    if (request.method === "GET" && url.pathname === "/projects") {
      const projects = await env.LEDGER_DB.prepare(
        "SELECT id, name, repo_name, created_at FROM projects ORDER BY created_at DESC LIMIT 50"
      ).all();
      return json(projects.results);
    }
    const importMatch = url.pathname.match(/^\/projects\/([a-zA-Z0-9-]+)\/import$/);
    if (request.method === "POST" && importMatch) {
      return importProject(request, env, importMatch[1]);
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
  const constraints = Array.isArray(body.constraints)
    ? body.constraints.filter((c) => typeof c === "string" && c.trim().length > 0).slice(0, 20)
    : [];

  await env.LEDGER_DB.prepare(
    "INSERT INTO tasks (id, repo, instructions, constraints, status, budget_tokens, agent_count, project_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)"
  ).bind(taskId, body.repo, body.instructions, JSON.stringify(constraints), budget, agentCount, body.project_id ?? null, now).run();

  await appendLedger(env.LEDGER_DB, {
    task_id: taskId,
    event_type: "task.created",
    actor: "dispatcher",
    details: { repo: body.repo, budget_tokens: budget, agent_count: agentCount, constraints, project_id: body.project_id ?? null },
  });


// Create forks. If project_id is provided, fork from the project's main repo.
// Otherwise, create a throwaway baseline repo (legacy behavior).
const shortId = taskId.slice(0, 8);
let baseline: Awaited<ReturnType<typeof env.ARTIFACTS.get>>;
let baselineName: string;

if (body.project_id) {
  const project = await env.LEDGER_DB.prepare(
    "SELECT repo_name FROM projects WHERE id = ?"
  ).bind(body.project_id).first() as { repo_name: string } | null;
  if (!project) return json({ error: "project not found" }, 404);
  baselineName = project.repo_name;
  baseline = await env.ARTIFACTS.get(baselineName);
  if (!baseline) throw new Error(`project repo ${baselineName} not found`);
} else {
  baselineName = `${body.repo}-baseline-${shortId}`;
  await env.ARTIFACTS.create(baselineName, { setDefaultBranch: "main" });
  baseline = await env.ARTIFACTS.get(baselineName);
  if (!baseline) throw new Error("baseline repo not found after create");
}

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

// Create a persistent project with its own Artifacts repo.
async function createProject(request: Request, env: Env): Promise<Response> {
  let body: ProjectRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return json({ error: "name is required" }, 400);
  }

  const projectId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const repoName = `trivium-project-${projectId.slice(0, 8)}`;

  await env.ARTIFACTS.create(repoName, { setDefaultBranch: "main" });

  await env.LEDGER_DB.prepare(
    "INSERT INTO projects (id, name, repo_name, created_at) VALUES (?, ?, ?, ?)"
  ).bind(projectId, body.name, repoName, now).run();

  return json({ project_id: projectId, name: body.name, repo_name: repoName }, 201);
}

// Import a GitHub repo into the project's Artifacts repo via .import().
async function importProject(request: Request, env: Env, projectId: string): Promise<Response> {
  let body: ImportRequest;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.github_url || typeof body.github_url !== "string") {
    return json({ error: "github_url is required" }, 400);
  }

  const project = await env.LEDGER_DB.prepare(
    "SELECT repo_name FROM projects WHERE id = ?"
  ).bind(projectId).first() as { repo_name: string } | null;
  if (!project) return json({ error: "project not found" }, 404);

  const repo = await env.ARTIFACTS.get(project.repo_name);
  if (!repo) return json({ error: "project repo not found" }, 404);

  // Use the Artifacts .import() API to bootstrap from GitHub.
  // The exact method signature depends on the Artifacts SDK version;
  // this calls it if available.
  const repoAny = repo as unknown as { import?: (url: string) => Promise<unknown> };
  if (typeof repoAny.import === "function") {
    await repoAny.import(body.github_url);
  } else {
    return json({ error: ".import() not available on this Artifacts SDK version" }, 501);
  }

  return json({ project_id: projectId, imported_from: body.github_url });
}

// Real merge: clone project main, merge winner's commit, push merge commit
// with decision trailers. Uses isomorphic-git with MemoryFS in the Worker.
async function mergeReal(request: Request, env: Env, taskId: string): Promise<Response> {
  const task = await env.LEDGER_DB.prepare(
    "SELECT project_id FROM tasks WHERE id = ?"
  ).bind(taskId).first() as { project_id: string | null } | null;
  if (!task) return json({ error: "task not found" }, 404);
  if (!task.project_id) {
    return json({ error: "task has no project_id; use /merge for legacy tasks" }, 400);
  }

  const project = await env.LEDGER_DB.prepare(
    "SELECT repo_name FROM projects WHERE id = ?"
  ).bind(task.project_id).first() as { repo_name: string } | null;
  if (!project) return json({ error: "project not found" }, 404);

  const winner = await env.LEDGER_DB.prepare(
    "SELECT id, agent_id, repo_name, commit_sha FROM forks WHERE task_id = ? AND status = 'approved' ORDER BY created_at ASC LIMIT 1"
  ).bind(taskId).first() as { id: string; agent_id: string; repo_name: string; commit_sha: string } | null;
  if (!winner) return json({ error: "no approved forks to merge" }, 409);
  if (!winner.commit_sha || winner.commit_sha === "unknown") {
    return json({ error: "winner has no commit SHA" }, 409);
  }

  const git = (await import("isomorphic-git")).default;
  const http = (await import("./git-http-client.js")).default;
  const { MemoryFS } = await import("./memory-fs");

  const projectRepo = await env.ARTIFACTS.get(project.repo_name);
  if (!projectRepo) return json({ error: "project repo not found" }, 404);
  const { remote } = await projectRepo.info() as { remote: string };
  const tokenResult = await projectRepo.createToken("write", 300);
  const password = (tokenResult.plaintext as string).split("?expires=")[0];
  const onAuth = () => ({ username: "x", password });

  const fs = new MemoryFS();
  const dir = "/merge-work";
  const fsArg = fs as unknown as Parameters<typeof git.clone>[0]["fs"];

  // Clone project main
  await git.clone({ fs: fsArg, http, dir, url: remote, ref: "main", depth: 50, singleBranch: true, onAuth });

  // Fetch the winner's commit from their fork
  const winnerRepo = await env.ARTIFACTS.get(winner.repo_name);
  if (!winnerRepo) return json({ error: "winner repo not found" }, 404);
  const winnerInfo = await winnerRepo.info() as { remote: string };
  const winnerToken = await winnerRepo.createToken("read", 300);
  const winnerPassword = (winnerToken.plaintext as string).split("?expires=")[0];

  await git.fetch({
    fs: fsArg, http, dir, url: winnerInfo.remote, ref: "main",
    onAuth: () => ({ username: "x", password: winnerPassword }),
  });

  // Merge the winner's commit into main
  const winnerOid = winner.commit_sha;
  await git.merge({
    fs: fsArg, dir, theirs: winnerOid,
    author: { name: "trivium-dispatcher", email: "dispatcher@trivium.local" },
  });

  // Amend the merge commit message with decision trailers
  const sha = await git.resolveRef({ fs: fsArg, dir, ref: "HEAD" });
  const commit = await git.readCommit({ fs: fsArg, dir, oid: sha });
  const trailers = [
    `Trivium-Decision: merge`,
    `Trivium-Task: ${taskId}`,
    `Trivium-Winner: ${winner.agent_id}`,
    `Trivium-Fork: ${winner.id}`,
  ];
  const newMessage = `${commit.commit.message}\n\n${trailers.join("\n")}\n`;
  // Note: isomorphic-git does not support amending; we create the merge
  // commit message via the merge itself. For now, log trailers to D1.
  // A future enhancement can rewrite the commit with trailers.

  await git.push({ fs: fsArg, http, dir, url: remote, onAuth });

  const now = Math.floor(Date.now() / 1000);
  await env.LEDGER_DB.prepare("UPDATE forks SET status = 'merged' WHERE id = ?").bind(winner.id).run();
  await env.LEDGER_DB.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").bind(now, taskId).run();
  await appendLedger(env.LEDGER_DB, {
    task_id: taskId,
    event_type: "task.merged_real",
    actor: "dispatcher",
    details: {
      winner_fork: winner.id, agent: winner.agent_id,
      merge_commit: sha, project: project.repo_name, trailers,
    },
  });

  return json({ merged: true, merge_commit: sha, agent: winner.agent_id, trailers });
}



