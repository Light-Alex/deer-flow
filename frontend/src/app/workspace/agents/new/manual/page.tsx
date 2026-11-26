"use client";

import { ArrowLeftIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentCapabilitySelection } from "@/components/workspace/agents/agent-capability-selection";
import {
  type AgentManualFormDraft,
  type AgentManualFormError,
  buildCreateAgentRequest,
  EMPTY_AGENT_MANUAL_DRAFT,
} from "@/components/workspace/agents/agent-manual-form-helpers";
import {
  DEFAULT_MODEL_VALUE,
  MAX_AGENT_OUTPUT_TOKENS,
} from "@/components/workspace/agents/agent-settings-dialog-helpers";
import { useCreateAgent } from "@/core/agents";
import {
  AgentAlreadyExistsError,
  AgentCreateRejectedError,
  AgentNameCheckError,
  AgentsApiDisabledError,
  checkAgentName,
} from "@/core/agents/api";
import { UnauthorizedError } from "@/core/api/errors";
import { useI18n } from "@/core/i18n/hooks";
import { useModels } from "@/core/models/hooks";
import { cn } from "@/lib/utils";

type FormField =
  | "name"
  | "display_name"
  | "soul"
  | "temperature"
  | "max_tokens";

interface FieldError {
  field: FormField;
  message: string;
}

const FIELD_BY_DRAFT_KEY: Partial<
  Record<keyof AgentManualFormDraft, FormField>
> = {
  name: "name",
  displayName: "display_name",
  soul: "soul",
  temperature: "temperature",
  maxTokens: "max_tokens",
};

