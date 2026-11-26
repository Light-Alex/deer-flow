/**
 * Tests for the error-classification behaviour of `checkAgentName`.
 *
 * Issue #3041: when the backend returns a non-200 response (e.g. a 500 with
 * a database error, a 422 from misbehaving routing, or any other 4xx/5xx
 * not in the 502/503/504 set), the UI used to swallow the backend detail
 * into a generic "Could not verify name availability" fallback because the
 * page-level catch block only handled `reason === "backend_unreachable"`.
 *
 * The fix carries the raw backend detail as `AgentNameCheckError.detail`
 * (distinct from `message`, which always has a non-empty value because
 * `checkAgentName` substitutes a generated fallback when the backend sent
 * no detail). The UI uses `detail` to decide whether to surface a real
 * backend string or fall back to the localised "could not verify" copy.
 *
 * These tests pin both halves of the contract so a future refactor doesn't
 * silently drop the detail or leak the generated fallback into the UI.
 */
import { beforeEach, describe, expect, test, rs } from "@rstest/core";

rs.mock("@/core/api/fetcher", () => ({
  fetch: rs.fn(),
}));

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => "",
}));

import {
  AgentAlreadyExistsError,
  AgentCreateRejectedError,
  AgentsApiDisabledError,
  checkAgentName,
  createAgent,
  exportAgentPackage,
  importAgentPackage,
  updateAgent,
} from "@/core/agents/api";
import { fetch as fetcher } from "@/core/api/fetcher";

const mockedFetch = rs.mocked(fetcher);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("checkAgentName", () => {
  test("returns availability payload on 200", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, { available: true, name: "dealagent" }),
    );
    const result = await checkAgentName("dealagent");
    expect(result).toEqual({ available: true, name: "dealagent" });
  });

  test("treats network-layer fetch rejection as backend_unreachable", async () => {
    mockedFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(checkAgentName("dealagent")).rejects.toMatchObject({
      name: "AgentNameCheckError",
      reason: "backend_unreachable",
    });
  });

  test.each([502, 503, 504])(
    "treats HTTP %i as backend_unreachable",
    async (status) => {
      mockedFetch.mockResolvedValueOnce(
        jsonResponse(status, { detail: "Bad Gateway" }),
      );
      await expect(checkAgentName("dealagent")).rejects.toMatchObject({
        name: "AgentNameCheckError",
        reason: "backend_unreachable",
      });
    },
  );

  test("recognises agents_api disabled detail and throws AgentsApiDisabledError", async () => {
    const detail =
      "Custom-agent management API is disabled. Set agents_api.enabled=true to expose agent and user-profile routes over HTTP.";
    mockedFetch.mockResolvedValueOnce(jsonResponse(403, { detail }));
    await expect(checkAgentName("dealagent")).rejects.toBeInstanceOf(
      AgentsApiDisabledError,
    );
  });

  test("carries backend 422 detail through AgentNameCheckError.detail (issue #3041)", async () => {
    // This is the exact response shape produced by `_validate_agent_name`
    // when the user submits a name with disallowed characters — e.g. a
    // trailing space, a dot, a Chinese character, or invisible whitespace
    // pasted in from another window.
    const detail =
      "Invalid agent name 'deal agent'. Must match ^[A-Za-z0-9-]+$ (letters, digits, and hyphens only).";
    mockedFetch.mockResolvedValueOnce(jsonResponse(422, { detail }));

    await expect(checkAgentName("deal agent")).rejects.toMatchObject({
      name: "AgentNameCheckError",
      reason: "request_failed",
      // The full detail is preserved on both `detail` (for the UI to
      // recognise "real backend detail vs generated fallback") and
      // `message` (for stack traces / logs).
      detail,
      message: detail,
    });
  });

  test("falls back to statusText in message but leaves detail null when backend returns no detail", async () => {
    // The fallback message must NOT mask the absence of a real backend
    // detail — the page-level catch relies on `detail === null` to choose
    // the localised generic fallback rather than rendering the bare
    // "Failed to check agent name: Internal Server Error" string.
    mockedFetch.mockResolvedValueOnce(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(checkAgentName("dealagent")).rejects.toMatchObject({
      name: "AgentNameCheckError",
      reason: "request_failed",
      detail: null,
      message: expect.stringContaining("Internal Server Error"),
    });
  });

  test("treats non-string detail as null (defence against future schema drift)", async () => {
    // If the backend ever returns `{detail: {code, message}}` (the shape
    // used by auth errors today) on this endpoint, we must not surface a
    // `[object Object]` string. `detail` should fall back to null so the
    // page uses its localised fallback.
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(500, { detail: { code: "x", message: "y" } }),
    );
    await expect(checkAgentName("dealagent")).rejects.toMatchObject({
      name: "AgentNameCheckError",
      reason: "request_failed",
      detail: null,
    });
  });

  test("does not misclassify a 422 with unrelated detail as agents_api disabled", async () => {
    // Defence-in-depth: the disabled detector matches on the substring
    // "agents_api.enabled", so a 422 whose detail accidentally contains
    // the same substring would be misclassified. The validation detail
    // produced by `_validate_agent_name` never contains it; this test
    // simply asserts that "Invalid agent name ..." stays in the
    // request_failed branch, which is where the page now surfaces it.
    const detail =
      "Invalid agent name 'deal.agent'. Must match ^[A-Za-z0-9-]+$ (letters, digits, and hyphens only).";
    mockedFetch.mockResolvedValueOnce(jsonResponse(422, { detail }));
    await expect(checkAgentName("deal.agent")).rejects.not.toBeInstanceOf(
      AgentsApiDisabledError,
    );
  });
});

