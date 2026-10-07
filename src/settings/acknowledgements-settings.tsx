import { Suspense, useDeferredValue, useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, ExternalLink, FileText } from "lucide-react";
import { fontLicenseUrl } from "virtual:lattice-private-fonts-license";
import noticesUrl from "../../THIRD_PARTY_NOTICES.md?url";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { PdfPreview, PdfPreviewLoading } from "../canvas/canvas-lazy-editors";
import { CORE_SOFTWARE, DESIGN_CREDITS, ORIGIN_CREDITS, type Credit } from "./acknowledged-software";
import { TIMELESS } from "./interface-font-credit";
import {
  licenseGroupsFor,
  packageRegistryUrl,
  parseThirdPartyNotices,
  type ThirdPartyClosure,
  type ThirdPartyNotices,
  type ThirdPartyPackage,
} from "./third-party-notices";
import "./acknowledgements-settings.css";

/** A search narrows the list to this many rows; a longer query narrows it further. */
const SEARCH_RESULT_LIMIT = 200;
const CLOSURE_ORDER: readonly ThirdPartyClosure[] = ["npm", "crates", "sidecar", "presentation-runtime"];

type LoadedNotices = { text: string; notices: ThirdPartyNotices };

// THIRD_PARTY_NOTICES.md ships beside the web assets (Vite emits the `?url`
// import), so the list and the license texts are read from the very file the
// app distributes. One request per session; a failed one is retried on the
// next visit rather than cached.
let noticesRequest: Promise<LoadedNotices> | null = null;
function loadNotices() {
  noticesRequest ??= fetch(noticesUrl)
    .then((response) => {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- never shown; the pane says the notices could not be read
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((text) => ({ text, notices: parseThirdPartyNotices(text) }))
    .catch((error: unknown) => {
      noticesRequest = null;
      throw error;
    });
  return noticesRequest;
}

function useThirdPartyNotices() {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | ({ status: "ready" } & LoadedNotices)>({ status: "loading" });
  useEffect(() => {
    let disposed = false;
    loadNotices().then(
      (loaded) => { if (!disposed) setState({ status: "ready", ...loaded }); },
      () => { if (!disposed) setState({ status: "error" }); },
    );
    return () => { disposed = true; };
  }, []);
  return state;
}

/** The newest recorded version of a credited package; a closure can hold two. */
function recordedPackage(notices: ThirdPartyNotices | null, credit: Credit) {
  if (!notices || !credit.pkg) return undefined;
  const { closure, name } = credit.pkg;
  return notices.packages
    .filter((pkg) => pkg.closure === closure && pkg.name === name)
    .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
}

function useClosureLabels(): Record<ThirdPartyClosure, string> {
  const { t } = useLingui();
  return {
    npm: t`Interface`,
    crates: t`Native app`,
    sidecar: t`Agent runtime`,
    "presentation-runtime": t`Presentation runtime`,
  };
}

/** The license exactly as it came with the fonts, in the app's own PDF viewer. */
function FontLicenseDialog({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <SheetDialog className="acknowledgements-license" label={TIMELESS.license} onClose={onClose}>
      <PanelHeader className="drawer-header" icon={<FileText size={16} />} title={TIMELESS.license} onClose={onClose} />
      <div className="acknowledgements-license-viewer">
        <Suspense fallback={<PdfPreviewLoading />}>
          <PdfPreview url={url} showSave={false} />
        </Suspense>
      </div>
    </SheetDialog>
  );
}

/**
 * One package's license texts as THIRD_PARTY_NOTICES.md reproduces them, or,
 * with no package, that whole file.
 */
function NoticesDialog({ loaded, pkg, onClose }: { loaded: LoadedNotices; pkg: ThirdPartyPackage | null; onClose: () => void }) {
  const { t } = useLingui();
  const closureLabels = useClosureLabels();
  const title = pkg ? `${pkg.name} ${pkg.version}` : t`Third-party notices`;
  const groups = pkg ? licenseGroupsFor(loaded.notices, pkg) : [];
  const registry = pkg ? packageRegistryUrl(pkg) : null;
  return (
    <SheetDialog className="acknowledgements-notices" label={title} onClose={onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<FileText size={16} />}
        title={title}
        onClose={onClose}
        actions={registry && (
          <Button variant="ghost" size="compact" onClick={() => void openUrl(registry)}>
            {new URL(registry).hostname.replace(/^www\./, "")} <ExternalLink size={12} />
          </Button>
        )}
      />
      <div className="acknowledgements-notices-body">
        {!pkg && <pre className="acknowledgements-notices-text">{loaded.text}</pre>}
        {pkg && (
          <p className="acknowledgements-notices-meta">
            {[pkg.license || t`No license declared`, closureLabels[pkg.closure]].join(" · ")}
          </p>
        )}
        {pkg && groups.length === 0 && (
          <InlineMessage level="warning">
            {t`This package ships no license text of its own, so none is reproduced here. The third-party notices list it among the attribution gaps.`}
          </InlineMessage>
        )}
        {groups.map((group) => (
          <section key={group.title} className="acknowledgements-notices-group">
            <h3>{group.title}</h3>
            <h4>{t`License text`}</h4>
            <pre className="acknowledgements-notices-text">{group.text}</pre>
            {/* The generator collects the notices of every package sharing the
                text in one list, and does not say whose line is whose. */}
            {group.copyrights && (
              <>
                <h4>{t`Copyright notices of the packages under this text`}</h4>
                <pre className="acknowledgements-notices-text">{group.copyrights}</pre>
              </>
            )}
          </section>
        ))}
      </div>
    </SheetDialog>
  );
}

function CreditRow({ credit, notices }: { credit: Credit; notices: ThirdPartyNotices | null }) {
  const { t, i18n } = useLingui();
  const recorded = recordedPackage(notices, credit);
  const license = credit.license ?? recorded?.license;
  const version = credit.version ?? recorded?.version;
  const url = credit.url;
  return (
    <SettingsRow label={credit.name} description={[i18n._(credit.role), credit.attribution].filter(Boolean).join(". ")}>
      {(license || version) && (
        <span className="acknowledgements-terms">{[license, version].filter(Boolean).join(" · ")}</span>
      )}
      {url && (
        <IconButton size="compact" label={t`Open the ${credit.name} website`} onClick={() => void openUrl(url)}>
          <ExternalLink size={14} />
        </IconButton>
      )}
    </SettingsRow>
  );
}

function PackageRow({ pkg, onOpen }: { pkg: ThirdPartyPackage; onOpen: (pkg: ThirdPartyPackage) => void }) {
  const { t } = useLingui();
  return (
    <li>
      <button type="button" className="acknowledgements-package" onClick={() => onOpen(pkg)}>
        <span className="acknowledgements-package-name">{pkg.name}</span>
        <span className="acknowledgements-version">{pkg.version}</span>
        <span className="acknowledgements-package-license">{pkg.license || t`No license declared`}</span>
      </button>
    </li>
  );
}

/** Every package the four shipped closures hold, searchable, from the notices. */
function DependencyList({ notices, onOpen }: { notices: ThirdPartyNotices; onOpen: (pkg: ThirdPartyPackage) => void }) {
  const { t, i18n } = useLingui();
  const closureLabels = useClosureLabels();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [open, setOpen] = useState<ReadonlySet<ThirdPartyClosure>>(new Set());
  const total = i18n.number(notices.packages.length);
  const needle = deferredQuery.trim().toLocaleLowerCase();
  const matches = needle
    ? notices.packages.filter((pkg) => `${pkg.name} ${pkg.license}`.toLocaleLowerCase().includes(needle))
    : [];
  const shown = matches.slice(0, SEARCH_RESULT_LIMIT);
  const toggle = (closure: ThirdPartyClosure) => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(closure)) next.add(closure);
    return next;
  });

  return (
    <SettingsGroup title={t`All third-party software`}>
      <p className="acknowledgements-lead">
        {t`Lattice ships ${total} open-source packages across its interface, its native app and its bundled runtimes. Select one to read its license.`}
      </p>
      <SearchField
        aria-label={t`Search third-party software`}
        placeholder={t`Search by name or license`}
        controlSize="compact"
        containerClassName="acknowledgements-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery("")}
      />
      {needle ? (
        <div className="acknowledgements-results">
          {shown.length === 0 && <p className="acknowledgements-lead">{t`Nothing matches “${deferredQuery.trim()}”.`}</p>}
          {CLOSURE_ORDER.map((closure) => {
            const rows = shown.filter((pkg) => pkg.closure === closure);
            if (rows.length === 0) return null;
            return (
              <section key={closure} aria-label={closureLabels[closure]}>
                <h4 className="acknowledgements-closure-title">{closureLabels[closure]}</h4>
                <ul className="acknowledgements-packages">
                  {rows.map((pkg) => <PackageRow key={`${pkg.name}@${pkg.version}`} pkg={pkg} onOpen={onOpen} />)}
                </ul>
              </section>
            );
          })}
          {matches.length > shown.length && (
            <p className="acknowledgements-lead">{t`Showing ${shown.length} of ${matches.length} matches. Keep typing to narrow them.`}</p>
          )}
        </div>
      ) : CLOSURE_ORDER.map((closure) => {
        const rows = notices.packages.filter((pkg) => pkg.closure === closure);
        if (rows.length === 0) return null;
        const expanded = open.has(closure);
        return (
          <section key={closure} className="acknowledgements-closure">
            <button
              type="button"
              className="acknowledgements-closure-toggle"
              aria-expanded={expanded}
              onClick={() => toggle(closure)}
            >
              <ChevronRight size={14} className="acknowledgements-closure-chevron" aria-hidden="true" />
              <span className="acknowledgements-closure-label">{closureLabels[closure]}</span>
              <span className="acknowledgements-closure-count">{t`${rows.length} packages`}</span>
            </button>
            {expanded && (
              <ul className="acknowledgements-packages">
                {rows.map((pkg) => <PackageRow key={`${pkg.name}@${pkg.version}`} pkg={pkg} onOpen={onOpen} />)}
              </ul>
            )}
          </section>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * Settings › About › Acknowledgements: the open-source work Lattice is built
 * on and ships. The major components come first (`acknowledged-software.ts`),
 * then every package of every shipped closure, read from the
 * THIRD_PARTY_NOTICES.md bundled with the app so the list and its license
 * texts cannot drift from what is distributed.
 *
 * In builds that embed the Timeless fonts (scripts/private-fonts.ts) their
 * credit leads the type group, with the license that came with them, shipped
 * unmodified, since the license lets the fonts go to no one without it.
 */
export function AcknowledgementsSettings() {
  const { t } = useLingui();
  const [fontLicenseOpen, setFontLicenseOpen] = useState(false);
  // undefined: closed; null: the whole notices file; a package: its license.
  const [noticesFor, setNoticesFor] = useState<ThirdPartyPackage | null | undefined>(undefined);
  const loaded = useThirdPartyNotices();
  const notices = loaded.status === "ready" ? loaded.notices : null;
  const license = TIMELESS.license;
  return (
    <div className="settings-section acknowledgements">
      <SettingsSectionHeader
        title={t`Acknowledgements`}
        description={t`Lattice stands on the work of many open-source projects. Thank you to everyone who builds them.`}
        actions={(
          <Button variant="secondary" size="compact" disabled={!notices} onClick={() => setNoticesFor(null)}>
            <FileText size={14} /> {t`Third-party notices`}
          </Button>
        )}
      />
      <SettingsGroup title={t`Core components`}>
        {CORE_SOFTWARE.map((credit) => <CreditRow key={credit.name} credit={credit} notices={notices} />)}
      </SettingsGroup>
      <SettingsGroup title={t`Type, icons and sound`}>
        {fontLicenseUrl && (
          <SettingsRow
            label={TIMELESS.name}
            description={t`Type family by Timeless Ventures Private Limited, Chennai, used under the ${license}. Get the fonts from timeless.co`}
          >
            <Button variant="ghost" size="compact" onClick={() => setFontLicenseOpen(true)}>
              {t`View license`}
            </Button>
            <Button variant="ghost" size="compact" onClick={() => void openUrl(TIMELESS.url)}>
              {TIMELESS.site} <ExternalLink size={12} />
            </Button>
          </SettingsRow>
        )}
        {DESIGN_CREDITS.map((credit) => <CreditRow key={credit.name} credit={credit} notices={notices} />)}
      </SettingsGroup>
      <SettingsGroup title={t`Origins and adapted work`}>
        {ORIGIN_CREDITS.map((credit) => <CreditRow key={credit.name} credit={credit} notices={notices} />)}
      </SettingsGroup>
      {loaded.status === "ready" && <DependencyList notices={loaded.notices} onOpen={setNoticesFor} />}
      {loaded.status === "loading" && (
        <SettingsGroup title={t`All third-party software`}>
          <p className="acknowledgements-lead">{t`Reading the third-party notices…`}</p>
        </SettingsGroup>
      )}
      {loaded.status === "error" && (
        <SettingsGroup title={t`All third-party software`}>
          <InlineMessage level="error">{t`The third-party notices could not be read from the app bundle.`}</InlineMessage>
        </SettingsGroup>
      )}
      {fontLicenseOpen && fontLicenseUrl && <FontLicenseDialog url={fontLicenseUrl} onClose={() => setFontLicenseOpen(false)} />}
      {noticesFor !== undefined && loaded.status === "ready" && (
        <NoticesDialog loaded={loaded} pkg={noticesFor} onClose={() => setNoticesFor(undefined)} />
      )}
    </div>
  );
}
