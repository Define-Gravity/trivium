# Trivium

Latin for "the place where three roads meet."

Trivium is a pipeline for letting AI agents write code without letting them touch your main branch. You describe a task. Trivium spins up several agents in isolated forks of your repo, each one working the same task on its own. Every fork goes through automated review gates. Only code that passes gets merged. Each step is written to a tamper-evident ledger, so you can always answer the question "who let the AI change that?"

It runs entirely on Cloudflare: Workers, Workflows, Durable Objects, D1, and Artifacts.

## Why this exists

Giving an agent write access to a repo is fast and frightening. It can rewrite anything, push anywhere, and leave you to reconstruct what happened afterward. The usual answer is to watch it closely, which defeats the purpose of using an agent at all.

Trivium starts from a different assumption: agents will make mistakes, so the pipeline is built so mistakes cannot reach main. Agents work in forks they cannot escape. Their output is scanned before a human ever looks at it. One coordinator decides what merges. The ledger records every decision.

## How it works

1. **Dispatch.** Create a task with a repo and instructions, from the dashboard or with `POST /task`. Trivium forks the repo once per agent, mints a short-lived write token per fork (15 minutes), and records the task in the ledger.

2. **Agents work.** Each fork gets its own Workflow. The agent clones its fork, calls the LLM, writes files, commits with Trivium trailers (task, fork, agent, model), and pushes. Forks cannot see each other and cannot touch main.

3. **Review gate.** When a fork finishes, a second Workflow fetches the diff, runs static scans (secrets, injection patterns, dependency checks), and assigns a risk tier. Standard changes can be approved automatically. Anything touching auth, CI/CD, or crypto is flagged for a human.

4. **Merge.** A Durable Object acts as the single-writer merge coordinator. There is no "last finisher wins." Approved forks merge in a defined order, and conflicts are routed to resolution instead of being silently overwritten.

5. **Ledger.** Every event is appended to a hash-chained ledger in D1: task created, fork created, agent started, agent completed, gate results, approvals, merges. Each entry includes the hash of the previous entry, so tampering breaks the chain. The dashboard verifies the chain on read.

## Architecture

There are no servers to run. The pieces:

- **Workers** (`src/index.ts`): the API. Tasks, forks, projects, key settings, review and merge triggers.
- **Workflow `AgentRunner`**: one instance per agent. Steps: load context (task, fork, decrypted LLM key), then clone, call the LLM, commit, and push, then report completion and spend.
- **Workflow `ReviewGate`**: one instance per finished fork. Steps: fetch the diff, run scans, assign a risk tier, approve or escalate.
- **Durable Object `MergeCoordinator`**: the single writer. Serializes merge decisions so parallel forks cannot corrupt main.
- **D1 (`trivium-ledger`)**: tasks, forks, the ledger, and encrypted user keys. The ledger table is append-only and never updated or deleted.
- **Artifacts**: git hosting for project repos and agent forks. Forks get scoped write tokens that expire after 15 minutes.
- **Dashboard** (`dashboard/`, Astro): task list and detail, projects, LLM key settings, the run-agents UI, review and merge buttons, and a ledger viewer with chain validation.

## API

| Method | Path | What it does |
| ------ | ---- | ------------ |
| POST | `/task` | Create a task: `{ repo, instructions, budget_tokens?, agent_count?, constraints? }` |
| GET | `/tasks` | List recent tasks |
| GET | `/tasks/:id` | Task detail with forks and budget status |
| GET | `/tasks/:id/forks` | Forks for a task |
| POST | `/tasks/:id/run` | Start agent Workflows for a task (`{ provider }`) |
| POST | `/tasks/:id/review` | Run review gates on completed forks |
| POST | `/tasks/:id/merge` | Merge the winning fork (tasks without a project) |
| POST | `/tasks/:id/merge-real` | Merge the approved fork into the project's `main` |
| GET | `/ledger/:id` | Full hash-chained event log for a task, with validity check |
| GET | `/projects` | List projects |
| POST | `/projects` | Create a project |
| POST | `/projects/:id/import` | Import a repo into a project |
| POST | `/settings/keys` | Save an LLM key (encrypted at rest) |
| GET | `/settings/keys` | Key status and spend per provider |

