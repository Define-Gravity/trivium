import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { appendLedger } from "./ledger";
import { decryptKey } from "./keys";
import { MemoryFS } from "./memory-fs";
import git from "isomorphic-git";
import http from "./git-http-client.js";

// Agent runner as a Cloudflare Workflow. Each agent gets its own Workflow
// instance. Steps: load context -> clone + LLM + commit + push -> report.
//
// The LLM API key is decrypted in-memory from D1 (encrypted at rest).
// It is never logged or persisted in plaintext.

interface Env {
  LEDGER_DB: D1Database;
  MERGE_COORDINATOR: DurableObjectNamespace;
  ARTIFACTS: Artifacts;
  KEY_ENCRYPTION_SECRET: string;
}

interface AgentParams {
  taskId: string;
  forkId: string;
  agentId: string;
  strategy: "minimal" | "defensive" | "tested";
  provider: "openai" | "gemini";
}

const STRATEGY_SYSTEM: Record<string, string> = {
  minimal: `You are a pragmatic senior engineer. Write the simplest code that satisfies the task. No over-engineering, no unnecessary abstractions. Clean and direct.`,
  defensive: `You are a security-conscious senior engineer. Write code with input validation, error handling, and safe defaults. Assume inputs cannot be trusted.`,
  tested: `You are a test-driven senior engineer. Write the implementation plus a basic test file that verifies the core behavior. Keep tests simple and runnable with node.`,
};

// Prices per 1M tokens [input, output]
const PRICES: Record<string, [number, number]> = {
  "gpt-4o-mini": [0.15, 0.60],
  "gemini-2.0-flash": [0.10, 0.40],
};

function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

export class AgentRunner extends WorkflowEntrypoint<Env, AgentParams> {
  async run(event: WorkflowEvent<AgentParams>, step: WorkflowStep): Promise<void> {
    const { taskId, forkId, agentId, strategy, provider } = event.payload;
    const db = this.env.LEDGER_DB;

    // Step 1: Load task, fork, constraints, and decrypted API key
    const ctx = await step.do("load-context", async () => {
      const task = await db.prepare(
        "SELECT id, repo, instructions FROM tasks WHERE id = ?"
      ).bind(taskId).first() as { id: string; repo: string; instructions: string } | null;
      if (!task) throw new Error(`task ${taskId} not found`);

      const fork = await db.prepare(
        "SELECT id, repo_name FROM forks WHERE id = ?"
      ).bind(forkId).first() as { id: string; repo_name: string } | null;
      if (!fork) throw new Error(`fork ${forkId} not found`);

      const fk = await db.prepare(
        "SELECT constraints FROM tasks WHERE id = ?"
      ).bind(taskId).first() as { constraints: string } | null;
      let constraints: string[] = [];
      try { constraints = JSON.parse(fk?.constraints ?? "[]"); } catch { constraints = []; }

      const keyRow = await db.prepare(
        "SELECT encrypted_key, iv, spend_usd FROM user_keys WHERE user_id = 'default' AND provider = ?"
      ).bind(provider).first() as { encrypted_key: string; iv: string; spend_usd: number } | null;
      if (!keyRow) throw new Error(`no ${provider} API key configured`);

      const apiKey = await decryptKey(keyRow.encrypted_key, keyRow.iv, this.env.KEY_ENCRYPTION_SECRET);

      const model = provider === "openai" ? "gpt-4o-mini" : "gemini-2.0-flash";

      await appendLedger(db, {
        task_id: taskId,
        event_type: "agent.started",
        actor: agentId,
        details: { forkId, strategy, provider, model },
      });

      return {
        instructions: task.instructions,
        repo: task.repo,
        repoName: fork.repo_name,
        constraints,
        apiKey,
        model,
        spendUsd: keyRow.spend_usd ?? 0,
      };
    });

    // Step 2: Clone, call LLM, write files, commit, push
    const result = await step.do("run-agent", async () => {
      const repo = await this.env.ARTIFACTS.get(ctx.repoName);
      if (!repo) throw new Error(`repo ${ctx.repoName} not found`);
      const { remote } = await repo.info() as { remote: string };
      const tokenResult = await repo.createToken("write", 900);
      const password = tokenSecret(tokenResult.plaintext as string);
      const onAuth = () => ({ username: "x", password });

      const fs = new MemoryFS();
      const dir = "/agent-work";
      const fsArg = fs as unknown as Parameters<typeof git.clone>[0]["fs"];

      await git.clone({
        fs: fsArg, http, dir, url: remote, ref: "main",
        depth: 50, singleBranch: true, onAuth,
      });

      // List files for prompt context
      let files: string[] = [];
      try {
        const entries = await fs.promises.readdir(dir);
        files = entries.filter((e: string) => e !== ".git");
      } catch { files = []; }

      const constraintBlock = ctx.constraints.length > 0
        ? `\nConstraints (you MUST follow these):\n${ctx.constraints.map((c) => `- ${c}`).join("\n")}\n`
        : "";

      const userPrompt =
        `Task: ${ctx.instructions}\n` +
        `\nRepository: ${ctx.repo}` +
        `${constraintBlock}` +
        `\nCurrent files: ${files.length > 0 ? files.join(", ") : "(empty)"}` +
        `\n\nWrite code that completes the task. Respond with JSON:\n` +
        `{"files": {"path/to/file.js": "contents"}, "commit_message": "description"}\n` +
        `\nRules: complete working code, no placeholders, no TODOs.` +
        (ctx.constraints.length > 0 ? `\nConstraints above are hard requirements.` : "");

      // Call LLM
      const system = STRATEGY_SYSTEM[strategy] ?? STRATEGY_SYSTEM.minimal;
      let llmText: string;
      let inputTokens = 0;
      let outputTokens = 0;

      if (provider === "openai") {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify({
            model: ctx.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000,
            temperature: 0.7,
          }),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json() as {
          choices: { message: { content: string } }[];
          usage?: { prompt_tokens: number; completion_tokens: number };
        };
        llmText = data.choices[0].message.content;
        inputTokens = data.usage?.prompt_tokens ?? 0;
        outputTokens = data.usage?.completion_tokens ?? 0;
      } else {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${ctx.model}:generateContent?key=${ctx.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system + "\n\nAlways respond with valid JSON." }] },
              contents: [{ parts: [{ text: userPrompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                maxOutputTokens: 4000,
                temperature: 0.7,
              },
            }),
          }
        );
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json() as {
          candidates: { content: { parts: { text: string }[] } }[];
          usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
        };
        llmText = data.candidates[0].content.parts[0].text;
        inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      }