describe("createAgent", () => {
  const request = { name: "code-reviewer", soul: "You review code." };

  test("returns the created agent", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(201, { name: "code-reviewer", soul: "You review code." }),
    );

    await expect(createAgent(request)).resolves.toMatchObject({
      name: "code-reviewer",
    });
    const [url, init] = mockedFetch.mock.calls[0]!;
    expect(url).toBe("/api/agents");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  test("maps a 409 to AgentAlreadyExistsError", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: "Agent 'code-reviewer' already exists" }),
    );

    const error = await createAgent(request).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentAlreadyExistsError);
    expect(error.message).toBe("Agent 'code-reviewer' already exists");
  });

  test("keeps the agents_api-disabled 403 on AgentsApiDisabledError", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(403, {
        detail:
          "Custom-agent management API is disabled. Set agents_api.enabled=true to expose agent and user-profile routes over HTTP.",
      }),
    );

    await expect(createAgent(request)).rejects.toBeInstanceOf(
      AgentsApiDisabledError,
    );
  });

  test.each([
    { status: 422, detail: "Invalid display name 'Reviewer'" },
    { status: 403, detail: "Permission denied: agents:write" },
  ])(
    "keeps an actionable $status detail for the caller",
    async ({ status, detail }) => {
      mockedFetch.mockResolvedValueOnce(jsonResponse(status, { detail }));

      const error = await createAgent(request).catch((reason) => reason);

      expect(error).toBeInstanceOf(AgentCreateRejectedError);
      expect(error.status).toBe(status);
      expect(error.detail).toBe(detail);
      expect(error.message).toBe(detail);
    },
  );

  test("flattens a pydantic 422 issue list into a readable detail", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [
          {
            type: "value_error",
            loc: ["body", "display_name"],
            msg: "Value error, Display name must not contain control characters",
          },
          { type: "missing", loc: ["body", "soul"], msg: "Field required" },
        ],
      }),
    );

    const error = await createAgent(request).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentCreateRejectedError);
    expect(error.detail).toBe(
      "Display name must not contain control characters; Field required",
    );
  });

  test("falls back when a 422 detail is not readable", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { unexpected: "value" } }), {
        status: 422,
        statusText: "Unprocessable Entity",
      }),
    );

    const error = await createAgent(request).catch((reason) => reason);

    expect(error).toBeInstanceOf(AgentCreateRejectedError);
    expect(error.detail).toBeNull();
    expect(error.message).toBe("Failed to create agent: Unprocessable Entity");
  });

  test("reports an unexpected failure with the backend detail", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(500, { detail: "Failed to create agent" }),
    );

    await expect(createAgent(request)).rejects.toThrow(
      "Failed to create agent",
    );
  });
});