## Setup

You need Node 18+, a Cloudflare account, and `wrangler`.

```bash
npm install

# 1. Create the D1 database and put the ID in wrangler.toml
npx wrangler d1 create trivium-ledger
npx wrangler d1 execute trivium-ledger --file=src/schema.sql

# 2. Create the user_keys table (not yet in schema.sql)
npx wrangler d1 execute trivium-ledger --command="
CREATE TABLE IF NOT EXISTS user_keys (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  spend_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);"

# 3. Create the Artifacts namespace
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{"namespace":"trivium","jurisdiction":"us"}'

# 4. Set the encryption secret for stored LLM keys (do this before saving any key)
npx wrangler secret put KEY_ENCRYPTION_SECRET

# 5. Deploy the API worker
npx wrangler deploy
```

Then the dashboard:

```bash
cd dashboard
npm install
npm run build
npm run deploy
```

Open the dashboard, go to Settings, and save your OpenAI or Gemini API key. Keys are encrypted with AES-GCM (key derived from `KEY_ENCRYPTION_SECRET` via PBKDF2) before they touch D1, and decrypted in memory only inside the agent Workflow.

## Running your first task

1. Create a project and import a repo into it (dashboard or `POST /projects/:id/import`).
2. Create a task with written instructions.
3. Pick a provider and start the agents.
4. Watch the forks run. The ledger records each step as it happens.
5. Run the review gates, check the results, and merge to main.

## Security model

- Agents never touch `main`. They get forks and nothing else.
- Fork write tokens are scoped to a single fork and expire after 15 minutes.
- LLM keys are encrypted at rest and decrypted in memory only, inside the Workflow that needs them. They never appear in logs or error messages.
- Agent output is never trusted. Scans run before anything merges.
- The ledger is append-only and hash-chained. If someone edits history, the chain breaks.
- One coordinator writes merges. Parallel forks cannot race on `main`.

## Cost control

Each task carries a token budget. The agent runner records input and output tokens for every LLM call, prices them against the provider's rate card, and accumulates spend per key. The dashboard shows spend per provider on the settings page.

Note: the budget is currently tracked and reported, but the hard cap is not yet enforced before a Workflow makes its LLM calls. If you need a guarantee rather than a report, set your provider-side limits too.

## Known limitations

An honest list, as of now:

- Single default user. Real authentication is deferred.
- The key and run endpoints are unauthenticated in this build. Do not expose the API publicly without adding auth in front of it.
- The hard spend cap is tracked but not enforced inside the Workflow path (see above).
- Conflict handling between parallel forks is minimal. The coordinator serializes merges, but genuine content conflicts still need a resolver.
- The `user_keys` table is created manually. The migration is not in `schema.sql` yet.

## Project structure

```
src/
  index.ts           API routes (tasks, forks, projects, keys, review, merge)
  agent-workflow.ts  AgentRunner Workflow: clone, LLM, commit, push, report
  keys.ts            AES-GCM encrypt/decrypt for user LLM keys
  ledger.ts          Hash-chained ledger append and verify
  schema.sql         D1 schema: tasks, forks, ledger
  memory-fs.ts       In-Workflow filesystem for git operations
  git-http-client.js HTTP client for isomorphic-git against Artifacts
dashboard/
  src/pages/        Task list and detail, projects, settings, ledger views
wrangler.toml        Bindings: D1, Durable Object, Workflows, Artifacts
DIRECTIVES.md        Engineering and writing standards for this project
```

## Roadmap

- A real conflict resolver for competing forks
- Authentication and multi-user projects
- Enforced spend caps in the Workflow path
- More LLM providers
- CI hooks that run on merged code

## Contributing

This is an early project. If you want to contribute, open an issue first describing what you want to change. Keep the standards in `DIRECTIVES.md`: plain human language everywhere, no em dashes, TypeScript throughout, validate everything agents produce, and never put secrets in logs.

## License

MIT