export default function NewManualAgentPage() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    models,
    error: modelsError,
    isFetching: modelsFetching,
    refetch: refetchModels,
  } = useModels();
  const create = useCreateAgent();

  const [draft, setDraft] = useState<AgentManualFormDraft>(() => ({
    ...EMPTY_AGENT_MANUAL_DRAFT,
    name: searchParams.get("name") ?? "",
  }));
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  // Covers the availability check too: a double click before the mutation
  // starts would otherwise send two creates and 409 the second one.
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || create.isPending;
  // Each submit gets a generation; leaving the page or starting another submit
  // invalidates callbacks that would otherwise create an agent or navigate.
  const submitGeneration = useRef(0);
  useEffect(
    () => () => {
      submitGeneration.current += 1;
    },
    [],
  );

  const nameRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const soulRef = useRef<HTMLTextAreaElement>(null);
  const temperatureRef = useRef<HTMLInputElement>(null);
  const maxTokensRef = useRef<HTMLInputElement>(null);

  function setDraftValue<K extends keyof AgentManualFormDraft>(
    key: K,
    value: AgentManualFormDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    // Drop an error about this field as soon as its value changes; an error
    // about another field stays until that field is edited too.
    setFieldError((current) =>
      FIELD_BY_DRAFT_KEY[key] === current?.field ? null : current,
    );
  }

  function focusField(field: FormField) {
    switch (field) {
      case "name":
        nameRef.current?.focus();
        return;
      case "display_name":
        displayNameRef.current?.focus();
        return;
      case "soul":
        soulRef.current?.focus();
        return;
      case "temperature":
        temperatureRef.current?.focus();
        return;
      case "max_tokens":
        maxTokensRef.current?.focus();
    }
  }

  function errorFor(error: AgentManualFormError): FieldError {
    switch (error) {
      case "name_required":
        return { field: "name", message: t.agents.nameRequiredError };
      case "name_invalid":
        return { field: "name", message: t.agents.nameStepInvalidError };
      case "display_name_too_long":
        return {
          field: "display_name",
          message: t.agents.settingsDisplayNameTooLong,
        };
      case "soul_required":
        return { field: "soul", message: t.agents.soulRequiredError };
      case "temperature":
        return {
          field: "temperature",
          message: t.agents.settingsInvalidTemperature,
        };
      case "max_tokens":
        return {
          field: "max_tokens",
          message: t.agents.settingsInvalidMaxTokens,
        };
    }
  }

  function showError(error: AgentManualFormError) {
    const next = errorFor(error);
    setFieldError(next);
    focusField(next.field);
  }

  function focusAfterSubmit(field: FormField) {
    // The form is disabled while the request runs; wait for it to re-enable.
    window.setTimeout(() => focusField(field), 0);
  }

  async function handleCreate() {
    if (busy) return;

    const built = buildCreateAgentRequest(draft);
    if (!built.ok) {
      showError(built.error);
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    const generation = ++submitGeneration.current;
    try {
      // The create endpoint is the authority on conflicts; the check keeps the
      // common case an inline field error instead of a failed create.
      try {
        const check = await checkAgentName(built.request.name);
        if (submitGeneration.current !== generation) return;
        if (!check.available) {
          setFieldError({
            field: "name",
            message: t.agents.nameStepAlreadyExistsError,
          });
          focusAfterSubmit("name");
          return;
        }
      } catch (err) {
        if (submitGeneration.current !== generation) return;
        if (err instanceof AgentsApiDisabledError) {
          toast.error(t.agents.featureDisabledDescription);
        } else if (err instanceof AgentNameCheckError) {
          setFieldError({
            field: "name",
            message:
              err.reason === "backend_unreachable"
                ? t.agents.nameStepNetworkError
                : err.detail
                  ? t.agents.nameStepCheckErrorWithDetail.replace(
                      "{detail}",
                      err.detail,
                    )
                  : t.agents.nameStepCheckError,
          });
          focusAfterSubmit("name");
        } else {
          setFieldError({
            field: "name",
            message: t.agents.nameStepCheckError,
          });
          focusAfterSubmit("name");
        }
        return;
      }

      try {
        await create.mutateAsync(built.request);
        if (submitGeneration.current !== generation) return;
        toast.success(t.agents.agentCreated);
        // replace: Back must not return to a form whose name now exists.
        router.replace("/workspace/agents");
      } catch (err) {
        if (submitGeneration.current !== generation) return;
        if (err instanceof AgentAlreadyExistsError) {
          setFieldError({
            field: "name",
            message: t.agents.nameStepAlreadyExistsError,
          });
          focusAfterSubmit("name");
        } else if (err instanceof AgentsApiDisabledError) {
          toast.error(t.agents.featureDisabledDescription);
        } else if (err instanceof AgentCreateRejectedError) {
          // 422 / 403: the Gateway's detail names the fixable cause.
          toast.error(err.detail ?? t.agents.createFailed);
        } else if (err instanceof UnauthorizedError) {
          // The API fetcher already navigated to the login page.
        } else {
          toast.error(t.agents.createFailed);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  const displayNameLength = [...draft.displayName.trim()].length;

  return (
    <div className="flex size-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.agents.backToGallery}
          onClick={() => router.push("/workspace/agents")}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </Button>
        <h1 className="text-sm font-semibold">{t.agents.manualCreateTitle}</h1>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-6">
          <p className="text-muted-foreground text-sm">
            {t.agents.manualCreateIntro}
          </p>

          <section className="space-y-4">
            <h2 className="text-base font-semibold">
              {t.agents.sectionBasics}
            </h2>

            <div className="space-y-1.5">
              <label
                htmlFor="agent-manual-name"
                className="text-sm font-medium"
              >
                {t.agents.nameLabel}
              </label>
              <Input
                id="agent-manual-name"
                ref={nameRef}
                autoFocus
                autoComplete="off"
                disabled={busy}
                value={draft.name}
                aria-invalid={fieldError?.field === "name"}
                aria-describedby="agent-manual-name-hint"
                className={cn(
                  fieldError?.field === "name" && "border-destructive",
                )}
                onChange={(event) => setDraftValue("name", event.target.value)}
              />
              <p
                id="agent-manual-name-hint"
                className="text-muted-foreground text-xs"
              >
                {t.agents.nameStepHint}
              </p>
              {fieldError?.field === "name" && (
                <p role="alert" className="text-destructive text-sm">
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="agent-manual-display-name"
                className="text-sm font-medium"
              >
                {t.agents.settingsDisplayName}
              </label>
              <Input
                id="agent-manual-display-name"
                ref={displayNameRef}
                disabled={busy}
                value={draft.displayName}
                aria-invalid={fieldError?.field === "display_name"}
                aria-describedby="agent-manual-display-name-hint"
                onChange={(event) =>
                  setDraftValue("displayName", event.target.value)
                }
              />
              <p
                id="agent-manual-display-name-hint"
                className="text-muted-foreground text-xs"
              >
                {t.agents.settingsDisplayNameHint} ({displayNameLength}/100)
              </p>
              {fieldError?.field === "display_name" && (
                <p role="alert" className="text-destructive text-sm">
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="agent-manual-description"
                className="text-sm font-medium"
              >
                {t.agents.descriptionLabel}
              </label>
              <Textarea
                id="agent-manual-description"
                className="min-h-16"
                disabled={busy}
                placeholder={t.agents.descriptionPlaceholder}
                aria-describedby="agent-manual-description-hint"
                value={draft.description}
                onChange={(event) =>
                  setDraftValue("description", event.target.value)
                }
              />
              <p
                id="agent-manual-description-hint"
                className="text-muted-foreground text-xs"
              >
                {t.agents.descriptionHint}
              </p>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-semibold">
              {t.agents.sectionPrompt}
            </h2>
            <Textarea
              ref={soulRef}
              className={cn(
                "max-h-[60vh] min-h-64",
                fieldError?.field === "soul" && "border-destructive",
              )}
              disabled={busy}
              aria-label={t.agents.soulLabel}
              aria-invalid={fieldError?.field === "soul"}
              aria-describedby="agent-manual-soul-hint"
              placeholder={t.agents.soulPlaceholder}
              value={draft.soul}
              onChange={(event) => setDraftValue("soul", event.target.value)}
            />
            <p
              id="agent-manual-soul-hint"
              className="text-muted-foreground text-xs"
            >
              {t.agents.soulHint}
            </p>
            {fieldError?.field === "soul" && (
              <p role="alert" className="text-destructive text-sm">
                {fieldError.message}
              </p>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-base font-semibold">{t.agents.sectionModel}</h2>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">
                {t.agents.settingsModel}
              </span>
              <Select
                value={draft.model}
                onValueChange={(value) => setDraftValue("model", value)}
                disabled={busy}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t.agents.settingsModel}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_MODEL_VALUE}>
                    {t.agents.settingsModelDefault}
                  </SelectItem>
                  {models.map((model) => (
                    <SelectItem key={model.name} value={model.name}>
                      {model.display_name || model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelsError && (
                <div className="space-y-1.5">
                  <p role="alert" className="text-muted-foreground text-xs">
                    {t.workspace.modelLoadFailed}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={modelsFetching}
                    onClick={() => void refetchModels()}
                  >
                    {modelsFetching
                      ? t.workspace.modelLoadRetrying
                      : t.workspace.modelLoadRetry}
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="agent-manual-temperature"
                className="text-sm font-medium"
              >
                {t.agents.settingsTemperature}
              </label>
              <Input
                id="agent-manual-temperature"
                ref={temperatureRef}
                type="number"
                min={0}
                max={2}
                step={0.1}
                disabled={busy}
                value={draft.temperature}
                placeholder={t.agents.settingsInherit}
                aria-invalid={fieldError?.field === "temperature"}
                aria-describedby="agent-manual-temperature-hint"
                className={cn(
                  fieldError?.field === "temperature" && "border-destructive",
                )}
                onChange={(event) =>
                  setDraftValue("temperature", event.target.value)
                }
              />
              <p
                id="agent-manual-temperature-hint"
                className="text-muted-foreground text-xs"
              >
                {t.agents.settingsTemperatureHint}
              </p>
              {fieldError?.field === "temperature" && (
                <p role="alert" className="text-destructive text-sm">
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="agent-manual-max-tokens"
                className="text-sm font-medium"
              >
                {t.agents.settingsMaxTokens}
              </label>
              <Input
                id="agent-manual-max-tokens"
                ref={maxTokensRef}
                type="number"
                min={1}
                max={MAX_AGENT_OUTPUT_TOKENS}
                step={1}
                disabled={busy}
                value={draft.maxTokens}
                placeholder={t.agents.settingsMaxTokensPlaceholder}
                aria-invalid={fieldError?.field === "max_tokens"}
                className={cn(
                  fieldError?.field === "max_tokens" && "border-destructive",
                )}
                onChange={(event) =>
                  setDraftValue("maxTokens", event.target.value)
                }
              />
              {fieldError?.field === "max_tokens" && (
                <p role="alert" className="text-destructive text-sm">
                  {fieldError.message}
                </p>
              )}
            </div>
          </section>

          {/* Disabled while submitting: the request was built from the values
              visible when the click happened. */}
          <fieldset className="min-w-0" disabled={busy}>
            <AgentCapabilitySelection
              plugins={draft.plugins}
              skills={draft.skills}
              toolGroups={draft.toolGroups}
              onPluginsChange={(value) => setDraftValue("plugins", value)}
              onSkillsChange={(value) => setDraftValue("skills", value)}
              onToolGroupsChange={(value) => setDraftValue("toolGroups", value)}
            />
          </fieldset>
        </div>
      </main>

      <footer className="bg-background flex shrink-0 justify-end gap-2 border-t px-4 py-3">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => router.push("/workspace/agents")}
        >
          {t.common.cancel}
        </Button>
        <Button disabled={busy} onClick={() => void handleCreate()}>
          {busy ? t.agents.creating : t.agents.createSubmit}
        </Button>
      </footer>
    </div>
  );
}
