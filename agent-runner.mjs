// Trivium agent runner. Run with: node agent-runner.mjs <task-id>
// Clones each fork, applies that agent's strategy, commits, pushes,
// then reports completion to the coordinator.
//
// Env vars:
//   TRIVIUM_API           base URL of the dispatcher (default http://localhost:8787)
//   ARTIFACTS_ACCOUNT_ID  your Cloudflare account ID
//   ARTIFACTS_NAMESPACE   namespace name (default trivium)

import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const API = process.env.TRIVIUM_API ?? "http://localhost:8787";
const ACCOUNT_ID = process.env.ARTIFACTS_ACCOUNT_ID;
const NAMESPACE = process.env.ARTIFACTS_NAMESPACE ?? "trivium";

if (!ACCOUNT_ID) {
  console.error("Set ARTIFACTS_ACCOUNT_ID first.");
  process.exit(1);
}

const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: node agent-runner.mjs <task-id>");
  process.exit(1);
}

// Each agent takes a visibly different approach to the same task.
const strategies = [
  {
    name: "minimal",
    file: "hello.js",
    content: `// Minimal hello world endpoint
export function hello() {
  return "hello world";
}
`,
  },
  {
    name: "defensive",
    file: "hello.js",
    content: `// Hello world with input validation
export function hello(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("name is required");
  }
  return \`hello \${name.trim()}\`;
}
`,
  },
  {
    name: "tested",
    file: "hello.js",
    content: `// Hello world with a self-test
export function hello() {
  return "hello world";
}

if (hello() !== "hello world") {
  throw new Error("self-test failed");
}
console.log("self-test passed");
`,
  },
];

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

async function main() {
  const res = await fetch(`${API}/tasks/${taskId}/forks`);
  const { forks } = await res.json();

  for (let i = 0; i < forks.length; i++) {
    const fork = forks[i];
    const strategy = strategies[i % strategies.length];
    const token = JSON.parse(fork.token);
    const plaintext = token.plaintext ?? token.token ?? token;
    const remote = `https://${ACCOUNT_ID}.artifacts.cloudflare.net/git/${NAMESPACE}/${fork.repo_name}.git`;

    console.log(`\n[${fork.agent_id}] cloning ${fork.repo_name} (${strategy.name} strategy)`);

    const dir = mkdtempSync(join(tmpdir(), `trivium-${fork.agent_id}-`));
    try {
      run(`git -c http.extraHeader="Authorization: Bearer ${plaintext}" clone "${remote}" .`, dir);
      run(`git config user.email "agent@trivium.local"`, dir);
      run(`git config user.name "${fork.agent_id}"`, dir);

      writeFileSync(join(dir, strategy.file), strategy.content);
      run(`git add ${strategy.file}`, dir);
      run(`git commit -m "${strategy.name}: implement hello world"`, dir);
      const sha = execSync(`git rev-parse HEAD`, { cwd: dir }).toString().trim();
      run(`git -c http.extraHeader="Authorization: Bearer ${plaintext}" push origin main`, dir);

      console.log(`[${fork.agent_id}] pushed ${sha.slice(0, 8)}`);

      await fetch(`${API}/forks/${fork.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit_sha: sha }),
      });
      console.log(`[${fork.agent_id}] reported complete`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nAll agents done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
