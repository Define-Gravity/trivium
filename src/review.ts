import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger } from "./ledger";
import { runAllScans } from "./scanners";

// Review gate. Runs in strict order. Any step can quarantine the fork.
// Steps: fetch -> scans -> risk tier -> approve, quarantine, or escalate.

interface Env {
  LEDGER_DB: D1Database;
  ARTIFACTS: Artifacts;
}

interface ReviewParams {
  taskId: string;
  forkId: string;
  agentId: string;
  repoName: string;
  branch: string;
}

export class ReviewGate extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep): Promise<void> {
    const { taskId, forkId, agentId, repoName, branch } = event.payload;
    const db = this.env.LEDGER_DB;

    // Step 1: fetch the fork's content from Artifacts
    const content = await step.do("fetch-content", async () => {
      const repo = await this.env.ARTIFACTS.get(repoName);
      if (!repo) throw new Error(`repo ${repoName} not found`);
      // For the demo we know agents write hello.js. A real
      // implementation would list files and diff against baseline.
      const file = await repo.readFile({ ref: "main", path: "hello.js" });
      const text = typeof file === "string" ? file : JSON.stringify(file);
      await appendLedger(db, {
        task_id: taskId,
        event_type: "gate.fetched",
        actor: "review-gate",
        details: { forkId, repo: repoName, bytes: text.length },
      });
      return text;
    });

    // Step 2: static scans (secrets, injection, dependencies)
    const scanResult = await step.do("static-scans", async () => {
      const result = runAllScans(content);
      await appendLedger(db, {
        task_id: taskId,
        event_type: "gate.scans",
        actor: "review-gate",
        details: { forkId, passed: result.passed, findings: result.findings },
      });
      return result;
    });

    if (!scanResult.passed) {
      await step.do("quarantine", async () => {
        await db.prepare("UPDATE forks SET status = 'quarantined' WHERE id = ?").bind(forkId).run();
        await appendLedger(db, {
          task_id: taskId,
          event_type: "fork.quarantined",
          actor: "review-gate",
          details: { forkId, agentId, reason: scanResult.findings },
        });
      });
      return;
    }

    // Step 3: risk tiering. High-risk paths require a human.
    const tier = await step.do("risk-tier", async () => {
      const highRisk = /(auth|login|password|secret|credential|\.github\/workflows|Dockerfile|terraform|\.tf|crypto|encrypt)/i.test(content);
      const tierName = highRisk ? "high" : "standard";
      await appendLedger(db, {
        task_id: taskId,
        event_type: "gate.tier",
        actor: "review-gate",
        details: { forkId, tier: tierName },
      });
      return tierName;
    });

    if (tier === "high") {
      await step.do("escalate", async () => {
        await db.prepare("UPDATE forks SET status = 'awaiting_human' WHERE id = ?").bind(forkId).run();
        await appendLedger(db, {
          task_id: taskId,
          event_type: "fork.escalated",
          actor: "review-gate",
          details: { forkId, agentId, reason: "high-risk path requires human review" },
        });
      });
      return;
    }

    // Step 4: standard tier passes. Mark approved for merge.
    await step.do("approve", async () => {
      await db.prepare("UPDATE forks SET status = 'approved' WHERE id = ?").bind(forkId).run();
      await appendLedger(db, {
        task_id: taskId,
        event_type: "fork.approved",
        actor: "review-gate",
        details: { forkId, agentId, branch },
      });
    });
  }
}
