/**
 * Settings › Plugins: Installed and Browse, one search field for whichever
 * shows. Installed lists each plugin as a card with where it came from (the
 * reviewed plugin list, a URL, or a folder), what it may access, a switch,
 * its secrets, any update the list offers and Remove; plugins also install
 * from a URL (a .zip and its SHA-256) or a folder (for developing one).
 * Browse is the plugin market (plugin-browse.tsx, plugin-details.tsx). Turning a plugin on grants what it asks
 * for now, so the switch first shows those permissions in plain words; a
 * plugin whose update asks for more says so and asks again. The GPUI app's
 * pane is the same (gpui/docs/).
 */
import { useCallback, useEffect, useId, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirmAction, hostErrorMessage } from "../app-utils";
import { PALETTE_KEY } from "../app/command-keys";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { comboText } from "../app/key-combos";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InlineMessage } from "../components/ui/inline-message";
import { ModalDialog } from "../components/ui/modal-dialog";
import { SearchField } from "../components/ui/search-field";
import { SegmentedControl } from "../components/ui/segmented-control";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { Switch } from "../components/ui/switch";
import { hostErrorText } from "../platform/host-error-text";
import {
  installPluginFolder, installPluginUrl, listPlugins, PLUGINS_CHANGED_EVENT, removePlugin, setPluginEnabled, setPluginSecret,
  type PluginInfo, type PluginList,
} from "./plugin-ipc";
import { type ListingLoad, PluginBrowse } from "./plugin-browse";
import { PluginDetailsSheet } from "./plugin-details";
import { asksNothing, installRegistryPlugin, matchesPluginQuery, pluginOffer, pluginRegistry, type PluginSort } from "./plugin-registry";
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
    // Opens over Settings, so it takes the confirmations' layer: on the
    // dialog layer its backdrop fell under the Settings card, which stayed
    // clickable and could change page beneath the question.
    <ModalDialog label={t`Turn on ${name}?`} describedBy={describedBy} onClose={onCancel} backdropClassName="confirm-action-backdrop">
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

