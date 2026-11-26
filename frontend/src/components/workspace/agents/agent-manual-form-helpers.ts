import type { CreateAgentRequest } from "@/core/agents/types";

import {
  DEFAULT_MODEL_VALUE,
  parseAgentModelSettingsDraft,
} from "./agent-settings-dialog-helpers";

/** Mirrors the Gateway's AGENT_NAME_PATTERN; the Gateway lowercases the name. */
export const AGENT_NAME_RE = /^[A-Za-z0-9-]+$/;

const MAX_DISPLAY_NAME_CODE_POINTS = 100;

/**
 * The manually filled create form. Raw input strings are kept here so the
 * fields stay editable while invalid; {@link buildCreateAgentRequest} owns the
 * conversion to the API contract.
 */
export interface AgentManualFormDraft {
  name: string;
  displayName: string;
  description: string;
  soul: string;
  /** DEFAULT_MODEL_VALUE sentinel or a model name from the catalog. */
  model: string;
  /** Empty means inherit from the model profile. */
  temperature: string;
  maxTokens: string;
  /** null means "all"; [] means "none" (Gateway semantics). */
  plugins: string[] | null;
  skills: string[] | null;
  toolGroups: string[] | null;
}

export const EMPTY_AGENT_MANUAL_DRAFT: AgentManualFormDraft = {
  name: "",
  displayName: "",
  description: "",
  soul: "",
  model: DEFAULT_MODEL_VALUE,
  temperature: "",
  maxTokens: "",
  plugins: null,
  skills: null,
  toolGroups: null,
};

export type AgentManualFormError =
  | "name_required"
  | "name_invalid"
  | "display_name_too_long"
  | "soul_required"
  | "temperature"
  | "max_tokens";

export type AgentManualFormResult =
  | { ok: true; request: CreateAgentRequest }
  | { ok: false; error: AgentManualFormError };

/**
 * Validates and converts a draft into the create request. Thinking mode,
 * reasoning effort, subagent access and knowledge scope are deliberately left
 * unset: a new agent inherits the runtime defaults, and those settings stay
 * editable in the agent settings dialog afterwards.
 */
export function buildCreateAgentRequest(
  draft: AgentManualFormDraft,
): AgentManualFormResult {
  const name = draft.name.trim();
  if (!name) {
    return { ok: false, error: "name_required" };
  }
  if (!AGENT_NAME_RE.test(name)) {
    return { ok: false, error: "name_invalid" };
  }

  const displayName = draft.displayName.trim();
  if ([...displayName].length > MAX_DISPLAY_NAME_CODE_POINTS) {
    return { ok: false, error: "display_name_too_long" };
  }

  const soul = draft.soul.trim();
  if (!soul) {
    return { ok: false, error: "soul_required" };
  }

  const parsedSettings = parseAgentModelSettingsDraft({
    temperature: draft.temperature,
    maxTokens: draft.maxTokens,
  });
  if (!parsedSettings.ok) {
    return { ok: false, error: parsedSettings.error };
  }

  return {
    ok: true,
    request: {
      name,
      display_name: displayName || null,
      description: draft.description.trim(),
      soul,
      model: draft.model === DEFAULT_MODEL_VALUE ? null : draft.model,
      model_settings: parsedSettings.modelSettings,
      tool_groups: draft.toolGroups,
      skills: draft.skills,
      mcp_plugins: draft.plugins,
    },
  };
}
