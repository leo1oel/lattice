/**
 * Settings › Plugins › a listed plugin's details: a sheet over Settings with
 * what the plugin can reach, in the same plain words the turn-on question
 * uses, the commands it adds, and Install / Update / Turn on / Remove. On
 * Install the writer chooses whether to grant now; an update that asks for
 * more lists only what is new (spec §3.3). The GPUI pane is the same.
 */
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Package } from "lucide-react";

import { relativeTime } from "../app-utils";
import { Button } from "../components/ui/button";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { Switch } from "../components/ui/switch";
import { joinPhrases } from "../i18n";
import { asksNothing, compactCount, type IndexPlugin, type PluginOffer } from "./plugin-registry";
import { permissionLines } from "./plugin-text";
import "./plugin-browse.css";

/** A plugin's initial on a tile, since the manifest has no icon. */
export function PluginMonogram({ name }: { name: string }) {
  return <span className="plugin-monogram" aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>;
}

export function PluginDetailsSheet(props: {
  plugin: IndexPlugin;
  offer: PluginOffer;
  /** Plugins can run here (macOS); elsewhere nothing installs. */
  available: boolean;
  /** The list is a verified one, so it can install. */
  installable: boolean;
  busy: boolean;
  error: string | null;
  /** Install the listed version (or update to it), granting what it asks when `turnOn`. */
  onInstall: (turnOn: boolean) => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { plugin, offer } = props;
  const name = plugin.name;
  const version = plugin.version;
  const downloads = plugin.downloads === null ? null : compactCount(plugin.downloads);
  const updated = plugin.updated ? relativeTime(plugin.updated) : null;
  const meta = joinPhrases([
    plugin.author,
    t`Version ${version}`,
    updated && t`Updated ${updated}`,
    downloads && t`${downloads} downloads`,
    plugin.license,
  ].filter((part): part is string => Boolean(part)));
  const canInstall = props.available && props.installable && !props.busy;
  const blocked = offer.kind === "blocked" ? offer.entry : offer.kind === "installed" || offer.kind === "update" ? offer.info.blocked ?? null : null;
  const turnedOff = blocked !== null && blocked.action !== "warn";
  const reason = blocked?.reason ?? "";
  const blockUrl = blocked?.url;
  const current = offer.kind === "update" ? offer.info.version : "";

  return (
    <SheetDialog className="plugin-details" label={name} onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<Package size={16} />} title={name} onClose={props.onClose} />
      <div className="plugin-details-body" data-plugin={plugin.id}>
        <div className="plugin-details-head">
          <PluginMonogram name={name} />
          <div className="plugin-details-copy">
            <p className="plugin-details-meta">{meta}</p>
            {plugin.description && <p className="plugin-details-description">{plugin.description}</p>}
            <button type="button" className="plugin-details-link" onClick={() => void openUrl(plugin.repository)}>{t`Source code`}</button>
          </div>
        </div>
        {!props.available && <InlineMessage level="warning">{t`Plugins run only on macOS for now.`}</InlineMessage>}
        {blocked && (
          <InlineMessage level={turnedOff ? "error" : "warning"}>
            {turnedOff ? t`Lattice turned this plugin off: ${reason}` : t`This plugin has a warning: ${reason}`}
            {blockUrl && <>{" "}<button type="button" className="plugin-details-link" onClick={() => void openUrl(blockUrl)}>{t`Learn more`}</button></>}
          </InlineMessage>
        )}
        {offer.kind === "update" && !asksNothing(offer.asks) && (
          <section className="plugin-details-section plugin-details-update">
            <h3>{t`Version ${version} also wants:`}</h3>
            <ul className="plugin-permissions">{permissionLines(offer.asks).map((line) => <li key={line}>{line}</li>)}</ul>
          </section>
        )}
        <section className="plugin-details-section">
          <h3>{t`This plugin can`}</h3>
          <ul className="plugin-permissions">{permissionLines(plugin.permissions).map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="plugin-details-cannot">{t`It can’t read other files, use your API keys or environment, or write files without asking you.`}</p>
        </section>
        {plugin.commands.length > 0 && (
          <section className="plugin-details-section">
            <h3>{t`Commands it adds`}</h3>
            <ul className="plugin-details-commands">
              {plugin.commands.map((command) => (
                <li key={command.id}>
                  <span className="plugin-details-command">{command.title}</span>
                  {command.description && <span className="plugin-details-command-description">{command.description}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {props.error && <InlineMessage level="error">{props.error}</InlineMessage>}
      </div>
      <div className="plugin-details-actions">
        {offer.kind === "install" && (
          <>
            <Button variant="secondary" disabled={!canInstall} onClick={() => props.onInstall(false)}>{t`Install only`}</Button>
            <Button variant="primary" disabled={!canInstall} onClick={() => props.onInstall(true)}>{t`Install and turn on`}</Button>
          </>
        )}
        {offer.kind === "blocked" && <Button variant="danger" disabled>{t`Blocked`}</Button>}
        {(offer.kind === "installed" || offer.kind === "update") && (
          <>
            <Button variant="ghost" disabled={props.busy} onClick={props.onRemove}>{t`Remove`}</Button>
            <span className="plugin-details-spacer" />
            {offer.kind === "update" && asksNothing(offer.asks) && (
              <Button variant="tinted" disabled={!canInstall} onClick={() => props.onInstall(offer.info.enabled)}>{t`Update to ${version}`}</Button>
            )}
            {offer.kind === "update" && !asksNothing(offer.asks) && (
              <>
                <Button variant="ghost" onClick={props.onClose}>{t`Keep ${current}`}</Button>
                <Button variant="primary" disabled={!canInstall} onClick={() => props.onInstall(true)}>{t`Allow and update`}</Button>
              </>
            )}
            {(offer.kind === "installed" || asksNothing(offer.asks)) && (
              <Switch
                checked={offer.info.enabled}
                disabled={!props.available || props.busy || (turnedOff && !offer.info.enabled)}
                label={offer.info.enabled ? t`Turn off ${name}` : t`Turn on ${name}`}
                onChange={props.onToggle}
              />
            )}
          </>
        )}
      </div>
    </SheetDialog>
  );
}