describe("updateAgent", () => {
  test("serializes per-agent model settings into the request body (issue #4336)", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        name: "researcher",
        description: "",
        model: "agent-model",
        tool_groups: null,
        skills: null,
        model_settings: { temperature: 0.2, max_tokens: 12000 },
        thinking_enabled: true,
        reasoning_effort: "high",
      }),
    );

    await updateAgent("researcher", {
      model: "agent-model",
      model_settings: { temperature: 0.2, max_tokens: 12000 },
      thinking_enabled: true,
      reasoning_effort: "high",
    });

    const [, init] = mockedFetch.mock.calls[0]!;
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      model: "agent-model",
      model_settings: { temperature: 0.2, max_tokens: 12000 },
      thinking_enabled: true,
      reasoning_effort: "high",
    });
  });

  test("serializes an explicit null subagent allowlist as unrestricted", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        name: "delegator",
        description: "",
        model: null,
        tool_groups: null,
        skills: null,
        allowed_subagents: null,
      }),
    );

    await updateAgent("delegator", { allowed_subagents: null });

    const [, init] = mockedFetch.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      allowed_subagents: null,
    });
  });
});

describe("agent portability", () => {
  const agentPackage = {
    format: "deerflow.custom-agent" as const,
    version: 1 as const,
    agent: {
      name: "research-lead",
      description: "Coordinates research",
      model: "agent-model",
      tool_groups: ["web"],
      skills: ["literature-review"],
      allowed_subagents: ["researcher"],
      soul: "Delegate and synthesize.",
    },
  };

  test("exports the versioned package", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, agentPackage));

    await expect(exportAgentPackage("research lead/unsafe")).resolves.toEqual(
      agentPackage,
    );
    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/agents/research%20lead%2Funsafe/export",
    );
  });

  test("imports the exact package with an optional target name", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(201, { ...agentPackage.agent, name: "research-copy" }),
    );

    await importAgentPackage(agentPackage, "research-copy");

    const [url, init] = mockedFetch.mock.calls[0]!;
    expect(url).toBe("/api/agents/import?name=research-copy");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(agentPackage);
  });

  test("surfaces explicit import conflicts from the backend", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: "Agent 'research-lead' already exists" }),
    );

    await expect(importAgentPackage(agentPackage)).rejects.toThrow(
      "Agent 'research-lead' already exists",
    );
  });

  test.each([
    {
      detail: [
        {
          type: "string_pattern_mismatch",
          loc: ["body", "agent", "name"],
          msg: "String should match pattern '^[A-Za-z0-9-]+$'",
          input: "research lead",
        },
      ],
      message: "String should match pattern '^[A-Za-z0-9-]+$'",
    },
    {
      detail: [
        {
          type: "literal_error",
          loc: ["body", "format"],
          msg: "Input should be 'deerflow.custom-agent'",
          input: "old-format",
        },
        {
          type: "extra_forbidden",
          loc: ["body", "agent", "github"],
          msg: "Extra inputs are not permitted",
          input: {},
        },
      ],
      message:
        "Input should be 'deerflow.custom-agent'; Extra inputs are not permitted",
    },
  ])(
    "surfaces package validation messages: $message",
    async ({ detail, message }) => {
      mockedFetch.mockResolvedValueOnce(jsonResponse(422, { detail }));

      await expect(importAgentPackage(agentPackage)).rejects.toMatchObject({
        message,
      });
    },
  );

  test("keeps readable validation messages when some entries are malformed", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: [null, { msg: 42 }, { msg: " " }, { msg: "Field required" }],
      }),
    );

    await expect(importAgentPackage(agentPackage)).rejects.toMatchObject({
      message: "Field required",
    });
  });

  test.each([
    null,
    { detail: { unexpected: "value" } },
    { detail: [] },
    { detail: [null, { msg: 42 }] },
    { detail: " " },
  ])(
    "falls back when an import error has no usable detail: %j",
    async (body) => {
      mockedFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 503,
          statusText: "Service Unavailable",
        }),
      );

      await expect(importAgentPackage(agentPackage)).rejects.toMatchObject({
        message: "Failed to import agent: Service Unavailable",
      });
    },
  );

  test("falls back when an import error body is not JSON", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    await expect(importAgentPackage(agentPackage)).rejects.toMatchObject({
      message: "Failed to import agent: Bad Gateway",
    });
  });
});
