# Security Policy

Lattice is a desktop application that holds a fair amount of trust on your Mac:
it ships a **signed, auto-updating binary**, stores an **Overleaf session
cookie**, keeps **collaboration secrets in the macOS Keychain**, runs an **AI
agent sidecar with filesystem access**, and relays shared projects through a
**collaboration server**. Security reports about any of that are welcome and
taken seriously.

## Supported versions

Lattice ships a single auto-updating channel. Only the most recent release
receives security fixes; there are no maintenance branches for older `0.1.x`
versions, and fixes are delivered as a new release rather than a backport.

| Version | Supported |
| --- | --- |
| Latest [release](https://github.com/leo1oel/lattice/releases/latest) | ✅ |
| Any earlier release | ❌ — update first, then re-test |
| Builds from `main` or from a fork | ❌ — see [Out of scope](#out-of-scope) |

Official builds target **Apple Silicon Macs on macOS 14 or later**
(`bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.conf.json`). Older
macOS versions and Intel Macs are not supported at all.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security
problem.**

Use **GitHub private vulnerability reporting**:

👉 **<https://github.com/leo1oel/lattice/security/advisories/new>**

That form is private to you and the maintainer, gives us a place to work on a
fix together, and turns into the published advisory and CVE request when the
fix ships.

> **Maintainer setup note.** Private vulnerability reporting must be switched on
> for this repository (Settings → Advanced Security → Private vulnerability
> reporting). If the link above 404s for you, that switch is off — please open a
> public issue that says only *"I would like to report a security issue
> privately, please enable private vulnerability reporting"* and nothing else,
> and wait for a private channel before sharing any detail.

<!--
  MAINTAINER TODO before the repository is made public: if you want an email
  fallback alongside GitHub's form, publish a role address (e.g. one on a
  domain you control) and replace the line below. Do not put a personal or
  institutional mailbox here.
-->

There is currently **no published security email address** — GitHub's private
advisory form is the only supported private channel.

### What to include

A report is much faster to act on when it has:

- the Lattice version and your macOS version;
- which surface it touches (updater, collaboration, Overleaf, agent, Tauri/IPC);
- concrete reproduction steps or a proof of concept;
- what an attacker gains, and what access they need to start (a link you click?
  a share you join? a repository you open? already-local code execution?).

Please **redact your own secrets** from anything you attach — Overleaf session
cookies, Lattice share invites and join secrets, provider API keys, and absolute
paths that identify you or unpublished work.

### What to expect

This is an unpaid, solo-maintained project, so the timelines below are honest
targets rather than a contractual SLA:

| Stage | Target |
| --- | --- |
| Acknowledgement that the report arrived | within **7 days** |
| Initial assessment (in scope? severity? believed impact?) | within **14 days** |
| Fix released, or a written plan with a date if it will take longer | within **90 days** |

Disclosure is coordinated: we agree on a date, the fix ships in a release, and
the GitHub Security Advisory is published with credit to you unless you ask to
stay anonymous. **There is no bug bounty and no monetary reward.**

Please do not test against the shared collaboration Worker
(`lattice-collab.paperlattice.workers.dev`) or against other people's shares,
Overleaf accounts, or projects. Deploy your own Worker instead — `pnpm
collab:login && pnpm collab:deploy`, see
[`collab-server/README.md`](../collab-server/README.md) — and point Lattice at
it from **Live collaboration → Advanced (sync host)**.

## In scope

### 1. The updater trust chain

Lattice updates itself. A public minisign key is compiled into the app
(`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`) and the update feed is
served from
`https://github.com/leo1oel/lattice/releases/latest/download/latest.json`.
Release artifacts are signed by `tauri-action`, Developer ID codesigned,
notarized, and stapled, and `.github/workflows/release.yml` re-verifies
`codesign`/`spctl`/`stapler` on the DMG *and* on the `.app` inside it before the
draft release is published.

In scope: any way to make an installed Lattice accept an artifact it should
reject — signature-verification bypass, downgrade or rollback of the update
feed, TLS/endpoint substitution, tampering with the release pipeline, or getting
unpinned code into a shipped bundle (`scripts/prepare-synara-sidecar.mjs` pins
the sidecar revision and SHA-256-verifies the bundled Node download;
`scripts/synara-runtime.json` holds the pin).

Already known and publicly documented — please do **not** file these as new
reports: the current updater key pair has never been rotated and its password is
the empty string, so anyone holding a copy of that private key can sign an
update every install will accept. See
[`docs/release-process.md`](../docs/release-process.md) ("Rotating the updater
signing key"). New attacks on the *mechanism* are still in scope.

### 2. Collaboration server: authentication, grants, and tickets

`collab-server/` is a Cloudflare Worker whose `ProjectCoordinatorV2` Durable
Object (`collab-server/src/project-coordinator-v2.ts`) is the only authority for
a shared project. The model, roughly:

- the host secret and each grant secret are stored **salted and SHA-256 hashed**
  (`{salt, hash}`), never in the clear; every `/v2/projects/{id}/…` request
  carries a bearer credential that is re-authenticated per request;
- a grant carries a `permission` (`host` / `write` / `read`) and an `authEpoch`;
  revoking a grant bumps `authEpoch` and the project's `authorityEpoch`, which
  invalidates outstanding tickets and forces open sockets closed;
- WebSocket access to a per-file Y.Doc room requires a **single-use socket
  ticket** (60 s TTL, rate-limited) whose claims are validated in
  `onBeforeConnect` in `collab-server/src/index.ts` against the room's
  `{projectInstanceId, fileId, documentEpoch}` before any header is trusted;
- binary objects use separate single-use upload/read tickets bound to a declared
  SHA-256, size, and content type, and land at immutable content-addressed R2
  keys;
- presence `permission` is stamped from the authenticated actor, never from the
  request body.

In scope: a peer exceeding its grant (read-grant peer producing an accepted
write, guest reaching host-only routes such as `grants`, binary `gc`, or
retention pin/release), reading or writing another project's catalog, documents,
or binary objects, forging, replaying, or reusing a consumed ticket, surviving
revocation, escaping the `projectInstanceId`/path validation, or extracting a
grant secret from server state or responses.

Note that the v2 REST surface deliberately answers with
`access-control-allow-origin: *`: it is a bearer-token API for a desktop client
and uses no cookies or ambient credentials. Report it if you can show it enables
something.

### 3. Overleaf credential handling

Connecting Overleaf stores the **full session cookie**, which is equivalent to
an active browser login, in
`~/Library/Application Support/app.leo1oel.researchwriter/overleaf-session.json`
(`src-tauri/src/overleaf.rs`). The file is written atomically with mode `0600`.

In scope: anything that moves that cookie somewhere it should never be — app
logs, the sidecar log, agent-readable context, a collaboration document, a
crash/telemetry path, an error message, the clipboard, or an HTTP request to any
origin other than the configured Overleaf host. Also in scope: making Lattice
send the cookie to an attacker-chosen host through the self-hosted-instance
setting, or defeating the cookie-domain matching in
`cookie_domain_matches`/`store_session_cookie`.

Known and documented, not a new report: the cookie is stored **unencrypted**
rather than in the Keychain; the `0600` mode limits accidental disclosure but is
not encryption. See
[`docs/overleaf-integration-baseline.md`](../docs/overleaf-integration-baseline.md).
Moving it into the Keychain is tracked hardening work.

### 4. Collaboration secrets in the macOS Keychain

Share credentials live in one Keychain item — service
`com.lattice.research-writer.collab`, account `credential-vault-v1` — managed by
`src-tauri/src/collab_credentials.rs`.

In scope: injection through `credential_ref`, `project_instance_id`, or
`deployment` that escapes `validate_component`/`deployment_key` and reaches a
different Keychain service or account; any path that returns a secret belonging
to a different deployment or project; and anything that writes a secret outside
the Keychain.

### 5. The AI agent sidecar: permission model and boundary

The agent (Synara) runs as a **child process of the app** and is embedded as an
iframe over loopback HTTP (`src-tauri/src/synara.rs`,
`src/agent/synara-runtime.ts`). The boundary is:

- the server binds `127.0.0.1` on a dynamic port; the app trusts the discovered
  origin only after matching the recorded `pid` against its own child;
- `SYNARA_AUTH_TOKEN` and `SYNARA_DESKTOP_SHUTDOWN_TOKEN` are freshly minted per
  launch and the auth token is handed to the iframe in the URL **fragment**;
- every `postMessage` in both directions is checked against the sidecar origin
  and the iframe's own `contentWindow`, and every payload is schema-validated
  with strict allowlists — notably project-relative paths only, rejecting
  absolute paths, `..`, and URL schemes;
- the user picks a permission mode per session (ask for approval / approve for
  me / full access).

In scope: reaching the sidecar's loopback API without a valid token; leaking the
per-launch token to another local process, a web page, or a log; escaping the
path validation on the bridge so the agent reads or writes outside the project;
causing the agent to take an action the selected permission mode should have
required approval for; prompt-injection content in a document, a paper, or a
fetched page that reliably drives a destructive or exfiltrating tool call
without approval.

**Explicit non-guarantee, so nobody reports it as a finding:** the sidecar is
**not OS-sandboxed**. It is an ordinary child process with the user's own
privileges, and `src-tauri/Entitlements.plist` intentionally relaxes the
hardened runtime (library validation, JIT) because the bundled Node runtime
requires it. Approving an agent action, or choosing full-access mode, grants
real authority over your account. The agent also runs **your own installed
provider CLI** (for Claude, `scripts/prepare-synara-sidecar.mjs` replaces the
SDK's bundled executable with a launcher that execs `claude` from your `PATH`)
using that CLI's own credentials.

### 6. The Tauri capability and CSP surface

The WebView's authority is enumerated in `src-tauri/capabilities/default.json`,
and the Content Security Policy is set in `src-tauri/tauri.conf.json`
(`default-src 'none'`, `object-src 'none'`, `base-uri 'none'`,
`form-action 'none'`, `frame-ancestors 'none'`). Both are pinned by
`src/platform/tauri-security-config.test.ts`, so a change to either is a deliberate act.

In scope: a Tauri command reachable from the WebView that escapes the intended
project scope (path traversal in project, file, LaTeX, Git, or paper commands),
an `opener` scope escape (the allowlist is http/https/mailto/tel; opening a
local path is done from Rust precisely so the WebView never gets that
authority), a capability that grants more than its description claims, and
script execution in the main WebView — stored XSS through document content,
imported paper content, project chat, or comments matters here because
`script-src` includes `'unsafe-inline'`.

## Out of scope

- **The compiled-in shared Firecrawl key** (`LATTICE_FIRECRAWL_KEY`,
  `src-tauri/src/firecrawl.rs`). It is extractable from any shipped binary by
  design; that is a documented, accepted trade-off, rotated on abuse.
- **The two known issues named above**: the un-rotated updater signing key and
  the unencrypted Overleaf session file. Both are already public in `docs/`.
- **Availability of the maintainer-operated Worker**
  (`lattice-collab.paperlattice.workers.dev`). It carries no uptime or privacy
  guarantee, is not a hosted service, and denial-of-service or resource-
  exhaustion reports against it are not accepted. The same goes for Cloudflare
  account configuration of any self-hosted deployment.
- **Anything that requires the attacker to already have local code execution,
  root, or physical access to an unlocked Mac.** Reading your own app-data
  files, attaching a debugger to your own process, or extracting strings from
  your own copy of the binary is not a vulnerability.
- **Third-party services**: Overleaf, GitHub, Cloudflare, arXiv, OpenAlex, and
  AI providers. Report those to their own security teams.
- **Code the user chose to run**: your own `claude`/provider CLI, MCP servers you
  configured, skills you authored, and LaTeX you compile. `latexmk` runs your
  TeX distribution with your TeX configuration, including shell escape if you
  have enabled it.
- **Dev-only and unofficial builds**: `VITE_SYNARA_EMBED_URL` (debug builds
  only, hard-disabled in release), ad-hoc-signed local or fork builds, and
  Gatekeeper quarantine behavior for unsigned builds.
- **Missing hardening with no demonstrated impact**, e.g. "CSP allows
  `'unsafe-inline'`" or "the app is not App Sandboxed" on their own. Show an
  exploit path.
- **Automated scanner output without a working proof of concept**, and
  dependency advisories with no reachable call path. A reachable one is very
  welcome — as a normal
  [issue](https://github.com/leo1oel/lattice/issues), not an advisory.
- Missing security headers, missing rate limits, or best-practice checklists
  applied to a local desktop app without a concrete attack.

## Related documents

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to build, test, and submit changes
- [`docs/release-process.md`](../docs/release-process.md) — signing, notarization, and updater key handling
- [`docs/architecture.md`](../docs/architecture.md) — how the pieces fit together
- [`collab-server/README.md`](../collab-server/README.md) — deploying your own collaboration Worker
- [`README.md`](../README.md#collaboration-sync-host) — what transits the collaboration Worker while a share is active
