import { useEffect, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { InlineMessage, type InlineMessageLevel } from "../components/ui/inline-message";
import { InfinityLoader } from "../components/ui/activity-icons";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { SettingsSelect } from "./settings-controls";
import { restartAgentRuntime } from "../agent/agent-environment";
import type { SettingsTab } from "../app-types";
import { toMessage } from "../app-utils";
import { describeProbe, type ProbeReport, PROBE_CHECKS } from "./model-endpoint-probe";
import "./model-endpoint-settings.css";

/** Pi's API names (`src-tauri/src/model_endpoint.rs`). */
type Protocol = "openai-completions" | "anthropic-messages" | "openai-responses" | "google-generative-ai";
type EndpointModel = { id: string; contextWindow: number; maxTokens: number; images: boolean };
type Endpoint = { protocol: Protocol; baseUrl: string; models: EndpointModel[] };
/** `get_model_endpoint`: the key itself never comes back, only whether one is saved. */
type EndpointStatus = { endpoint: Endpoint | null; keySaved: boolean };
type KeyUpdate = { action: "keep" } | { action: "replace"; value: string } | { action: "remove" };

/** Typed numbers stay text until saved, so a half-typed field is not reset. */
type ModelDraft = { id: string; contextWindow: string; maxTokens: string; images: boolean };
type Draft = { protocol: Protocol; baseUrl: string; key: string; models: ModelDraft[] };
type Busy = "load" | "save" | "test" | "remove" | "restart";
type Notice = { level: InlineMessageLevel; text: string; restart?: boolean };

type State = {
  saved: EndpointStatus | null;
  draft: Draft;
  /** Shows the Responses and Gemini protocols. */
  advanced: boolean;
  busy: Busy | null;
  notice: Notice | null;
  report: ProbeReport | null;
};

type Action =
  | { type: "loaded"; status: EndpointStatus }
  | { type: "edit"; draft: Partial<Draft> }
  | { type: "model"; index: number; model: Partial<ModelDraft> }
  | { type: "add-model" }
  | { type: "remove-model"; index: number }
  | { type: "advanced"; on: boolean }
  | { type: "busy"; busy: Busy }
  | { type: "done"; notice: Notice | null; status?: EndpointStatus }
  | { type: "tested"; report: ProbeReport };

// Pi's own defaults for a model that does not say.
const NEW_MODEL: ModelDraft = { id: "", contextWindow: "128000", maxTokens: "16384", images: false };
const ADVANCED: readonly Protocol[] = ["openai-responses", "google-generative-ai"];
/* eslint-disable lingui/no-unlocalized-strings -- API names, the same in every language */
const ADVANCED_NAMES: Partial<Record<Protocol, string>> = {
  "openai-responses": "OpenAI Responses",
  "google-generative-ai": "Google Gemini",
};
/* eslint-enable lingui/no-unlocalized-strings */
const PLACEHOLDERS: Record<Protocol, string> = {
  "openai-completions": "https://api.example.com/v1",
  "anthropic-messages": "https://api.example.com",
  "openai-responses": "https://api.example.com/v1",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

function draftOf(endpoint: Endpoint | null): Draft {
  if (!endpoint) return { protocol: "openai-completions", baseUrl: "", key: "", models: [NEW_MODEL] };
  return {
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    key: "",
    models: endpoint.models.map((model) => ({
      id: model.id,
      contextWindow: String(model.contextWindow),
      maxTokens: String(model.maxTokens),
      images: model.images,
    })),
  };
}

function reduce(state: State, action: Action): State {
  const { draft } = state;
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        saved: action.status,
        draft: draftOf(action.status.endpoint),
        advanced: ADVANCED.includes(action.status.endpoint?.protocol ?? "openai-completions"),
        busy: null,
      };
    case "edit": return { ...state, draft: { ...draft, ...action.draft }, notice: null, report: null };
    case "model": {
      const models = draft.models.map((model, index) => (index === action.index ? { ...model, ...action.model } : model));
      return { ...state, draft: { ...draft, models }, notice: null, report: null };
    }
    case "add-model": return { ...state, draft: { ...draft, models: [...draft.models, NEW_MODEL] } };
    case "remove-model":
      return { ...state, draft: { ...draft, models: draft.models.filter((_, index) => index !== action.index) } };
    case "advanced": return { ...state, advanced: action.on };
    case "busy": return { ...state, busy: action.busy, notice: null, report: action.busy === "test" ? null : state.report };
    case "done": {
      if (!action.status) return { ...state, busy: null, notice: action.notice };
      return { ...state, busy: null, notice: action.notice, saved: action.status, draft: draftOf(action.status.endpoint) };
    }
    case "tested": return { ...state, busy: null, report: action.report };
  }
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/** The draft as `save_model_endpoint` takes it, or null when a limit is not a whole number. */
function endpointOf(draft: Draft): Endpoint | null {
  const models: EndpointModel[] = [];
  for (const model of draft.models) {
    const contextWindow = Number(model.contextWindow);
    const maxTokens = Number(model.maxTokens);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens)) return null;
    models.push({ id: model.id, contextWindow, maxTokens, images: model.images });
  }
  return { protocol: draft.protocol, baseUrl: draft.baseUrl, models };
}