function PluginCard({ plugin, available, busy, error, update, onToggle, onReview, onUpdate, onSecret, onRemove }: {
  plugin: PluginInfo;
  available: boolean;
  busy: boolean;
  error: string | null;
  /** The newer version the plugin list offers. */
  update: string | null;
  onToggle: (enabled: boolean) => void;
  onReview: () => void;
  onUpdate: () => void;
  onSecret: (name: string, value: string | null) => Promise<boolean>;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const source = plugin.source.kind === "folder" ? plugin.source.path : plugin.source.url;
  const license = plugin.license;
  const name = plugin.name;
  const tier = plugin.source.kind === "registry" ? t`Reviewed` : plugin.source.kind === "url" ? t`Not reviewed` : t`Developer`;
  const blocked = plugin.blocked;
  const turnedOff = blocked != null && blocked.action !== "warn";
  const reason = blocked?.reason ?? "";
  const blockUrl = blocked?.url;
  const next = update ?? "";
  const title = (
    <>
      {plugin.name} <span className="plugin-card-version">{plugin.version}</span>
      {" "}<span className="plugin-card-tier" data-tier={plugin.source.kind}>{tier}</span>
    </>
  );
  return (
    <SettingsGroup className="plugin-card" data-plugin={plugin.id} title={title}>
      <div className="plugin-card-head">
        <div className="plugin-card-copy">
          <span className="plugin-card-id">{plugin.id}</span>
          {plugin.description && <p className="plugin-card-description">{plugin.description}</p>}
          <p className="plugin-card-meta">
            <span>{t`Licence: ${license}`}</span>
            <span className="plugin-card-source" title={source}>{plugin.source.kind === "folder" ? t`Folder ${source}` : t`From ${source}`}</span>
          </p>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={!available || busy || (turnedOff && !plugin.enabled)}
          label={plugin.enabled ? t`Turn off ${name}` : t`Turn on ${name}`}
          onChange={onToggle}
        />
      </div>
      {blocked && (
        <InlineMessage level={turnedOff ? "error" : "warning"}>
          {turnedOff ? t`Lattice turned this plugin off: ${reason}` : t`This plugin has a warning: ${reason}`}
          {blockUrl && <>{" "}<button type="button" className="plugin-details-link" onClick={() => void openUrl(blockUrl)}>{t`Learn more`}</button></>}
        </InlineMessage>
      )}
      {update && (
        <div className="plugin-card-review">
          <InlineMessage level="info">{t`Version ${next} is available`}</InlineMessage>
          <Button size="compact" variant="tinted" disabled={busy} onClick={onUpdate}>{t`Update…`}</Button>
        </div>
      )}
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


type View = "installed" | "browse";

export function PluginSettings() {
  const { t } = useLingui();
  const [{ list, loadError, busy, cardErrors, urlForm, installError, asking }, dispatch] = useReducer(reducePane, INITIAL_PANE);
  const [view, setView] = useReducer((_: View, next: View) => next, "installed");
  const [query, setQuery] = useReducer((_: string, next: string) => next, "");
  const [sort, setSort] = useReducer((_: PluginSort, next: PluginSort) => next, "popular");
  const [details, setDetails] = useReducer((_: string | null, next: string | null) => next, null);
  const [load, setLoad] = useReducer((current: ListingLoad, next: Partial<ListingLoad>) => ({ ...current, ...next }), {
    listing: null, refreshing: false, failure: null,
  });
  const activeRef = useRef(true);
  const fetchedRef = useRef(false);
  // Reads of the list queue behind each other, so a cached read asked for
  // while the registry is being fetched lands after the fetch, never over
  // it; a read from before the latest Refresh is dropped.
  const listingRef = useRef<{ refresh: number; queue: Promise<unknown> }>({ refresh: 0, queue: Promise.resolve() });

  const loadListing = useCallback((refresh: boolean) => {
    const state = listingRef.current;
    if (refresh) {
      state.refresh += 1;
      setLoad({ refreshing: true, failure: null });
    }
    const id = state.refresh;
    const request = state.queue.then(() => pluginRegistry(refresh));
    state.queue = request.catch(() => {});
    request.then((listing) => {
      if (activeRef.current && id === state.refresh) setLoad(refresh ? { listing, refreshing: false } : { listing });
    }, (reason: unknown) => {
      // A cached read fails only when nothing is cached: nothing to show.
      if (activeRef.current && id === state.refresh && refresh) setLoad({ refreshing: false, failure: hostErrorMessage(reason) });
    });
  }, []);

  const reload = useCallback(() => {
    void listPlugins().then((next) => {
      if (activeRef.current) dispatch({ type: "loaded", list: next });
    }, (reason: unknown) => {
      if (activeRef.current) dispatch({ type: "loadFailed", error: hostErrorMessage(reason) });
    });
    loadListing(false);
  }, [loadListing]);
  useEffect(() => {
    activeRef.current = true;
    reload();
    const unsubscribe = subscribeTauriEvent<unknown>(PLUGINS_CHANGED_EVENT, reload);
    return () => {
      activeRef.current = false;
      unsubscribe();
    };
  }, [reload]);

  function showView(next: View) {
    setView(next);
    // The registry is fetched the first time Browse shows, not on every
    // visit to Settings; Refresh fetches it again.
    if (next === "browse" && !fetchedRef.current) {
      fetchedRef.current = true;
      loadListing(true);
    }
  }

  /**
   * Run one change at a time (`target` is `install`, `updates` or a
   * plugin's id); its failure shows under the install form, the Update all
   * button, or on the card and details sheet it was for.
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

  function confirmRemove(plugin: PluginInfo) {
    const name = plugin.name;
    void confirmAction({
      title: t`Remove ${name}?`,
      message: t`Its commands leave the palette, and its data and saved secrets are deleted.`,
      confirmLabel: t`Remove`,
      destructive: true,
    }).then((confirmed) => { if (confirmed) void change(plugin.id, () => removePlugin(plugin.id)); });
  }

  const available = list?.available ?? true;
  const plugins = list?.plugins ?? [];
  const listing = load.listing;
  const needle = query.trim();
  const shownPlugins = needle ? plugins.filter((plugin) => matchesPluginQuery(plugin, needle)) : plugins;
  const urlValid = urlForm !== null && urlForm.url.trim() !== "" && /^[0-9a-f]{64}$/i.test(urlForm.sha256.trim());
  const updateOf = (id: string) => listing?.installed.find((item) => item.id === id && item.update) ?? null;
  // Update all applies only the updates that ask for nothing new; the rest
  // ask first, on their own card.
  const quietUpdates = plugins.filter((plugin) => {
    const record = updateOf(plugin.id);
    return record !== null && asksNothing(record.updateAsks) && !plugin.blocked;
  });
  const detailsPlugin = details && listing ? listing.plugins.find((plugin) => plugin.id === details) ?? null : null;
  const detailsOffer = detailsPlugin && listing ? pluginOffer(detailsPlugin, listing, plugins) : null;
  const detailsInfo = detailsOffer?.kind === "installed" || detailsOffer?.kind === "update" ? detailsOffer.info : null;
  const installable = listing !== null && listing.verified && listing.status.kind !== "refused";
  const searchLabel = view === "browse" ? t`Search plugins` : t`Search installed plugins`;
  // ⌘K, or Ctrl+K off an Apple keyboard.
  const paletteKeys = comboText({ ...PALETTE_KEY, mod: true });

  return (
    <div className="settings-section plugin-settings" aria-busy={busy !== null || list === null}>
      <SettingsSectionHeader
        title={t`Plugins`}
        actions={view === "browse" ? (
          <Button variant="ghost" size="compact" disabled={load.refreshing} onClick={() => loadListing(true)}>{t`Refresh`}</Button>
        ) : quietUpdates.length > 0 ? (
          <Button size="compact" variant="tinted" disabled={busy !== null || !available} onClick={() => void change("updates", async () => {
            for (const plugin of quietUpdates) await installRegistryPlugin(plugin.id);
          })}>{t`Update all`}</Button>
        ) : undefined}
      />
      <p className="plugin-settings-intro">
        {t`Plugins add commands to the command palette (${paletteKeys}). Each runs in a sandbox and can reach only what you allow when you turn it on.`}
      </p>
      {!available && (
        <InlineMessage level="warning">{t`Plugins run only on macOS for now. They are listed here, but can’t be turned on.`}</InlineMessage>
      )}
      <div className="plugin-settings-bar">
        <SegmentedControl
          value={view}
          onChange={showView}
          ariaLabel={t`Plugins view`}
          items={[{ value: "installed", label: t`Installed` }, { value: "browse", label: t`Browse` }]}
        />
        <SearchField
          aria-label={searchLabel}
          placeholder={view === "browse" ? t`Search by name, description or author` : t`Search installed plugins`}
          controlSize="compact"
          containerClassName="plugin-settings-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
      </div>
      {view === "browse" ? (
        <PluginBrowse load={load} query={query} sort={sort} onSort={setSort} installed={plugins} onOpen={setDetails} />
      ) : (
        <>
          {cardErrors.updates && <InlineMessage level="error">{cardErrors.updates}</InlineMessage>}
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
          {list && plugins.length > 0 && shownPlugins.length === 0 && <p className="plugin-settings-empty">{t`No installed plugins match`}</p>}
          {shownPlugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              available={available}
              busy={busy !== null}
              error={cardErrors[plugin.id] ?? null}
              update={updateOf(plugin.id)?.update ?? null}
              onToggle={(enabled) => {
                if (enabled) dispatch({ type: "ask", plugin });
                else void change(plugin.id, () => setPluginEnabled(plugin.id, false));
              }}
              onReview={() => dispatch({ type: "ask", plugin })}
              onUpdate={() => setDetails(plugin.id)}
              onSecret={(name, value) => change(plugin.id, () => setPluginSecret(plugin.id, name, value))}
              onRemove={() => confirmRemove(plugin)}
            />
          ))}
        </>
      )}
      {detailsPlugin && detailsOffer && (
        <PluginDetailsSheet
          plugin={detailsPlugin}
          offer={detailsOffer}
          available={available}
          installable={installable}
          busy={busy !== null}
          error={cardErrors[detailsPlugin.id] ?? null}
          onInstall={(turnOn) => {
            const id = detailsPlugin.id;
            void change(id, async () => {
              await installRegistryPlugin(id);
              if (turnOn) await setPluginEnabled(id, true);
            });
          }}
          onToggle={(enabled) => {
            if (!detailsInfo) return;
            if (enabled) dispatch({ type: "ask", plugin: detailsInfo });
            else void change(detailsInfo.id, () => setPluginEnabled(detailsInfo.id, false));
          }}
          onRemove={() => { if (detailsInfo) confirmRemove(detailsInfo); }}
          onClose={() => setDetails(null)}
        />
      )}
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
