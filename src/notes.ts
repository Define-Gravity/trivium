// Git notes for Trivium review results.
//
// The Workers binding cannot write git objects, so the dispatcher mints a
// short-lived write token for itself and pushes notes via isomorphic-git
// over HTTPS. Notes live in refs/notes/trivium/review, one JSON blob per
// reviewed commit.
//
// Agents cannot forge these: the token is minted by the dispatcher and the
// note is written by the review gate, not by any agent.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";

export const REVIEW_NOTES_REF = "refs/notes/trivium/review";

export interface ReviewNote {
  task_id: string;
  fork_id: string;
  agent_id: string;
  commit_sha: string;
  passed: boolean;
  findings: string[];
  risk_tier: "standard" | "high";
  decision: "approved" | "quarantined" | "awaiting_human";
  reviewed_at: number;
}

interface ArtifactsEnv {
  ARTIFACTS: {
    get(name: string): Promise<{
      info(): Promise<{ remote: string }>;
      createToken(scope: "read" | "write", ttl: number): Promise<{ plaintext: string }>;
    }>;
  };
}

function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

function auth(password: string) {
  return () => ({ username: "x", password });
}

// Write a review note to the given commit in the given repo.
// Creates the notes ref if it does not exist yet.
export async function writeReviewNote(
  env: ArtifactsEnv,
  repoName: string,
  commitSha: string,
  note: ReviewNote
): Promise<void> {
  const repo = await env.ARTIFACTS.get(repoName);
  const { remote } = await repo.info();
  const tokenResult = await repo.createToken("write", 300);
  const password = tokenSecret(tokenResult.plaintext);

  const fs = new MemoryFS();
  const dir = "/notes-work";

  await git.clone({
    fs: fs as unknown as Parameters<typeof git.clone>[0]["fs"],
    http,
    dir,
    url: remote,
    ref: "main",
    depth: 1,
    singleBranch: true,
    onAuth: auth(password),
  });

  await git.addNote({
    fs: fs as unknown as Parameters<typeof git.addNote>[0]["fs"],
    dir,
    oid: commitSha,
    note: JSON.stringify(note),
    ref: REVIEW_NOTES_REF,
    force: true,
    author: { name: "trivium-review", email: "review@trivium.local" },
  });

  await git.push({
    fs: fs as unknown as Parameters<typeof git.push>[0]["fs"],
    http,
    dir,
    url: remote,
    ref: REVIEW_NOTES_REF,
    onAuth: auth(password),
  });
}
