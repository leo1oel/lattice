/**
 * Settings › Plugins › Browse: the plugin market's signed list
 * (plugin-registry.ts) searched and sorted on this Mac, a 56px row per
 * plugin with its install state. A row opens the details sheet
 * (plugin-details.tsx); nothing downloads before Install, and installing goes
 * through lattice-core, which checks the archive against the list.
 */
import { useLingui } from "@lingui/react/macro";
import { useDeferredValue } from "react";

import { relativeTime } from "../app-utils";
import { Button } from "../components/ui/button";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { joinPhrases } from "../i18n";
import type { PluginInfo } from "./plugin-ipc";
import { PluginMonogram } from "./plugin-details";
import { compactCount, type PluginListing, type PluginSort, matchesPluginQuery, pluginOffer, sortPlugins } from "./plugin-registry";
import "./plugin-browse.css";

export type ListingLoad = { listing: PluginListing | null; refreshing: boolean; failure: string | null };

export function PluginBrowse(props: {
  load: ListingLoad;
  query: string;
  sort: PluginSort;
  onSort: (sort: PluginSort) => void;
  installed: readonly PluginInfo[];
  onOpen: (id: string) => void;
}) {
  const { t } = useLingui();
  const needle = useDeferredValue(props.query).trim();
  const listing = props.load.listing;
  const plugins = listing?.plugins ?? [];
  const shown = sortPlugins(needle ? plugins.filter((plugin) => matchesPluginQuery(plugin, needle)) : plugins, props.sort);
  const loading = props.load.refreshing && plugins.length === 0;
  const sortLabel = t`Sort plugins`;
  return (
    <div className="plugin-browse">
      <div className="plugin-browse-bar">
        <ListingStatus load={props.load} loading={loading} />
        <Select value={props.sort} onValueChange={(value) => props.onSort(value as PluginSort)}>
          <SelectTrigger aria-label={sortLabel} size="compact"><SelectValue /></SelectTrigger>
          <SelectContent data-settings-control="true" position="popper" align="end">
            <SelectItem value="popular">{t`Most downloaded`}</SelectItem>
            <SelectItem value="recent">{t`Recently updated`}</SelectItem>
            <SelectItem value="name">{t`Name`}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {loading && (
        <ul className="plugin-browse-list" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => <li key={index} className="plugin-browse-row plugin-browse-skeleton loading-sheen" />)}
        </ul>
      )}
      {!loading && listing && plugins.length === 0 && <p className="plugin-settings-empty">{t`No plugins are listed yet.`}</p>}
      {!loading && needle !== "" && plugins.length > 0 && shown.length === 0 && <p className="plugin-settings-empty">{t`No plugins match`}</p>}
      {listing && shown.length > 0 && (
        <ul className="plugin-browse-list">
          {shown.map((plugin) => {
            const offer = pluginOffer(plugin, listing, props.installed);
            const name = plugin.name;
            const next = offer.kind === "update" ? offer.version : "";
            const downloads = plugin.downloads === null ? null : compactCount(plugin.downloads);
            const meta = joinPhrases([plugin.author, downloads && t`${downloads} downloads`].filter((part): part is string => Boolean(part)));
            const note = listing.blockedOffers[plugin.id];
            return (
              <li key={plugin.id} className="plugin-browse-row" data-plugin={plugin.id}>
                <button type="button" className="plugin-browse-open" aria-label={t`Details for ${name}`} onClick={() => props.onOpen(plugin.id)}>
                  <PluginMonogram name={name} />
                  <span className="plugin-browse-text">
                    <span className="plugin-browse-title">
                      <span className="plugin-browse-name">{name}</span>
                      <span className="plugin-browse-meta">{plugin.version}</span>
                    </span>
                    {plugin.description && <span className="plugin-browse-line plugin-browse-description">{plugin.description}</span>}
                    {note
                      ? <span className={note.action === "warn" ? "plugin-browse-line plugin-browse-warned" : "plugin-browse-line plugin-browse-blocked"}>{note.reason}</span>
                      : meta && <span className="plugin-browse-line">{meta}</span>}
                  </span>
                </button>
                <span className="plugin-browse-action">
                  {offer.kind === "blocked" && <Button variant="danger" size="compact" disabled title={offer.entry.reason}>{t`Blocked`}</Button>}
                  {offer.kind === "installed" && <Button variant="ghost" size="compact" disabled>{t`Installed`}</Button>}
                  {offer.kind === "install" && <Button size="compact" onClick={() => props.onOpen(plugin.id)}>{t`Install…`}</Button>}
                  {offer.kind === "update" && (
                    <Button variant="tinted" size="compact" onClick={() => props.onOpen(plugin.id)}>{t`Update to ${next}`}</Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ListingStatus({ load, loading }: { load: ListingLoad; loading: boolean }) {
  const { t } = useLingui();
  if (loading) {
    return (
      <p className="plugin-browse-status">
        {t`Loading…`}
        <LoadingAnnouncement message={t`Loading the plugin list`} />
      </p>
    );
  }
  if (load.failure) return <p className="plugin-browse-status plugin-browse-status-danger">{load.failure}</p>;
  const listing = load.listing;
  if (!listing) return <p className="plugin-browse-status" />;
  const { status, fetchedAt } = listing;
  if (status.kind === "refused") {
    return (
      <p className="plugin-browse-status plugin-browse-status-danger" title={status.message}>
        {t`Couldn't verify the plugin list. Nothing new can be installed.`}
      </p>
    );
  }
  if (status.kind === "offline") {
    const date = fetchedAt ? new Date(fetchedAt).toLocaleDateString() : null;
    return (
      <p className="plugin-browse-status" title={status.message}>
        {date ? t`Offline: showing the list from ${date}` : t`Offline. The plugin list can't be reached.`}
      </p>
    );
  }
  const when = fetchedAt ? relativeTime(fetchedAt) : null;
  return <p className="plugin-browse-status">{when ? t`Updated ${when}` : null}</p>;
}
