import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import NewManualAgentPage from "@/app/workspace/agents/new/manual/page";
import {
  AgentAlreadyExistsError,
  AgentCreateRejectedError,
} from "@/core/agents/api";
import { I18nContext } from "@/core/i18n/context";
import { enUS } from "@/core/i18n/locales/en-US";

const mocks = rs.hoisted(() => ({
  mutateAsync: rs.fn(),
  checkAgentName: rs.fn(),
  routerPush: rs.fn(),
  routerReplace: rs.fn(),
  toastSuccess: rs.fn(),
  toastError: rs.fn(),
  searchParams: new URLSearchParams(),
}));

rs.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: mocks.routerReplace,
  }),
  useSearchParams: () => mocks.searchParams,
}));
rs.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
rs.mock("@/core/agents", () => ({
  useCreateAgent: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useAgentToolGroups: () => ({ toolGroups: [], isLoading: false, error: null }),
}));
rs.mock("@/core/agents/api", () => ({
  ...rs.requireActual("@/core/agents/api"),
  checkAgentName: mocks.checkAgentName,
}));
rs.mock("@/core/models/hooks", () => ({
  useModels: () => ({
    models: [],
    error: null,
    isFetching: false,
    refetch: rs.fn(),
  }),
}));
rs.mock("@/core/capabilities/hooks", () => ({
  useCapabilityInstallations: () => ({
    data: { items: [], can_manage: false },
    isLoading: false,
    isError: false,
  }),
}));
rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({ t: enUS, locale: "en-US" }),
}));

function renderPage() {
  return render(
    <I18nContext.Provider
      value={{ locale: "en-US", setLocale: () => undefined, t: enUS }}
    >
      <NewManualAgentPage />
    </I18nContext.Provider>,
  );
}

function createButton() {
  return screen.getByRole("button", { name: enUS.agents.createSubmit });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fill(options: { soul?: string } = {}) {
  if (options.soul !== undefined) {
    fireEvent.change(
      screen.getByRole("textbox", { name: enUS.agents.soulLabel }),
      { target: { value: options.soul } },
    );
  }
}

beforeEach(() => {
  mocks.mutateAsync.mockReset().mockResolvedValue({});
  mocks.checkAgentName
    .mockReset()
    .mockResolvedValue({ available: true, name: "code-reviewer" });
  mocks.routerPush.mockReset();
  mocks.routerReplace.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.searchParams = new URLSearchParams("name=code-reviewer");
});

afterEach(cleanup);

describe("manual agent creation", () => {
  it("prefills the name carried over from the name step", () => {
    renderPage();

    expect(
      screen.getByLabelText<HTMLInputElement>(enUS.agents.nameLabel).value,
    ).toBe("code-reviewer");
  });

  it("blocks submit without a system prompt and focuses the field", async () => {
    renderPage();

    await waitFor(() => expect(createButton()).toBeTruthy());
    fireEvent.click(createButton());

    expect(await screen.findByText(enUS.agents.soulRequiredError)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: enUS.agents.soulLabel })).toBe(
      document.activeElement,
    );
    expect(mocks.checkAgentName).not.toHaveBeenCalled();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("creates the agent with the mapped request and returns to the gallery", async () => {
    renderPage();
    await fill({ soul: "You review code." });
    fireEvent.change(screen.getByLabelText(enUS.agents.settingsTemperature), {
      target: { value: "0.3" },
    });

    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.routerReplace).toHaveBeenCalledWith("/workspace/agents"),
    );
    expect(mocks.checkAgentName).toHaveBeenCalledWith("code-reviewer");
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      name: "code-reviewer",
      display_name: null,
      description: "",
      soul: "You review code.",
      model: null,
      model_settings: { temperature: 0.3, max_tokens: null },
      tool_groups: null,
      skills: null,
      mcp_plugins: null,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(enUS.agents.agentCreated);
  });

  it("does not create when the name is already taken", async () => {
    mocks.checkAgentName.mockResolvedValue({
      available: false,
      name: "code-reviewer",
    });
    renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());

    expect(
      await screen.findByText(enUS.agents.nameStepAlreadyExistsError),
    ).toBeTruthy();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("surfaces a create-time conflict on the name field", async () => {
    mocks.mutateAsync.mockRejectedValue(
      new AgentAlreadyExistsError("Agent already exists"),
    );
    renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());

    expect(
      await screen.findByText(enUS.agents.nameStepAlreadyExistsError),
    ).toBeTruthy();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("keeps the localized failure message for an unexpected create error", async () => {
    mocks.mutateAsync.mockRejectedValue(new Error("boom"));
    renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(enUS.agents.createFailed),
    );
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("rejects an invalid name before asking the backend", async () => {
    mocks.searchParams = new URLSearchParams("name=code_reviewer");
    renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());

    expect(
      await screen.findByText(enUS.agents.nameStepInvalidError),
    ).toBeTruthy();
    expect(mocks.checkAgentName).not.toHaveBeenCalled();
  });

  it("shows the backend's actionable reason for a rejected create", async () => {
    mocks.mutateAsync.mockRejectedValue(
      new AgentCreateRejectedError(
        "Invalid display name",
        422,
        "Invalid display name",
      ),
    );
    renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Invalid display name"),
    );
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });

  it("does not create after the page unmounts during the availability check", async () => {
    const check = deferred<{ available: boolean; name: string }>();
    mocks.checkAgentName.mockReturnValue(check.promise);
    const view = renderPage();
    await fill({ soul: "You review code." });

    fireEvent.click(createButton());
    view.unmount();
    await act(async () => {
      check.resolve({ available: true, name: "code-reviewer" });
    });

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});
