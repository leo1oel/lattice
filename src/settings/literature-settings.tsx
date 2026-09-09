import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InlineMessage, type InlineMessageLevel } from "../components/ui/inline-message";
import { InfinityLoader } from "../components/ui/activity-icons";
import { SettingsSectionHeader } from "../components/ui/settings-section-header";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import "./literature-settings.css";

type Provider = "openalex" | "semanticscholar" | "firecrawl";
type CredentialSource = "saved" | "environment" | "anonymous" | "shared" | "missing";
type Credentials = Record<Provider, CredentialSource> & { crossrefEmail: string };
type TestResult = {
  status: "ok" | "unauthorized" | "rate_limited" | "unavailable";
  authenticated: boolean;
};
const providers = [
  { id: "openalex", name: msg`OpenAlex`, url: "https://openalex.org/settings/api" },
  { id: "semanticscholar", name: msg`Semantic Scholar`, url: "https://www.semanticscholar.org/product/api" },
  { id: "firecrawl", name: msg`Firecrawl`, url: "https://www.firecrawl.dev/app/api-keys" },
] as const;

export function LiteratureSettings() {
  const { t } = useLingui();
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [drafts, setDrafts] = useState<Record<Provider, string>>({ openalex: "", semanticscholar: "", firecrawl: "" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>("load");
  const [notice, setNotice] = useState<{ target: string; text: string; level: InlineMessageLevel } | null>(null);
  const active = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    invoke<Credentials>("get_literature_credentials").then((value) => {
      if (disposed) return;
      setCredentials(value);
      setEmail(value.crossrefEmail);
    }).catch(() => {
      if (!disposed) setNotice({ target: "load", level: "error", text: t`Could not read the system keychain. Reopen these settings to try again.` });
    }).finally(() => { if (!disposed) setBusy(null); });
    return () => { disposed = true; active.current = false; };
  }, [t]);

  async function run(target: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(target);
    setNotice(null);
    try {
      await action();
    } catch {
      // Never render backend errors here: a provider/library may include a URL or credential.
      if (active.current) setNotice({ target, level: "error", text: t`Could not complete this action. Check your input and system keychain access.` });
    } finally {
      pending.current = false;
      if (active.current) setBusy(null);
    }
  }

  async function save(provider: Provider, secret: string | null) {
    const value = await invoke<Credentials>("set_literature_credential", { provider, secret });
    if (!active.current) return;
    setCredentials(value);
    setDrafts((current) => ({ ...current, [provider]: "" }));
    setNotice({ target: provider, level: "success", text: secret === null ? t`Saved key removed.` : t`Key saved in the system keychain.` });
  }

  async function test(provider: Provider) {
    const draft = drafts[provider].trim();
    const result = await invoke<TestResult>("test_literature_credential", { provider, secret: draft || null });
    if (!active.current) return;
    const text = result.status === "ok"
      ? (result.authenticated ? t`Connection succeeded with the key. Testing does not save it.` : t`Public API connection succeeded.`)
      : result.status === "unauthorized" ? t`Access denied. Check the key and its permissions.`
      : result.status === "rate_limited" ? t`The service is rate-limiting requests. No retry was made.`
      : t`The service could not be reached. No retry was made.`;
    setNotice({ target: provider, level: result.status === "ok" ? "success" : "warning", text });
  }

  function message(target: string) {
    return notice?.target === target ? <InlineMessage level={notice.level}>{notice.text}</InlineMessage> : null;
  }
  const disabled = busy !== null || !credentials;
  const sourceLabel = (provider: Provider, source?: CredentialSource) => source === "saved" ? t`Personal key saved` : source === "environment" ? t`Using environment key` : source === "shared" ? t`Using shared quota` : source === "missing" ? t`Not enabled · API key required` : provider === "semanticscholar" ? t`Not enabled · personal API key required` : t`Public access · no key`;

  return (
    <div className="settings-section literature-settings" aria-busy={busy !== null}>
      <SettingsSectionHeader title={t`Literature services`} description={t`Use your own API quota for paper searches, imports, and citation checks.`} />
      <InlineMessage>{t`Keys stay in your system keychain, not in the project. Personal keys take priority over shared or environment credentials.`}</InlineMessage>
      {busy === "load" && <InfinityLoader size={16} />}
      {message("load")}
      {providers.map(({ id, name, url }) => (
        <SettingsGroup key={id} title={t(name)}>
          <SettingsRow label={t`API key`} htmlFor={`literature-${id}`} description={credentials ? sourceLabel(id, credentials[id]) : t`Loading…`}>
            <Button variant="ghost" size="compact" disabled={busy !== null} onClick={() => void run(id, () => openUrl(url))}>
              {t`Get API key`} <ExternalLink size={12} />
            </Button>
          </SettingsRow>
          <form className="literature-credential-form" onSubmit={(event) => { event.preventDefault(); void run(id, () => save(id, drafts[id].trim())); }}>
            <Input id={`literature-${id}`} type="password" autoComplete="off" spellCheck={false} maxLength={16384} disabled={disabled}
              placeholder={credentials?.[id] === "saved" ? t`Enter a replacement key` : t`Paste your API key`}
              value={drafts[id]} onChange={(event) => { setDrafts({ ...drafts, [id]: event.target.value }); setNotice(null); }} />
            <div className="literature-credential-actions">
              <Button size="compact" type="submit" disabled={disabled || !drafts[id].trim()}>{t`Save`}</Button>
              <Button size="compact" variant="secondary" disabled={disabled || ((id === "semanticscholar" && credentials?.[id] === "anonymous") || credentials?.[id] === "missing") && !drafts[id].trim()} onClick={() => void run(id, () => test(id))}>{t`Test connection`}</Button>
              {credentials?.[id] === "saved" && <Button size="compact" variant="ghost" disabled={disabled} onClick={() => void run(id, () => save(id, null))}>{t`Remove key`}</Button>}
              {busy === id && <InfinityLoader size={14} />}
            </div>
          </form>
          {message(id)}
        </SettingsGroup>
      ))}
      <SettingsGroup title="Crossref">
        <SettingsRow label={t`Contact email`} htmlFor="literature-email" description={t`Sent to Crossref to use its polite pool. No API key is needed.`} />
        <form className="literature-credential-form" onSubmit={(event) => {
          event.preventDefault();
          void run("crossref", async () => {
            const value = await invoke<Credentials>("set_literature_contact", { email: email.trim() });
            if (!active.current) return;
            setCredentials(value);
            setEmail(value.crossrefEmail);
            setNotice({ target: "crossref", level: "success", text: t`Contact settings saved.` });
          });
        }}>
          <Input id="literature-email" type="email" autoComplete="email" maxLength={320} disabled={disabled} value={email}
            placeholder={t`name@example.org`} onChange={(event) => { setEmail(event.target.value); setNotice(null); }} />
          <div className="literature-credential-actions">
            <Button type="submit" size="compact" disabled={disabled || email === credentials?.crossrefEmail}>{t`Save`}</Button>
            {busy === "crossref" && <InfinityLoader size={14} />}
          </div>
        </form>
        {message("crossref")}
      </SettingsGroup>
    </div>
  );
}
