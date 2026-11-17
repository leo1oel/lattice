/**
 * Settings › Plugins: install from a URL (a .zip and its SHA-256) or from a
 * folder (for developing one), and per plugin a card with what it may access,
 * a switch, its secrets and Remove. Turning a plugin on grants what it asks
 * for now, so the switch first shows those permissions in plain words; a
 * plugin whose update asks for more says so and asks again. The GPUI app's
 * pane is the same (gpui/docs/).
 */
import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmAction, hostErrorMessage } from "../app-utils";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { Switch } from "../components/ui/switch";
import { hostErrorText } from "../platform/host-error-text";
import {
  installPluginFolder, installPluginUrl, listPlugins, PLUGINS_CHANGED_EVENT, removePlugin, setPluginEnabled, setPluginSecret,
  type PluginInfo, type PluginList,
} from "./plugin-ipc";
import { permissionLines } from "./plugin-text";
import "./plugins.css";

/** Asks before a plugin is granted what it asks for now. */
function PermissionDialog({ plugin, busy, onCancel, onConfirm }: {
  plugin: PluginInfo;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  const describedBy = useId();
  const name = plugin.name;
  return (
    <ModalDialog label={t`Turn on ${name}?`} describedBy={describedBy} onClose={onCancel}>
      <div className="modal confirm-action-modal plugin-permission-modal">
        <h2>{t`Turn on ${name}?`}</h2>
        <p id={describedBy}>{t`It will be able to:`}</p>
        <ul className="plugin-permissions">
          {permissionLines(plugin.permissions).map((line) => <li key={line}>{line}</li>)}
        </ul>
        <div className="modal-actions">
          <Button variant="ghost" autoFocus onClick={onCancel} disabled={busy}>{t`Cancel`}</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{t`Turn on`}</Button>
        </div>
      </div>
    </ModalDialog>
  );
}

function SecretField({ plugin, name, saved, disabled, onSave }: {
  plugin: PluginInfo;
  name: string;
  saved: boolean;
  disabled: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useReducer((_: string, next: string) => next, "");
  const id = `plugin-${plugin.id}-secret-${name}`;
  return (
    <form className="plugin-secret" onSubmit={(event) => {
      event.preventDefault();
      void onSave(draft.trim()).then((done) => { if (done) setDraft(""); });
    }}>
      <SettingsRow label={name} htmlFor={id} description={saved ? t`Saved` : t`Not saved`} />
      <div className="plugin-secret-controls">
        <Input id={id} type="password" autoComplete="off" spellCheck={false} maxLength={16384} disabled={disabled}
          placeholder={saved ? t`Enter a replacement` : t`Paste the value`}
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button size="compact" type="submit" disabled={disabled || !draft.trim()}>{t`Save`}</Button>
        <Button size="compact" variant="ghost" disabled={disabled || !saved} onClick={() => void onSave(null)}>{t`Clear`}</Button>
      </div>
    </form>
  );
}

function PluginCard({ plugin, available, busy, error, onToggle, onReview, onSecret, onRemove }: {
  plugin: PluginInfo;
  available: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onReview: () => void;
  onSecret: (name: string, value: string | null) => Promise<boolean>;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const source = plugin.source.kind === "url" ? plugin.source.url : plugin.source.path;
  const license = plugin.license;
  const name = plugin.name;
  return (
    <SettingsGroup className="plugin-card" data-plugin={plugin.id} title={<>{plugin.name} <span className="plugin-card-version">{plugin.version}</span></>}>
      <div className="plugin-card-head">
        <div className="plugin-card-copy">
          <span className="plugin-card-id">{plugin.id}</span>
          {plugin.description && <p className="plugin-card-description">{plugin.description}</p>}
          <p className="plugin-card-meta">
            <span>{t`Licence: ${license}`}</span>
            <span className="plugin-card-source" title={source}>{plugin.source.kind === "url" ? t`From ${source}` : t`Folder ${source}`}</span>
          </p>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={!available || busy}
          label={plugin.enabled ? t`Turn off ${name}` : t`Turn on ${name}`}
          onChange={onToggle}
        />
      </div>
      {plugin.needsReview && (
        <div className="plugin-card-review">
          <InlineMessage level="warning">{t`Asks for new permissions`}</InlineMessage>
          <Button size="compact" variant="secondary" disabled={!available || busy} onClick={onReview}>{t`Review…`}</Button>
        </div>
      )}
      <div className="plugin-card-permissions">
        <span className="plugin-card-label">{t`Access`}</span>
        <ul className="plugin-permissions">
          {permissionLines(plugin.permissions).map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      {plugin.secrets.map((secret) => (
        <SecretField key={secret.name} plugin={plugin} name={secret.name} saved={secret.saved} disabled={busy}
          onSave={(value) => onSecret(secret.name, value)} />
      ))}
      {plugin.error && <InlineMessage level="error">{hostErrorText(plugin.error)}</InlineMessage>}
      {error && <InlineMessage level="error">{error}</InlineMessage>}
      <div className="plugin-card-actions">
        <Button size="compact" variant="ghost" disabled={busy} onClick={onRemove}>{t`Remove`}</Button>
      </div>
    </SettingsGroup>
  );
}

type PaneState = {
  list: PluginList | null;
  loadError: string | null;
  /** The change under way: `install`, or the id of the plugin it is for. */
  busy: string | null;
  /** A failed change's message, on the card it was for. */
  cardErrors: Readonly<Record<string, string>>;
  urlForm: { url: string; sha256: string } | null;
  installError: string | null;
  /** The plugin whose permissions the writer is being asked to grant. */
  asking: PluginInfo | null;
};
type PaneAction =
  | { type: "loaded"; list: PluginList }
  | { type: "loadFailed"; error: string }
  | { type: "start"; target: string }
  | { type: "done"; target: string; error: string | null }
  | { type: "urlForm"; form: PaneState["urlForm"] }
  | { type: "installError"; error: string | null }
  | { type: "ask"; plugin: PluginInfo | null };

function reducePane(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case "loaded": return { ...state, list: action.list, loadError: null };
    case "loadFailed": return { ...state, loadError: action.error };
    case "start": {
      const cardErrors = Object.fromEntries(Object.entries(state.cardErrors).filter(([id]) => id !== action.target));
      return { ...state, busy: action.target, cardErrors, installError: action.target === "install" ? null : state.installError };
    }
    case "done":
      if (action.target === "install") {
        return { ...state, busy: null, installError: action.error, urlForm: action.error ? state.urlForm : null };
      }
      return { ...state, busy: null, cardErrors: action.error ? { ...state.cardErrors, [action.target]: action.error } : state.cardErrors };
    case "urlForm": return { ...state, urlForm: action.form, installError: null };
    case "installError": return { ...state, installError: action.error };
    case "ask": return { ...state, asking: action.plugin };
  }
}

const INITIAL_PANE: PaneState = { list: null, loadError: null, busy: null, cardErrors: {}, urlForm: null, installError: null, asking: null };

export function PluginSettings() {
  const { t } = useLingui();
  const [{ list, loadError, busy, cardErrors, urlForm, installError, asking }, dispatch] = useReducer(reducePane, INITIAL_PANE);
  const activeRef = useRef(true);

  const reload = useCallback(() => {
    void listPlugins().then((next) => {
      if (activeRef.current) dispatch({ type: "loaded", list: next });
    }, (reason: unknown) => {
      if (activeRef.current) dispatch({ type: "loadFailed", error: hostErrorMessage(reason) });
    });
  }, []);
  useEffect(() => {
    activeRef.current = true;
    reload();
    const unsubscribe = subscribeTauriEvent<unknown>(PLUGINS_CHANGED_EVENT, reload);
    return () => {
      activeRef.current = false;
      unsubscribe();
    };
  }, [reload]);

  /**
   * Run one change at a time (`target` is `install` or a plugin's id); its
   * failure shows under the install form or on the card it was for.
   */
  async function change(target: string, action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    dispatch({ type: "start", target });
    let error: string | null = null;
    try {
      await action();
    } catch (reason) {
      error = hostErrorMessage(reason);
    }
    if (activeRef.current) {
      dispatch({ type: "done", target, error });
      reload();
    }
    return error === null;
  }

  async function chooseFolder() {
    const path = await open({ directory: true, multiple: false }).catch((reason: unknown) => {
      dispatch({ type: "installError", error: hostErrorMessage(reason) });
      return null;
    });
    if (typeof path === "string") await change("install", () => installPluginFolder(path));
  }

  const available = list?.available ?? true;
  const plugins = list?.plugins ?? [];
  const urlValid = urlForm !== null && urlForm.url.trim() !== "" && /^[0-9a-f]{64}$/i.test(urlForm.sha256.trim());

  return (
    <div className="settings-section plugin-settings" aria-busy={busy !== null || list === null}>
      <SettingsSectionHeader title={t`Plugins`} />
      <p className="plugin-settings-intro">
        {t`Plugins add commands to the command palette (⌘K). Each runs in a sandbox and can reach only what you allow when you turn it on.`}
      </p>
      {!available && (
        <InlineMessage level="warning">{t`Plugins run only on macOS for now. They are listed here, but can’t be turned on.`}</InlineMessage>
      )}
      <SettingsGroup title={t`Install`}>
        <SettingsRow data-setting="plugins-install-url" label={t`Install from URL…`}
          description={t`A plugin’s .zip release over https, checked against the SHA-256 its author publishes.`}>
          <Button size="compact" variant="secondary" disabled={busy !== null}
            onClick={() => dispatch({ type: "urlForm", form: urlForm ? null : { url: "", sha256: "" } })}>
            {t`Install from URL…`}
          </Button>
        </SettingsRow>
        {urlForm && (
          <form className="plugin-install-form" onSubmit={(event) => {
            event.preventDefault();
            if (urlValid) void change("install", () => installPluginUrl(urlForm.url.trim(), urlForm.sha256.trim()));
          }}>
            <Input aria-label={t`Plugin URL`} placeholder={t`Link to the .zip (https://…)`} autoFocus spellCheck={false} disabled={busy !== null}
              value={urlForm.url} onChange={(event) => dispatch({ type: "urlForm", form: { ...urlForm, url: event.target.value } })} />
            <Input aria-label={t`SHA-256 checksum`} placeholder={t`SHA-256 (64 hexadecimal characters)`} spellCheck={false} disabled={busy !== null}
              value={urlForm.sha256} onChange={(event) => dispatch({ type: "urlForm", form: { ...urlForm, sha256: event.target.value } })} />
            <Button size="compact" type="submit" variant="primary" disabled={busy !== null || !urlValid}>{t`Install`}</Button>
          </form>
        )}
        <SettingsRow data-setting="plugins-install-folder" label={t`Install from folder…`}
          description={t`For developing a plugin: Lattice runs the folder in place, so your edits apply on the next run.`}>
          <Button size="compact" variant="secondary" disabled={busy !== null} onClick={() => void chooseFolder()}>{t`Choose folder…`}</Button>
        </SettingsRow>
      </SettingsGroup>
      {installError && <InlineMessage level="error">{installError}</InlineMessage>}
      {loadError && <InlineMessage level="error">{loadError}</InlineMessage>}
      {list && plugins.length === 0 && <p className="plugin-settings-empty">{t`No plugins installed.`}</p>}
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          plugin={plugin}
          available={available}
          busy={busy !== null}
          error={cardErrors[plugin.id] ?? null}
          onToggle={(enabled) => {
            if (enabled) dispatch({ type: "ask", plugin });
            else void change(plugin.id, () => setPluginEnabled(plugin.id, false));
          }}
          onReview={() => dispatch({ type: "ask", plugin })}
          onSecret={(name, value) => change(plugin.id, () => setPluginSecret(plugin.id, name, value))}
          onRemove={() => {
            const name = plugin.name;
            void confirmAction({
              title: t`Remove ${name}?`,
              message: t`Its commands leave the palette, and its data and saved secrets are deleted.`,
              confirmLabel: t`Remove`,
              destructive: true,
            }).then((confirmed) => { if (confirmed) void change(plugin.id, () => removePlugin(plugin.id)); });
          }}
        />
      ))}
      {asking && (
        <PermissionDialog
          plugin={asking}
          busy={busy !== null}
          onCancel={() => dispatch({ type: "ask", plugin: null })}
          onConfirm={() => {
            const plugin = asking;
            dispatch({ type: "ask", plugin: null });
            void change(plugin.id, () => setPluginEnabled(plugin.id, true));
          }}
        />
      )}
    </div>
  );
}