      const [inPrice, outPrice] = PRICES[ctx.model] ?? [0.15, 0.60];
      const costUsd = (inputTokens / 1e6) * inPrice + (outputTokens / 1e6) * outPrice;

      const cleaned = llmText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(cleaned) as { files: Record<string, string>; commit_message?: string };
      if (!parsed.files || typeof parsed.files !== "object") {
        throw new Error("LLM did not return a files object");
      }

      // Write files to MemoryFS
      for (const [relPath, content] of Object.entries(parsed.files)) {
        const fullPath = `${dir}/${relPath}`;
        const parent = fullPath.split("/").slice(0, -1).join("/");
        try {
          await fs.promises.mkdir(parent, { recursive: true } as unknown as undefined);
        } catch { /* may already exist */ }
        await fs.promises.writeFile(fullPath, content);
      }

      // Commit with trailers
      const msg = parsed.commit_message ?? `${strategy}: complete task`;
      const trailers = [
        `Trivium-Task: ${taskId}`,
        `Trivium-Agent: ${agentId}`,
        `Trivium-Strategy: ${strategy}`,
        ...ctx.constraints.map((c) => `Trivium-Constraint: ${c}`),
      ].join("\n");
      await git.add({ fs: fsArg, dir, filepath: "." });
      const sha = await git.commit({
        fs: fsArg, dir,
        message: `${msg}\n\n${trailers}`,
        author: { name: agentId, email: `${agentId}@trivium.local` },
      });

      await git.push({ fs: fsArg, http, dir, url: remote, onAuth });

      return { commitSha: sha, costUsd, filesWritten: Object.keys(parsed.files).length };
    });

    // Step 3: Report complete, record spend
    await step.do("report", async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.prepare(
        "UPDATE forks SET commit_sha = ?, status = 'completed', completed_at = ? WHERE id = ?"
      ).bind(result.commitSha, now, forkId).run();

      await db.prepare(
        "UPDATE user_keys SET spend_usd = spend_usd + ? WHERE user_id = 'default' AND provider = ?"
      ).bind(result.costUsd, provider).run();

      await appendLedger(db, {
        task_id: taskId,
        event_type: "agent.completed",
        actor: agentId,
        details: {
          forkId, commitSha: result.commitSha,
          filesWritten: result.filesWritten, costUsd: result.costUsd,
        },
      });

      const stub = this.env.MERGE_COORDINATOR.get(
        this.env.MERGE_COORDINATOR.idFromName(taskId)
      );
      await (stub as unknown as {
        submitFork(taskId: string, f: { forkId: string; agentId: string; branch: string; commitSha: string }): Promise<unknown>;
      }).submitFork(taskId, {
        forkId, agentId, branch: "main", commitSha: result.commitSha,
      });
    });
  }
}
