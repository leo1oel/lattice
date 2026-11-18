/**
 * Settings › Appearance › Theme › Browse themes: the theme marketplace's
 * signed list (theme-registry.ts) as a sheet over Settings. Each row's tile
 * is painted from the list's own colors, so nothing downloads before
 * Install; installing goes through lattice-core, which checks the file
 * against the signed list (docs/themes.md).
 */
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Palette } from "lucide-react";
import { useDeferredValue, useEffect, useReducer } from "react";

import { hostErrorMessage, relativeTime } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { joinPhrases } from "../i18n";
import type { ThemePreference } from "./app-settings";
import { ThemeArt } from "./theme-art";
import {
  type BlockedEntry,
  type IndexTheme,
  type RegistryListing,
  artVariants,
  installRegistryTheme,
  matchesQuery,
  registryIndex,
  rowAction,
} from "./theme-registry";
import type { ThemeInfo } from "./themes";
import "./theme-browse.css";

type Load = { listing: RegistryListing | null; refreshing: boolean; failure: string | null };

export function BrowseThemesSheet(props: {
  mode: ThemePreference;
  /** The themes installed here, to tell which rows are installed already. */
  themes: readonly ThemeInfo[] | null;
  /** A theme was installed (not updated): choose it. */
  onInstalled: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  // `cached` fills in only while nothing is shown: a cached answer that
  // lands after the fetched one is older.
  const [load, setLoad] = useReducer((current: Load, { cached, ...next }: Partial<Load> & { cached?: RegistryListing }) => ({
    ...current,
    ...next,
    listing: next.listing ?? current.listing ?? cached ?? null,
  }), {
    listing: null,
    refreshing: true,
    failure: null,
  });
  const [query, setQuery] = useReducer((_: string, next: string) => next, "");
  const needle = useDeferredValue(query);

  const refresh = () => {
    setLoad({ refreshing: true, failure: null });
    registryIndex(true).then(
      (listing) => setLoad({ listing, refreshing: false }),
      (reason: unknown) => setLoad({ refreshing: false, failure: hostErrorMessage(reason) }),
    );
  };
  // The cached list shows at once; the registry's replaces it when it is
  // fetched and verified.
  useEffect(() => {
    let active = true;
    registryIndex(false).then((cached) => { if (active) setLoad({ cached }); }, () => {});
    registryIndex(true).then(
      (listing) => { if (active) setLoad({ listing, refreshing: false }); },
      (reason: unknown) => { if (active) setLoad({ refreshing: false, failure: hostErrorMessage(reason) }); },
    );
    return () => {
      active = false;
    };
  }, []);

  const listing = load.listing;
  const themes = listing?.index?.themes ?? [];
  const shown = needle.trim() ? themes.filter((theme) => matchesQuery(theme, needle)) : themes;
  const loading = load.refreshing && !listing?.index;
  const refused = listing?.status.kind === "refused";
  const title = t`Browse themes`;

  return (
    <SheetDialog className="theme-browse" label={title} onClose={props.onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<Palette size={16} />}
        title={title}
        onClose={props.onClose}
        actions={(
          <Button variant="ghost" size="compact" disabled={load.refreshing} onClick={refresh}>{t`Refresh`}</Button>
        )}
      />
      <div className="theme-browse-body">
        <SearchField
          aria-label={t`Search themes`}
          placeholder={t`Search by name, description or author`}
          controlSize="compact"
          containerClassName="theme-browse-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
        <StatusLine load={load} loading={loading} />
        {loading && (
          <ul className="theme-browse-list" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => <li key={index} className="theme-browse-row theme-browse-skeleton loading-sheen" />)}
          </ul>
        )}
        {!loading && needle.trim() !== "" && shown.length === 0 && (
          <p className="theme-browse-empty">{t`No themes match`}</p>
        )}
        {shown.length > 0 && listing && (
          <ul className="theme-browse-list">
            {shown.map((theme) => (
              <ThemeRow
                key={theme.id}
                theme={theme}
                mode={props.mode}
                listing={listing}
                themes={props.themes}
                installable={!refused}
                onInstalled={(updated) => {
                  if (!updated) props.onInstalled(theme.id);
                  registryIndex(false).then((next) => setLoad({ listing: next }), () => {});
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </SheetDialog>
  );
}

function StatusLine({ load, loading }: { load: Load; loading: boolean }) {
  const { t } = useLingui();
  if (loading) {
    return (
      <div className="theme-browse-status">
        {t`Loading…`}
        <LoadingAnnouncement message={t`Loading the theme list`} />
      </div>
    );
  }
  if (load.failure) return <p className="theme-browse-status theme-browse-status-danger">{load.failure}</p>;
  const listing = load.listing;
  if (!listing) return null;
  const { status, fetchedAt } = listing;
  if (status.kind === "refused") {
    return (
      <p className="theme-browse-status theme-browse-status-danger" title={status.message}>
        {t`Couldn't verify the theme list. Nothing new can be installed.`}
      </p>
    );
  }
  if (status.kind === "offline") {
    const date = fetchedAt ? new Date(fetchedAt).toLocaleDateString() : null;
    return (
      <p className="theme-browse-status" title={status.message}>
        {date ? t`Offline: showing the list from ${date}` : t`Offline. The theme list can't be reached.`}
      </p>
    );
  }
  if (!fetchedAt) return null;
  const when = relativeTime(fetchedAt);
  return <p className="theme-browse-status">{t`Updated ${when}`}</p>;
}

type RowState = { busy: boolean; error: string | null };

function ThemeRow(props: {
  theme: IndexTheme;
  mode: ThemePreference;
  listing: RegistryListing;
  themes: readonly ThemeInfo[] | null;
  installable: boolean;
  onInstalled: (updated: boolean) => void;
}) {
  const { t } = useLingui();
  const { theme } = props;
  const [state, setState] = useReducer((_: RowState, next: RowState) => next, { busy: false, error: null });
  const action = rowAction(theme, props.listing, props.themes);
  const install = () => {
    setState({ busy: true, error: null });
    installRegistryTheme(theme.id).then(
      () => {
        setState({ busy: false, error: null });
        props.onInstalled(action.kind === "update");
      },
      (reason: unknown) => setState({ busy: false, error: hostErrorMessage(reason) }),
    );
  };
  const blocked = action.kind === "blocked" ? action.entry : null;
  const next = action.kind === "update" ? action.version : "";
  const meta = joinPhrases([theme.author, theme.license].filter((part): part is string => Boolean(part)));
  return (
    <li className="theme-browse-row" data-theme-id={theme.id}>
      <span className="theme-browse-art"><ThemeArt variants={artVariants(theme)} mode={props.mode} /></span>
      <div className="theme-browse-text">
        <p className="theme-browse-title">
          <span className="theme-browse-name">{theme.name}</span>
          <span className="theme-browse-version">{theme.version}</span>
        </p>
        {theme.description && <p className="theme-browse-line theme-browse-description">{theme.description}</p>}
        {blocked
          ? <p className="theme-browse-line theme-browse-blocked">{blocked.reason}</p>
          : meta && <p className="theme-browse-line theme-browse-meta">{meta}</p>}
        {state.error && <InlineMessage level="error">{state.error}</InlineMessage>}
      </div>
      <span className="theme-browse-action">
        {action.kind === "blocked" && (
          <Button variant="danger" size="compact" disabled title={action.entry.reason}>{t`Blocked`}</Button>
        )}
        {action.kind === "installed" && <Button variant="ghost" size="compact" disabled>{t`Installed`}</Button>}
        {action.kind === "install" && (
          <Button size="compact" disabled={!props.installable || state.busy} onClick={install}>{t`Install`}</Button>
        )}
        {action.kind === "update" && (
          <Button variant="tinted" size="compact" disabled={!props.installable || state.busy} onClick={install}>
            {t`Update to ${next}`}
          </Button>
        )}
      </span>
    </li>
  );
}

/**
 * The Palette row's note when the chosen theme falls under the registry's
 * kill switch: turned off (Lattice's own colors show, the choice is kept) or
 * a warning, with the entry's link.
 */
export function ThemeBlockNotice(props: { name: string; entry: BlockedEntry }) {
  const { t } = useLingui();
  const { name, entry } = props;
  const reason = entry.reason;
  const warn = entry.action === "warn";
  const url = entry.url;
  return (
    <InlineMessage level={warn ? "warning" : "error"}>
      {warn ? t`${name} has a warning: ${reason}` : t`${name} was turned off: ${reason}`}
      {url && (
        <>
          {" "}
          <button type="button" className="theme-block-link" onClick={() => void openUrl(url)}>{t`Learn more`}</button>
        </>
      )}
    </InlineMessage>
  );
}
