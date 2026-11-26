import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";
export { fetchAgentsApiEnabled } from "@/core/features/api";

import type {
  Agent,
  AgentPackage,
  CreateAgentRequest,
  UpdateAgentRequest,
} from "./types";

const BACKEND_UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

export class AgentNameCheckError extends Error {
  constructor(
    message: string,
    public readonly reason: "backend_unreachable" | "request_failed",
    /**
     * Raw backend `detail` string when the failure came from a backend
     * response carrying one. `null` when no detail was provided (e.g.
     * network-layer failure, empty response body, unparseable body) — in
     * which case `message` is a generated fallback like "Failed to check
     * agent name: Bad Gateway" and the UI should prefer its own localized
     * fallback instead of surfacing the generated string.
     */
    public readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "AgentNameCheckError";
  }
}

export class AgentsApiDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsApiDisabledError";
  }
}

/**
 * The name is already taken, either seen by the pre-create availability check
 * or raced into the create itself (HTTP 409). Callers surface the localized
 * "already exists" message instead of the backend's English detail.
 */
export class AgentAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAlreadyExistsError";
  }
}

/**
 * The create was refused for a reason the caller can act on: a 422 validation
 * (an invisible display-name character, a model removed from the catalog) or a
 * 403 without agents:write. The backend `detail` names the cause.
 */
export class AgentCreateRejectedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "AgentCreateRejectedError";
  }
}

function isAgentsApiDisabledDetail(detail: string | undefined): boolean {
  return typeof detail === "string" && detail.includes("agents_api.enabled");
}

/**
 * Readable message from a FastAPI error body. Its `detail` is a string for the
 * router's own `HTTPException`s and an array of `{msg}` issues for request-body
 * validation; anything else (a nested object, a blank string) yields null so
 * the caller can use its localized fallback. Pydantic prefixes messages raised
 * by a `BeforeValidator` with "Value error, ", which says nothing to a user.
 */
function errorDetailMessage(detail: unknown): string | null {
  if (typeof detail === "string") {
    return detail.trim() ? detail : null;
  }
  if (!Array.isArray(detail)) {
    return null;
  }
  const message = detail
    .filter(
      (issue): issue is { msg: string } =>
        typeof issue === "object" &&
        issue !== null &&
        "msg" in issue &&
        typeof issue.msg === "string" &&
        issue.msg.trim().length > 0,
    )
    .map((issue) => issue.msg.replace(/^Value error, /, ""))
    .join("; ");
  return message.trim() ? message : null;
}

export async function listAgents(): Promise<Agent[]> {
  const res = await fetch(`${getBackendBaseURL()}/api/agents`);
  if (!res.ok) throw new Error(`Failed to load agents: ${res.statusText}`);
  const data = (await res.json()) as { agents: Agent[] };
  return data.agents;
}

export async function listAgentToolGroups(): Promise<string[]> {
  const res = await fetch(`${getBackendBaseURL()}/api/agent-tool-groups`);
  if (!res.ok) {
    throw new Error(`Failed to load agent tool groups: ${res.statusText}`);
  }
  const data = (await res.json()) as { tool_groups: string[] };
  return data.tool_groups;
}

export async function getAgent(name: string): Promise<Agent> {
  const res = await fetch(`${getBackendBaseURL()}/api/agents/${name}`);
  if (!res.ok) throw new Error(`Agent '${name}' not found`);
  return res.json() as Promise<Agent>;
}

export async function createAgent(request: CreateAgentRequest): Promise<Agent> {
  const res = await fetch(`${getBackendBaseURL()}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const detail = errorDetailMessage(body.detail);
    if (isAgentsApiDisabledDetail(detail ?? undefined)) {
      throw new AgentsApiDisabledError(detail!);
    }
    if (res.status === 409) {
      throw new AgentAlreadyExistsError(
        detail ?? `Agent already exists: ${res.statusText}`,
      );
    }
    if (res.status === 422 || res.status === 403) {
      throw new AgentCreateRejectedError(
        detail ?? `Failed to create agent: ${res.statusText}`,
        res.status,
        detail,
      );
    }
    throw new Error(detail ?? `Failed to create agent: ${res.statusText}`);
  }
  return res.json() as Promise<Agent>;
}

export async function exportAgentPackage(name: string): Promise<AgentPackage> {
  const res = await fetch(
    `${getBackendBaseURL()}/api/agents/${encodeURIComponent(name)}/export`,
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Failed to export agent: ${res.statusText}`);
  }
  return res.json() as Promise<AgentPackage>;
}

export async function importAgentPackage(
  agentPackage: unknown,
  name?: string,
): Promise<Agent> {
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  const res = await fetch(`${getBackendBaseURL()}/api/agents/import${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentPackage),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      detail?: unknown;
    } | null;
    throw new Error(
      errorDetailMessage(err?.detail) ??
        `Failed to import agent: ${res.statusText}`,
    );
  }
  return res.json() as Promise<Agent>;
}

export async function updateAgent(
  name: string,
  request: UpdateAgentRequest,
): Promise<Agent> {
  const res = await fetch(`${getBackendBaseURL()}/api/agents/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Failed to update agent: ${res.statusText}`);
  }
  return res.json() as Promise<Agent>;
}

export async function deleteAgent(name: string): Promise<void> {
  const res = await fetch(`${getBackendBaseURL()}/api/agents/${name}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete agent: ${res.statusText}`);
}

export async function checkAgentName(
  name: string,
): Promise<{ available: boolean; name: string }> {
  let res: Response;
  try {
    res = await fetch(
      `${getBackendBaseURL()}/api/agents/check?name=${encodeURIComponent(name)}`,
    );
  } catch {
    throw new AgentNameCheckError(
      "Could not reach the DeerFlow backend.",
      "backend_unreachable",
    );
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    if (isAgentsApiDisabledDetail(err.detail)) {
      throw new AgentsApiDisabledError(err.detail!);
    }
    if (BACKEND_UNAVAILABLE_STATUSES.has(res.status)) {
      throw new AgentNameCheckError(
        "Could not reach the DeerFlow backend.",
        "backend_unreachable",
      );
    }
    const backendDetail = typeof err.detail === "string" ? err.detail : null;
    throw new AgentNameCheckError(
      backendDetail ?? `Failed to check agent name: ${res.statusText}`,
      "request_failed",
      backendDetail,
    );
  }
  return res.json() as Promise<{ available: boolean; name: string }>;
}
