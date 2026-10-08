// agent-runner.mjs
// LLM-backed agents for Trivium. Each agent clones its fork,
// sends the task + constraints + repo context to an LLM, writes the
// returned files, commits with Trivium trailers, pushes, and reports.
//
// Usage:
//   LLM_PROVIDER=openai OPENAI_API_KEY=sk-... node agent-runner.mjs <task-id>
//   LLM_PROVIDER=gemini GEMINI_API_KEY=... node agent-runner.mjs <task-id>
//
// Env:
//   TRIVIUM_API           Base URL of the Trivium dispatcher (default: https://trivium.abnel.workers.dev)
//   ARTIFACTS_ACCOUNT_ID  Cloudflare account ID (required for git clone/push)
//   LLM_PROVIDER          "openai" or "gemini" (required)
//   OPENAI_API_KEY        Required if LLM_PROVIDER=openai
//   GEMINI_API_KEY        Required if LLM_PROVIDER=gemini
//   LLM_MODEL             Override the default model per provider
//   TRIVIUM_MAX_SPEND_USD Optional budget cap in USD (e.g. "10"). Runner stops
//                         before exceeding it. Spend tracked in ~/.trivium-spend.json.

import { execSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const API = process.env.TRIVIUM_API ?? "https://trivium.abnel.workers.dev";
const ACCOUNT_ID = process.env.ARTIFACTS_ACCOUNT_ID;
const PROVIDER = process.env.LLM_PROVIDER;
const TASK_ID = process.argv[2];
const MAX_SPEND = parseFloat(process.env.TRIVIUM_MAX_SPEND_USD ?? "0") || 0;

if (!ACCOUNT_ID) {
  console.error("Set ARTIFACTS_ACCOUNT_ID first.");
  process.exit(1);
}
if (!TASK_ID) {
  console.error("Usage: node agent-runner.mjs <task-id>");
  process.exit(1);
}
if (PROVIDER !== "openai" && PROVIDER !== "gemini") {
  console.error("Set LLM_PROVIDER to 'openai' or 'gemini'.");
  process.exit(1);
}

// --- Budget tracking ---
// Prices per 1M tokens (input, output). Update as providers change pricing.
const PRICES = {
  openai: {
    "gpt-4o-mini": [0.15, 0.60],
    "gpt-4o": [2.50, 10.00],
    "default": [0.15, 0.60],
  },
  gemini: {
    "gemini-2.0-flash": [0.10, 0.40],
    "gemini-1.5-pro": [1.25, 5.00],
    "default": [0.10, 0.40],
  },
};

const SPEND_FILE = join(homedir(), ".trivium-spend.json");

function loadSpend() {
  try {
    if (existsSync(SPEND_FILE)) {
      return JSON.parse(readFileSync(SPEND_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return { total_usd: 0, calls: 0 };
}

function saveSpend(s) {
  try {
    writeFileSync(SPEND_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("Warning: could not save spend file:", e.message);
  }
}

function modelPrices() {
  const model = process.env.LLM_MODEL ?? (PROVIDER === "openai" ? "gpt-4o-mini" : "gemini-2.0-flash");
  const table = PRICES[PROVIDER] ?? PRICES.openai;
  return table[model] ?? table["default"];
}

function estimateCost(inputTokens, outputTokens) {
  const [inPrice, outPrice] = modelPrices();
  return (inputTokens / 1e6) * inPrice + (outputTokens / 1e6) * outPrice;
}

function checkBudget(estimatedCost) {
  if (MAX_SPEND <= 0) return true; // no cap set
  const spend = loadSpend();
  if (spend.total_usd + estimatedCost > MAX_SPEND) {
    console.error(
      `\nBUDGET EXCEEDED: spent $${spend.total_usd.toFixed(4)} + estimated $${estimatedCost.toFixed(4)} ` +
      `would exceed cap of $${MAX_SPEND.toFixed(2)}. Stopping.`
    );
    return false;
  }
  return true;
}

function recordSpend(cost) {
  const spend = loadSpend();
  spend.total_usd += cost;
  spend.calls += 1;
  saveSpend(spend);
  console.log(`  [spend] this call: $${cost.toFixed(4)}, total: $${spend.total_usd.toFixed(4)}` +
    (MAX_SPEND > 0 ? ` / $${MAX_SPEND.toFixed(2)} cap` : ""));
}

// --- Agent strategies ---

const STRATEGIES = [
  {
    agent: "agent-1",
    name: "minimal",
    system: `You are a pragmatic senior engineer. Write the simplest code that satisfies the task. No over-engineering, no unnecessary abstractions. Clean and direct.`,
  },
  {
    agent: "agent-2",
    name: "defensive",
    system: `You are a security-conscious senior engineer. Write code with input validation, error handling, and safe defaults. Assume inputs cannot be trusted.`,
  },
  {
    agent: "agent-3",
    name: "tested",
    system: `You are a test-driven senior engineer. Write the implementation plus a basic test file that verifies the core behavior. Keep tests simple and runnable with node.`,
  },
];

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- LLM clients (return { text, inputTokens, outputTokens }) ---

async function callOpenAI(system, user) {
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    text: data.choices[0].message.content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function callGemini(system, user) {
  const model = process.env.LLM_MODEL ?? "gemini-2.0-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system + "\n\nAlways respond with valid JSON." }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 4000,
          temperature: 0.7,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    text: data.candidates[0].content.parts[0].text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callLLM(system, user) {
  // Pre-check budget with a rough estimate (4k in + 4k out worst case)
  const [inPrice, outPrice] = modelPrices();
  const worstCase = (4000 / 1e6) * inPrice + (4000 / 1e6) * outPrice;
  if (!checkBudget(worstCase)) {
    throw new Error("BUDGET_EXCEEDED");
  }

  const { text, inputTokens, outputTokens } =
    PROVIDER === "openai" ? await callOpenAI(system, user) : await callGemini(system, user);

  const cost = estimateCost(inputTokens, outputTokens);
  recordSpend(cost);

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

// --- Repo helpers ---

function listRepoFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...listRepoFiles(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// --- Main agent flow ---

async function runAgent(task, fork, strategy, constraints, taskId) {
  const { agent } = strategy;
  console.log(`\n[${agent}] starting (${strategy.name} strategy, ${PROVIDER})`);

  const workDir = join(tmpdir(), `trivium-${agent}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const remote = `https://${ACCOUNT_ID}@artifacts.gitcloudflarestorage.com/${fork.repo}`;
  console.log(`[${agent}] cloning ${fork.repo}`);
  execSync(`git clone ${remote} repo`, { cwd: workDir, stdio: "pipe" });
  const repoDir = join(workDir, "repo");

  const files = listRepoFiles(repoDir);

  console.log(`[${agent}] asking ${PROVIDER}...`);
  const fileContents = files
    .filter((f) => !f.match(/\.(png|jpg|ico|woff2?)$/i))
    .slice(0, 20)
    .map((f) => {
      try {
        const content = readFileSync(join(repoDir, f), "utf-8").slice(0, 3000);
        return `--- ${f} ---\n${content}`;
      } catch {
        return `--- ${f} ---\n(unreadable)`;
      }
    })
    .join("\n\n");

  const constraintBlock = constraints.length > 0
    ? `\nConstraints (you MUST follow these):\n${constraints.map((c) => `- ${c}`).join("\n")}\n`
    : "";

  const userPrompt =
    `Task: ${task.instructions}\n` +
    `\nRepository: ${task.repo}` +
    `${constraintBlock}` +
    `\nCurrent files:\n${files.length > 0 ? files.join("\n") : "(empty repository)"}` +
    `\n\nFile contents:\n${fileContents}` +
    `\n\nWrite code that completes the task. Respond with JSON in this exact shape:\n` +
    `{\n  "files": {\n    "path/to/file.js": "file contents here"\n  },\n  "commit_message": "short description of what you did"\n}\n` +
    `\nRules:\n- Only include files you created or changed.\n` +
    `- Write complete, working code. No placeholders, no TODO comments.\n` +
    `- Keep it focused on the task.` +
    (constraints.length > 0 ? `\n- The constraints listed above are hard requirements, not suggestions.` : "");

  let result;
  try {
    result = await callLLM(strategy.system, userPrompt);
  } catch (err) {
    if (err.message === "BUDGET_EXCEEDED") throw err;
    console.error(`[${agent}] LLM call failed: ${err.message}`);
    throw err;
  }

  if (!result.files || typeof result.files !== "object") {
    throw new Error(`[${agent}] LLM did not return a files object`);
  }

  for (const [relPath, content] of Object.entries(result.files)) {
    const fullPath = join(repoDir, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
    console.log(`[${agent}] wrote ${relPath} (${content.length} chars)`);
  }

  // Commit with Trivium trailers for attribution and constraint tracking
  const msg = result.commit_message ?? `${strategy.name}: complete task`;
  const trailers = [
    `Trivium-Task: ${taskId}`,
    `Trivium-Agent: ${agent}`,
    `Trivium-Strategy: ${strategy.name}`,
    ...constraints.map((c) => `Trivium-Constraint: ${c}`),
  ].join("\n");
  const fullMsg = `${msg}\n\n${trailers}`.replace(/"/g, "'");
  execSync(
    `git add -A && git -c user.name="${agent}" -c user.email="${agent}@trivium" commit -m "${fullMsg}"`,
    { cwd: repoDir, stdio: "pipe" }
  );
  const sha = execSync(`git rev-parse HEAD`, { cwd: repoDir }).toString().trim();
  console.log(`[${agent}] pushing ${sha.slice(0, 8)}`);
  execSync(`git push origin HEAD:main`, { cwd: repoDir, stdio: "pipe" });

  await api(`/forks/${fork.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ commit_sha: sha }),
  });
  console.log(`[${agent}] reported complete`);
}

// --- Entry ---

const taskData = await api(`/tasks/${TASK_ID}`);
const task = taskData.task;
const forks = taskData.forks;
let constraints = [];
try {
  const fk = await api(`/tasks/${TASK_ID}/forks`);
  constraints = fk.constraints ?? [];
} catch { /* ignore */ }

console.log(`Task: ${task.repo} — ${task.instructions}`);
if (constraints.length > 0) console.log(`Constraints: ${constraints.join("; ")}`);
console.log(`Provider: ${PROVIDER}, ${forks.length} forks`);
if (MAX_SPEND > 0) {
  const spend = loadSpend();
  console.log(`Budget: $${spend.total_usd.toFixed(4)} spent / $${MAX_SPEND.toFixed(2)} cap`);
}

for (let i = 0; i < forks.length; i++) {
  const strategy = STRATEGIES[i % STRATEGIES.length];
  try {
    await runAgent(task, forks[i], strategy, constraints, TASK_ID);
  } catch (err) {
    if (err.message === "BUDGET_EXCEEDED") {
      console.error(`\nStopping: budget cap reached.`);
      break;
    }
    console.error(`[${strategy.agent}] FAILED: ${err.message}`);
  }
}

console.log("\nAll agents done.");
const final = loadSpend();
console.log(`Total spend tracked: $${final.total_usd.toFixed(4)} across ${final.calls} calls.`);
