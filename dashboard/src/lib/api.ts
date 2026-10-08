// API client for the Trivium dispatcher via Cloudflare Service Binding.
// The dashboard Worker binds directly to the Trivium API Worker.
// No HTTP, no public internet, no routing issues. This is the
// Cloudflare-native way for Workers to talk to each other.
//
// Usage in Astro frontmatter:
//   const api = createApi(Astro.locals.runtime.env.TRIVIUM_API);

interface ApiOptions {
  method?: string;
  body?: unknown;
}

// Service bindings require a full URL. The host is ignored;
// the binding routes to the bound Worker regardless.
const INTERNAL_BASE = 'https://trivium.internal';

export function createApi(binding: { fetch: typeof fetch }) {
  async function request<T>(path: string, opts: ApiOptions = {}): Promise<T> {
    const res = await binding.fetch(INTERNAL_BASE + path, {
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

  return {
    listTasks: () => request<Task[]>("/tasks"),
    getTask: (id: string) => request<{ task: Task; forks: Fork[]; budget: unknown }>(`/tasks/${id}`),
    getLedger: (id: string) => request<{ valid: boolean; events: LedgerEvent[] }>(`/ledger/${id}`),
    createTask: (repo: string, instructions: string, agent_count: number, project_id?: string) =>
      request<{ task_id: string }>("/task", {
        method: "POST",
        body: { repo, instructions, agent_count, project_id },
      }),
    runReview: (id: string) =>
      request<{ reviewed: { forkId: string; status: string }[] }>(`/tasks/${id}/review`, {
        method: "POST",
      }),
    merge: (id: string) =>
      request<{ merged: string; agent: string }>(`/tasks/${id}/merge`, {
        method: "POST",
      }),
    mergeReal: (id: string) =>
      request<{ merged: boolean; merge_commit: string; agent: string }>(`/tasks/${id}/merge-real`, {
        method: "POST",
      }),
    listProjects: () => request<Project[]>("/projects"),
    createProject: (name: string) =>
      request<{ project_id: string; name: string; repo_name: string }>("/projects", {
        method: "POST",
        body: { name },
      }),
    getProjectRemote: (id: string) =>
      request<{ remote: string; token: string; expires_in: number }>(`/projects/${id}/remote`),
    setApiKey: (provider: "openai" | "gemini", api_key: string) =>
      request<{ provider: string; configured: boolean }>("/settings/keys", {
        method: "POST",
        body: { provider, api_key },
      }),
    getKeyStatus: () =>
      request<Record<"openai" | "gemini", { configured: boolean; spend_usd: number }>>("/settings/keys"),
    runAgents: (taskId: string, provider: "openai" | "gemini") =>
      request<{ started: number; workflow_ids: string[]; provider: string }>(`/tasks/${taskId}/run`, {
        method: "POST",
        body: { provider },
      }),
  };
}

export type ApiClient = ReturnType<typeof createApi>;

export interface Task {
  id: string;
  repo: string;
  instructions: string;
  status: string;
  budget_tokens: number;
  spent_tokens: number;
  agent_count: number;
  project_id: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface Project {
  id: string;
  name: string;
  repo_name: string;
  created_at: number;
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

// (api methods are now returned by createApi above)