/**
 * Settings › Agent › Model endpoint (issue #825): the writer's own API,
 * which Synara's Pi provider drives with no CLI installed. The key goes to
 * the keychain from here and is never read back; Lattice writes Pi's
 * configuration and restarts the agent so it takes effect.
 */
export function ModelEndpointSettings(props: { openTab: (tab: SettingsTab) => void }) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(reduce, {
    saved: null, draft: draftOf(null), advanced: false, busy: "load", notice: null, report: null,
  });
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    invoke<EndpointStatus>("get_model_endpoint").then(
      (status) => { if (active.current) dispatch({ type: "loaded", status }); },
      () => {
        if (!active.current) return;
        dispatch({ type: "loaded", status: { endpoint: null, keySaved: false } });
        dispatch({ type: "done", notice: { level: "error", text: t`Couldn’t read the endpoint settings. Reopen Settings to retry` } });
      },
    );
    return () => { active.current = false; };
  }, [t]);

  /**
   * The agent reads Pi's configuration when it starts. A restart stops every
   * window's running turns, so while one runs it is offered, not made.
   */
  const applied = async (status: EndpointStatus, text: string) => {
    const { agentTurns } = await invoke<{ agentTurns: number }>("restart_impact");
    if (agentTurns) {
      const restart = t`The agent uses it after a restart, which would stop the turn running now.`;
      return dispatch({ type: "done", status, notice: { level: "warning", text: `${text} ${restart}`, restart: true } });
    }
    await restartAgentRuntime();
    dispatch({ type: "done", status, notice: { level: "success", text } });
  };

  const run = async (busy: Busy, action: () => Promise<void>) => {
    if (state.busy) return;
    dispatch({ type: "busy", busy });
    try {
      await action();
    } catch (reason) {
      // The host's own messages: validation or the keychain, never the key.
      if (active.current) dispatch({ type: "done", notice: { level: "error", text: toMessage(reason) } });
    }
  };

  const save = (key: KeyUpdate) => run("save", async () => {
    const endpoint = endpointOf(state.draft);
    if (!endpoint) return dispatch({ type: "done", notice: { level: "error", text: t`Token limits must be whole numbers.` } });
    const status = await invoke<EndpointStatus>("save_model_endpoint", { endpoint, key });
    // The picker lists the models under Pi, grouped by the address's host.
    const host = hostOf(status.endpoint?.baseUrl);
    if (active.current) await applied(status, t`Saved. In the Agent panel’s model menu, open Pi and choose a model under ${host}.`);
  });
  const remove = () => run("remove", async () => {
    const status = await invoke<EndpointStatus>("remove_model_endpoint");
    if (active.current) await applied(status, t`Endpoint removed.`);
  });
  const test = () => run("test", async () => {
    const endpoint = endpointOf(state.draft);
    if (!endpoint) return dispatch({ type: "done", notice: { level: "error", text: t`Token limits must be whole numbers.` } });
    const report = await invoke<ProbeReport>("test_model_endpoint", { endpoint, key: state.draft.key.trim() || null });
    if (active.current) dispatch({ type: "tested", report });
  });
  const restart = () => run("restart", async () => {
    await restartAgentRuntime();
    if (active.current) dispatch({ type: "done", notice: { level: "success", text: t`The agent restarted with the endpoint.` } });
  });

  const { draft, saved, busy, report } = state;
  const disabled = busy !== null;
  const keyText = draft.key.trim();
  const keyUpdate: KeyUpdate = keyText ? { action: "replace", value: keyText } : { action: "keep" };
  const protocols: Partial<Record<Protocol, string>> = {
    "openai-completions": t`OpenAI-compatible`,
    "anthropic-messages": t`Anthropic-compatible`,
    ...(state.advanced ? ADVANCED_NAMES : {}),
  };
  const addressHelp: Record<Protocol, string> = {
    "openai-completions": t`The address before /chat/completions, often ending in /v1.`,
    "anthropic-messages": t`The address before /v1/messages.`,
    "openai-responses": t`The address before /responses, often ending in /v1.`,
    "google-generative-ai": t`The address before /models, with its API version.`,
  };
  const probe = report ? describeProbe(report) : null;
  const detail = report?.detail;

  return (
    <div className="settings-section model-endpoint-settings" aria-busy={busy !== null}>
      <SettingsSectionHeader
        title={t`Model endpoint`}
        description={t`Use your own OpenAI- or Anthropic-compatible API with an address, a key and model names. The agent runs it through Pi, with no command-line tool to install.`}
      />
      {busy === "load" && <InfinityLoader size={16} />}
      <SettingsGroup title={t`Before you start`} data-setting="model-endpoint-limits">
        <InlineMessage level="info">
          {t`Pi doesn’t ask before editing, whatever permission mode you choose. Each edit is checkpointed so you can undo it, and .bib files stay protected.`}
        </InlineMessage>
        <InlineMessage level="info">
          {t`Proofread, Polish and revision requests still need Claude Code or Codex for now.`}
        </InlineMessage>
        <SettingsRow
          label={t`Pi runtime`}
          description={t`Pi is a one-time download of about 150 MB. Install it under Providers › Pi.`}
          data-setting="model-endpoint-runtime"
        >
          <Button size="compact" variant="secondary" onClick={() => props.openTab("agent")}>{t`Open Providers`}</Button>
        </SettingsRow>
      </SettingsGroup>
      <form
        className="model-endpoint-form"
        onSubmit={(event) => { event.preventDefault(); void save(keyUpdate); }}
      >
        <SettingsGroup title={t`Endpoint`} data-setting="model-endpoint-address">
          <SettingsRow label={t`Protocol`} description={t`How the endpoint expects requests.`}>
            <SettingsSelect
              label={t`Protocol`}
              value={draft.protocol}
              options={protocols as Record<Protocol, string>}
              onChange={(protocol) => dispatch({ type: "edit", draft: { protocol } })}
            />
          </SettingsRow>
          <SwitchField
            label={t`More protocols`}
            description={Object.values(ADVANCED_NAMES).join(", ")}
            checked={state.advanced}
            disabled={ADVANCED.includes(draft.protocol)}
            onChange={(on) => dispatch({ type: "advanced", on })}
          />
          <SettingsRow label={t`Address`} htmlFor="model-endpoint-url" description={addressHelp[draft.protocol]} />
          <div className="model-endpoint-field">
            <Input
              id="model-endpoint-url" type="url" autoComplete="off" spellCheck={false} maxLength={2048} disabled={disabled}
              placeholder={PLACEHOLDERS[draft.protocol]} value={draft.baseUrl}
              onChange={(event) => dispatch({ type: "edit", draft: { baseUrl: event.target.value } })}
            />
          </div>
          <SettingsRow
            label={t`API key`}
            htmlFor="model-endpoint-key"
            description={saved?.keySaved ? t`Saved in the keychain. Enter a new one to replace it.` : t`Kept in the macOS keychain. Leave it empty for a local server that needs none.`}
            data-setting="model-endpoint-key"
          >
            {saved?.keySaved && (
              <Button size="compact" variant="ghost" disabled={disabled} onClick={() => void save({ action: "remove" })}>{t`Remove key`}</Button>
            )}
          </SettingsRow>
          <div className="model-endpoint-field">
            <Input
              id="model-endpoint-key" type="password" autoComplete="off" spellCheck={false} maxLength={16384} disabled={disabled}
              placeholder={saved?.keySaved ? t`Enter a replacement key` : t`Paste your API key`} value={draft.key}
              onChange={(event) => dispatch({ type: "edit", draft: { key: event.target.value } })}
            />
          </div>
        </SettingsGroup>
        <SettingsGroup title={t`Models`} data-setting="model-endpoint-models">
          <SettingsRow label={t`Models to offer`} description={t`Names as the endpoint spells them. Test connection tries the first.`}>
            <Button size="compact" variant="secondary" disabled={disabled || draft.models.length >= 16} onClick={() => dispatch({ type: "add-model" })}>
              <Plus size={13} /> {t`Add model`}
            </Button>
          </SettingsRow>
          <div className="model-endpoint-models">
            <div className="model-endpoint-model model-endpoint-model-head" aria-hidden="true">
              <span>{t`Model name`}</span>
              <span>{t`Context window`}</span>
              <span>{t`Max output`}</span>
              <span>{t`Images`}</span>
              <span />
            </div>
            {draft.models.map((model, index) => (
              <div className="model-endpoint-model" key={index}>
                <Input
                  aria-label={t`Model name`} autoComplete="off" spellCheck={false} maxLength={200} disabled={disabled}
                  placeholder={t`model-name`} value={model.id}
                  onChange={(event) => dispatch({ type: "model", index, model: { id: event.target.value } })}
                />
                <Input
                  aria-label={t`Context window`} inputMode="numeric" disabled={disabled} value={model.contextWindow}
                  onChange={(event) => dispatch({ type: "model", index, model: { contextWindow: event.target.value.trim() } })}
                />
                <Input
                  aria-label={t`Max output`} inputMode="numeric" disabled={disabled} value={model.maxTokens}
                  onChange={(event) => dispatch({ type: "model", index, model: { maxTokens: event.target.value.trim() } })}
                />
                <span className="model-endpoint-images">
                  <Checkbox
                    aria-label={t`Accepts images`} checked={model.images} disabled={disabled}
                    onChange={(event) => dispatch({ type: "model", index, model: { images: event.target.checked } })}
                  />
                </span>
                <span>
                  <IconButton
                    label={t`Remove model`} size="compact" disabled={disabled || draft.models.length === 1}
                    onClick={() => dispatch({ type: "remove-model", index })}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        </SettingsGroup>
        <div className="model-endpoint-actions">
          <Button size="compact" variant="primary" type="submit" disabled={disabled || !draft.baseUrl.trim()}>{t`Save`}</Button>
          <Button size="compact" variant="secondary" disabled={disabled || !draft.baseUrl.trim()} onClick={() => void test()}>
            {t`Test connection`}
          </Button>
          {saved?.endpoint && (
            <Button size="compact" variant="ghost" disabled={disabled} onClick={() => void remove()}>{t`Remove endpoint`}</Button>
          )}
          {busy && busy !== "load" && <InfinityLoader size={14} />}
        </div>
      </form>
      {busy === "test" && <p className="model-endpoint-hint">{t`Asking the first model to call a tool. This can take up to 45 seconds.`}</p>}
      {probe && (
        <div className="model-endpoint-report" data-ok={probe.ok || undefined}>
          <ul className="model-endpoint-checks" aria-label={t`Connection test`}>
            {PROBE_CHECKS.map((check) => {
              const passed = report?.passed.includes(check.id) ?? false;
              return (
                <li key={check.id} data-passed={passed || undefined}>
                  {passed ? <Check size={13} role="img" aria-label={t`Passed`} /> : <X size={13} role="img" aria-label={t`Not reached`} />}
                  <span>{t(check.label)}</span>
                </li>
              );
            })}
          </ul>
          <InlineMessage level={probe.ok ? "success" : "warning"}>{t(probe.message)}</InlineMessage>
          {detail && <p className="model-endpoint-detail">{t`The endpoint said: ${detail}`}</p>}
        </div>
      )}
      {state.notice && (
        <div className="model-endpoint-notice">
          <InlineMessage level={state.notice.level}>{state.notice.text}</InlineMessage>
          {state.notice.restart && (
            <Button size="compact" variant="secondary" disabled={disabled} onClick={() => void restart()}>{t`Restart agent`}</Button>
          )}
        </div>
      )}
    </div>
  );
}
