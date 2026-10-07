# Trivium

Latin for "the place where three roads meet." Three agents, three approaches,
one result.

Trivium is a parallel-agent merge pipeline with security gates, built on
Cloudflare Workers and Artifacts. You give it a task. Three agents work it
simultaneously in isolated forks. Only code that passes automated checks
reaches main.

## How it works

1. **Dispatch.** `POST /task` with a repo and instructions. Trivium forks the
   repo three times, mints a 15-minute write token per fork, and records
   everything in a hash-chained ledger.
2. **Parallel work.** Three agents get the same task with different approaches.
   They work in isolation. They cannot see each other or touch main.
3. **Merge.** A single-writer coordinator collects completed forks and merges.
   Conflicts go to a resolver, not "last finisher wins."
4. **Review gate.** Every diff runs through static scans (secrets, injection,
   dependencies), then risk tiering. Standard changes auto-merge. High-risk
   paths (auth, CI/CD, crypto) require a human.
5. **Ledger.** Every action is hash-chained and exportable. If anyone asks
   "who approved the AI to make that change," the answer is in the ledger.

## Enterprise standard

This project holds itself to production standards: sandboxed agents,
short-lived scoped tokens, tamper-evident audit trails, hard cost ceilings,
and no trust in agent output. See DIRECTIVES.md.

## Setup

```bash
npm install

# Create the D1 database, then put the ID in wrangler.toml
npx wrangler d1 create trivium-ledger
npx wrangler d1 execute trivium-ledger --file=src/schema.sql

# Create the Artifacts namespace, then uncomment the binding in wrangler.toml
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{"namespace":"trivium","jurisdiction":"us"}'

npx wrangler dev    # local
npx wrangler deploy # edge
```

## API

- `POST /task` — create a task: `{ repo, instructions, budget_tokens?, agent_count? }`
- `GET /tasks` — list recent tasks
- `GET /tasks/:id` — task detail with forks and budget status
- `GET /ledger/:id` — full hash-chained event log with validity check

## License

MIT
