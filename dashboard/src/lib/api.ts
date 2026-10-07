// API client for the Trivium dispatcher.
// Production URL is the default. Override with PUBLIC_TRIVIUM_API env var
// for local dev. This client runs server-side in Astro frontmatter, so
// the API stays server-to-server and tokens never reach the browser.

const API_BASE = import.meta.env.PUBLIC_TRIVIUM_API ?? "https://trivium.abnel.workers.dev";

interface ApiOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export interface Task {
  id: string;
  repo: string;
  instructions: string;
  status: string;
  budget_tokens: number;
  spent_tokens: number;
  agent_count: number;
  created_at: number;
  completed_at: number | null;
}

export interface Fork {
  id: string;
  task_id: string;
  agent_id: string;
  repo_name: string;
  token_expiry: number;
  status: string;
  created_at: number;
  completed_at: number | null;
}

export interface LedgerEvent {
  seq: number;
  event_type: string;
  actor: string;
  details: string;
  prev_hash: string;
  hash: string;
  created_at: number;
}

export const api = {
  listTasks: () => request<Task[]>("/tasks"),
  getTask: (id: string) => request<{ task: Task; forks: Fork[]; budget: unknown }>(`/tasks/${id}`),
  getLedger: (id: string) => request<{ valid: boolean; events: LedgerEvent[] }>(`/ledger/${id}`),
  createTask: (repo: string, instructions: string, agent_count: number) =>
    request<{ task_id: string }>("/task", {
      method: "POST",
      body: { repo, instructions, agent_count },
    }),
  runReview: (id: string) =>
    request<{ reviewed: { forkId: string; status: string }[] }>(`/tasks/${id}/review`, {
      method: "POST",
    }),
  merge: (id: string) =>
    request<{ merged: string; agent: string }>(`/tasks/${id}/merge`, {
      method: "POST",
    }),
};
