import { describe, expect, it } from "@rstest/core";

import {
  buildCreateAgentRequest,
  EMPTY_AGENT_MANUAL_DRAFT,
  type AgentManualFormDraft,
} from "@/components/workspace/agents/agent-manual-form-helpers";
import {
  DEFAULT_MODEL_VALUE,
  MAX_AGENT_OUTPUT_TOKENS,
} from "@/components/workspace/agents/agent-settings-dialog-helpers";

function draft(overrides: Partial<AgentManualFormDraft> = {}) {
  return {
    ...EMPTY_AGENT_MANUAL_DRAFT,
    name: "code-reviewer",
    soul: "You review code.",
    ...overrides,
  };
}

describe("buildCreateAgentRequest", () => {
  it("maps a filled draft onto the create contract", () => {
    const result = buildCreateAgentRequest(
      draft({
        name: "  code-reviewer  ",
        displayName: "  代码审查助手  ",
        description: "  Reviews pull requests.  ",
        soul: "\n  You review code.\n\n",
        temperature: "0.3",
        maxTokens: "4000",
        plugins: [],
        skills: ["code-review"],
        toolGroups: null,
      }),
    );

    expect(result).toEqual({
      ok: true,
      request: {
        name: "code-reviewer",
        display_name: "代码审查助手",
        description: "Reviews pull requests.",
        soul: "You review code.",
        model: null,
        model_settings: { temperature: 0.3, max_tokens: 4000 },
        tool_groups: null,
        skills: ["code-review"],
        mcp_plugins: [],
      },
    });
  });

  it("passes an explicit model through and keeps null and [] distinct", () => {
    const result = buildCreateAgentRequest(
      draft({ model: "deepseek-v3", skills: [], plugins: null }),
    );

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        model: "deepseek-v3",
        skills: [],
        mcp_plugins: null,
        tool_groups: null,
      }),
    });
  });

  it("leaves capability defaults that the create form does not expose", () => {
    const result = buildCreateAgentRequest(draft());

    expect(result).toEqual({ ok: true, request: expect.anything() });
    if (!result.ok) return;
    expect(result.request).not.toHaveProperty("thinking_enabled");
    expect(result.request).not.toHaveProperty("reasoning_effort");
    expect(result.request).not.toHaveProperty("allowed_subagents");
    expect(result.request).not.toHaveProperty("knowledge_scope");
  });

  it("requires a name and rejects characters outside the identifier set", () => {
    expect(buildCreateAgentRequest(draft({ name: "   " }))).toEqual({
      ok: false,
      error: "name_required",
    });
    expect(buildCreateAgentRequest(draft({ name: "code_reviewer" }))).toEqual({
      ok: false,
      error: "name_invalid",
    });
    // The Gateway accepts upper case and stores the name lowercased.
    expect(buildCreateAgentRequest(draft({ name: "Code-Reviewer" }))).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("counts display-name limits in code points, not UTF-16 units", () => {
    expect(
      buildCreateAgentRequest(draft({ displayName: "🦌".repeat(100) })),
    ).toEqual(expect.objectContaining({ ok: true }));
    expect(
      buildCreateAgentRequest(draft({ displayName: "🦌".repeat(101) })),
    ).toEqual({ ok: false, error: "display_name_too_long" });
  });

  it("requires a non-blank system prompt", () => {
    expect(buildCreateAgentRequest(draft({ soul: " \n\t " }))).toEqual({
      ok: false,
      error: "soul_required",
    });
  });

  it("rejects out-of-range sampling settings", () => {
    expect(
      buildCreateAgentRequest(draft({ temperature: "2.5", maxTokens: "" })),
    ).toEqual({ ok: false, error: "temperature" });
    expect(
      buildCreateAgentRequest(
        draft({ maxTokens: String(MAX_AGENT_OUTPUT_TOKENS + 1) }),
      ),
    ).toEqual({ ok: false, error: "max_tokens" });
  });

  it("sends no model override for the global-default sentinel", () => {
    const result = buildCreateAgentRequest(
      draft({ model: DEFAULT_MODEL_VALUE }),
    );

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({ model: null }),
    });
  });
});
