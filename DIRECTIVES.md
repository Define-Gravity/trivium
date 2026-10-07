# Trivium Project Directives

## Standard

Enterprise-grade. Every decision should hold up under a security review,
a SOC 2 audit, and a production incident. If it would not survive those
three, do not ship it.

## Writing

Plain, human language everywhere. This covers code comments, README, dashboard
copy, commit messages, video script, and any user-facing text.

- No em dashes. Use commas, periods, or parentheses instead.
- No AI tells: avoid "delve," "unlock," "elevate," "seamless," "robust,"
  "cutting-edge," "leverage" (as a verb), "game-changer," "revolutionize."
- No brochure speak. Describe what the code does, not how amazing it is.
- Comments explain why, not what. If the code is clear, no comment needed.
- Write like a person explaining to another engineer, not a press release.

## Code

- TypeScript throughout. No `any` without a comment explaining why.
- Every agent-facing function validates its inputs. Never trust agent output.
- Secrets never appear in logs, comments, or error messages.
- All timestamps are Unix epoch integers.
- Hash-chained ledger: every entry includes the hash of the previous entry.
  No exceptions, no shortcuts.
