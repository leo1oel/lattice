# Synara fork ledger

What each Synara pin brought into Lattice's fork, and how the embedded panels
behave against the current pin. Each pin change adds or updates its entry here;
the pin procedure itself, the runtime boundary and the tool catalog are in
[`synara-runtime.md`](synara-runtime.md). Sizes and counts are dated
measurements; re-run the commands rather than quoting them.

## The current pin

The fork as a whole is **not** small. Measured on 2026-10-19 against upstream
`v1.0.7` (`b8cf9382d36ac1120b3fe16241cfd96189a9a71e`), the current integration changes
**753 files, +84,558 / −8,451 lines**. It carries embedded-workspace UI, a skills manager,
source-control and provider-health surfaces, spreadsheet and canvas tool brokers, and their
contracts. Treat "keep it in the seam" as the goal for new work. Re-measure after each sync:

```bash
git diff --shortstat v1.0.7 HEAD
```

The current pin is the upstream **1.0.7 stable release**, merged with the complete previous
`amp/lattice-v1.0.6-sync` history (which carries the earlier `amp/lattice-v1.0.5-sync`, `amp/lattice-v1.0.4-sync`, `amp/lattice-v1.0.3-sync`, `amp/lattice-v1.0.1-sync` and `amp/lattice-v1.0.0-sync` histories). Upstream's account-aware provider configuration and standalone
Code review inbox remain available. The embedded **Pull requests** view now uses that inbox,
waits for the open Lattice workspace to bind, and fixes its project filter to that workspace.
Its requests reach only that project's repositories. Authored and review-requested filters recover
paginated matches on the server when the shared repository superset is truncated; an incomplete
GitHub response is reported explicitly rather than silently treated as a complete filtered list.
Both Git views send `synara:embed-ready`; missing CLI/authentication shows its unavailable or
sign-in state without query retries.
In the embed, Changes composes the commit message in the panel (with `git.generateCommitMessage` behind "Write the message for me"), stages by checkbox and reads a paper's change as sentences; Pull requests groups the project's pull requests by what needs the writer and says why an empty list is empty; a pull request opens on "In the paper", a red-pen reading of its changed sentences with Comment, Approve and Merge.
The fork's `docs/lattice-git-embed.md` describes these views and the data they read. The inbox, its filters and the item detail follow the host
locale through the fork's Lingui catalogs (zh-CN included); GitHub content and agent prompts stay
as written. The narrow model picker retains account selection in upstream’s
new account-aware menu, and TeX, BibTeX, `.sty`, and `.cls` files retain their file icons.
The inbox, detail panes, sidechat dock, and portalled menus inherit Lattice's embed-theme surface
tokens; code and diff renderers also resolve the host theme without changing standalone Synara's
stored appearance preferences.
The agent panel and the Settings frame also accept the `lattice:host-theme` version-1 palette (tint, accent, and translucency as computed role colors) over `postMessage` and ask for it with `lattice:request-host-theme`; without one they keep the Graphite palette, and they stay opaque whatever the translucency.
Its optional `panel` role is the Settings sheet, under group cards on `elevated`; a runtime that predates it leaves the page on `elevated`.
Its optional `editor` role is the editor's page: in the light theme the agent's user bubbles, code, inline code, empty-thread starters and provider-status card sit on it rather than on `elevated`, which Graphite keeps pure white for menus; the dark theme keeps them on `elevated`.
Each frame holds the handshake it booted with (its config, the `#lattice-auth` credential and the last palette) for the life of its document; the `window.name`-keyed sessionStorage slot is only the copy a reload recovers from, so losing it can no longer repaint the panel with Synara's own white palette or strip the credential from attachment image URLs.
Providers, MCP and Skills follow the native Settings layout (a serif page title, each group's rows in one bordered card at 52px), and Settings tells their frame `lattice:settings-layout` `{compact}` when the window crosses its 680px breakpoint, since the frame sees only its own column width.

The pin also carries `amp/lattice-cursor-no-autologin`: Cursor's startup model discovery and background text generation use ACP `authPolicy: "never"`, so a signed-out Cursor CLI no longer opens its sign-in page when Lattice starts (discovery falls back to `cursor-agent models`).

## Synara 0.9.1 compatibility

The 0.9.1 integration includes the upstream Opus 5.5 and GPT-6 Sol/Luna catalog updates, OpenCode startup fixes, and projection/provider/sidebar optimizations.
Model availability still depends on the installed provider runtime and account access.
Lattice already wrote server-settings migration version 3 before this upgrade, so existing version-3 Git-writing selections remain unchanged; new settings use upstream's GPT-6 Luna default.
The compile-repair model remains a separate setting, and the [Computer Use boundary](synara-runtime.md#computer-use-boundary) is unchanged.
The new batched thread-shell query preserves Lattice's `pendingMessageId`, with a regression covering latest-turn ties, duplicate and missing thread IDs, and null versus populated message identities.
The project-import announcement never opens automatically in Lattice embeds, even when a loopback-port change makes its dismissal storage unavailable; manual import remains available.

## Synara 0.9.2 compatibility

The 0.9.2 integration retains Lattice's host contracts and incorporates persistent provider model catalogs, restart-orphaned turn recovery, scoped session approvals, credential redaction on approval cards, and hardened stdio/frame transports.
The previous fork's sent-message anchoring and wide-chat navigation fixes remain in the upgrade history.

Lattice uses the Stable feature boundary on both the server and embedded web surface.
Upstream otherwise treats a loopback HTTP host without a Synara desktop bundle identity as a standalone host and enables Beta-only features.
OMP remains unavailable in Lattice, and the embedded UI does not show the Beta welcome or installation surfaces.
Synara 1.0.0 moved Inbox and Auto-fix CI into Stable, so Lattice's embedded pull-request controls now offer upstream's opt-in Auto-fix CI watcher.
Synara 1.0.1 moved Tasks into Stable as well; it lives in the standalone sidebar and Inbox, which Lattice does not embed.
Synara 1.0.2 moved Hubs (formerly Groups) and their Library into Stable, so no feature is Beta-only any more; Hubs live in the standalone rail and sidebar, which Lattice does not embed either.
Standalone Synara retains its upstream flavor behavior, and the [Computer Use boundary](synara-runtime.md#computer-use-boundary) remains unchanged.

## Synara 1.0.3 compatibility

The 1.0.3 integration (through 1.0.2) adds compact subagent run cards and background-task rows to the transcript, turn headers for stopped and interrupted turns, a follow-up queue that pauses after Stop, an error or a usage limit, faster transcript recovery, and Claude's optional cold-cache resume prompt (**Ask before resuming a long idle session**, under the Claude provider settings).
Their embedded-panel copy is in the zh-CN catalog.
Upstream's chat-managed Tasks tools (`synara_create_todo`, `synara_list_todos`, `synara_update_todo`) have no Lattice alias, so `adaptToolsForActiveHost` drops them: Tasks has no surface in Lattice, and a to-do list the writer cannot see would only confuse the agent's task vocabulary.
Provider enablement stays ungated in the Lattice profile; the new per-account instance list still reaches the gateway and External MCP callers.
The fork treats `defaults read com.openai.codex` answering "Domain … not found" (macOS 27's wording for a user who never ran Codex) as no managed preference, so Proofread's isolated Codex path no longer fails closed there.

## Synara 1.0.4 compatibility

The 1.0.4 integration adds faster long-chat opening and steadier scrolling: unmeasured transcript rows get a content-aware size hint through upstream's `@legendapp/list` patch, which the fork's patch file now carries together with Lattice's floating-composer anchoring dependency, and the open chat subscribes once at startup instead of twice.
A quit marks a running turn interrupted; after an unexpected stop (Lattice or the sidecar killed mid-turn), the next start sends the chat a guarded continuation that tells the agent to verify what already completed. The fork lets that recovery find the running turn's request through its pending message, which upstream's stored messages do not link, and the continuation names Lattice rather than Synara because it reaches the model. Codex turns also survive delayed terminal notifications.
The Lattice host policy now tells the agent to repeat `wait_for_tasks` with the returned run ids until every delegated task is terminal, as upstream's own policy does.
The sidebar's **Working and unread on top** ordering, browser tabs that keep their page, and Hubs keeping their chosen access mode are standalone surfaces that Lattice does not embed.
Inline visuals (`synara_show_visual`) were Beta-only in 1.0.4, so the Stable feature boundary kept them out of Lattice; the Computer Use paste and recovery fixes leave the [Computer Use boundary](synara-runtime.md#computer-use-boundary) unchanged.
Pi still runs on its SDK without a CLI probe, but now reports "not set up" (localized in zh-CN) when neither an instance API key nor a configured Pi credentials or models file exists, instead of showing ready.

## Synara 1.0.5 compatibility

The 1.0.5 composer is a single pill row (+, draft, microphone, send) for every chat in the embed, since the embed has no centered landing; it grows into the block layout for a second line or a long draft, and Lattice's empty-thread starters stay above it.
Activity above the input (live changes, tasks, workflow, goal, tips, Auto-fix CI, reconnecting) floats as capsules whose panels open in popovers; queued follow-ups keep the stacked rail, and the Lattice context bar floats above them all.
The row under the composer carries the model picker and context ring; the embed leaves out upstream's permission menu there, because Lattice's Agent header owns the permission mode.
The /, @ and + menus and the capsules take Lattice's composer surface (`--lattice-agent-composer-surface`), opaque like every embedded panel, and the embed's placeholder names Lattice.
Inline visuals moved into Stable, so the Lattice profile now offers `synara_show_visual` as `show_visual`; the host policy tells the agent to prefer component blocks and to send HTML only for what blocks cannot draw.
The profile's branding rewrite makes the agent place a `lattice-visual` fence, which the transcript accepts beside `synara-visual`.
Upstream runs HTML visuals only in Electron, whose subframe guard stops a page that navigates its own frame (carrying data in the URL) before the request.
The fork gives every HTML visual that guarantee in any engine: the transcript frame loads a host document under the visual's content security policy, whose only child is the visual's own frame, so the visual's navigations are checked against that parent's `frame-src 'none'` and refused before anything is sent (`buildInlineVisualHostDocument` in the fork's `packages/shared/src/inlineVisual.ts`).
Both frames are `srcdoc` documents sandboxed with `allow-scripts allow-forms` only (never `allow-same-origin`, popups, or top navigation), so the visual has an opaque origin with no access to the panel, Lattice, cookies, storage or the host bridge; the policy blocks every network load, and the host page relays only messages between the panel and the visual, where only the size, scroll and stop notifications are acted on.
The bootstrap also removes any frame the visual nests before it loads, since a nested window would bring back the WebRTC constructors CSP cannot govern.
The visual's toolbar copies its source, saves it as HTML, and expands it, and Lattice does the last two: WebKit cancels a download from a frame, so the panel posts `synara:save-visual` `{filename, html}` and Lattice saves it through a save panel (`save_agent_visual`), refusing sources over the runtime's 256 KiB limit; and the panel is often too narrow to enlarge a visual inside it, so it posts `synara:expand-visual` `{title, html, document}` and Lattice loads that host document, unchanged and under the same sandbox, in a dialog over its window (`src/agent/agent-visual-dialog.tsx`), reading nothing from it but its reported height and an Escape the page left alone.
Both messages are parsed in `src/agent/agent-visual-save.ts`; an expand request whose document does not begin with the visual policy is ignored.
The animated ASCII background and its Appearance switch belong to the standalone empty landing, so the embed keeps its own empty thread; the Activity Priority section and its `mod+alt+a` cycle, the sidebar without subagent rows, remote MCP connectors (Beta-only) and browser focus fixes are standalone surfaces too.
When a provider handoff is refused because the source still runs background tasks, the composer offers **Stop tasks and switch**.
Without Lattice changes, 1.0.5 also pins Claude's **Ask for approval** to Claude Code's default permission mode, stops double-counting Claude usage (cache reads are reported apart), and resolves a chat's task state in one pass so task-heavy chats open faster.
`device_wait`, `device_logs` and `device_configure` join the allowlisted simulator tools, since the existing device tool descriptions now point to them.
The new strings that render in the panel are in the zh-CN catalog.

The Agent header's usage chip shows what is left of the active provider's tightest window, and hovering it lists every window the provider reports (Claude's 5-hour, weekly and per-model windows; Codex's 5-hour and weekly) with its reset countdown; the ring beside the model picker shows context use.
For a draft the chip follows the composer's model. It stays hidden while the provider reports nothing, and the usage read never holds up the panel or a turn.
A wrapper `claude` that sets `CLAUDE_CONFIG_DIR` only for its own child (an account switcher, for example) keeps the login in a config-dir-scoped Keychain item Synara cannot name, so usage used to read "not signed in" and the chip never appeared.
The fork now asks the configured `claude` for `/usage` through the Agent SDK whenever no stored credential works: no settings sources run, the read holds the auth-status lock, and a CLI that cannot answer is not asked again for ten minutes.

Changes lists, stages and commits from Git's own file list rather than from the staged and unstaged patches.
`git.readWorkingTreeDiff` now returns each of those scopes' files (`--name-status -z`, `--numstat -z` and the untracked files: raw paths, status, line counts) beside the patch, and reads a single listed file when given `filePath`.
A working tree whose unstaged patch passed the 1 MB response cap used to parse to no files and read "Everything is committed" with no list or commit form; it now lists every file, says the preview was cut, and loads a cut-off file's change when it is opened.
Git C-quotes non-ASCII, quote, tab and backslash names in patch headers, so a file such as `…-中文.tex` showed as `…-\344\270\255\346\226\207.tex` and Stage sent that string to `git add`, which matched nothing; rows now show and act on the raw name, a rename stages, unstages and commits both of its paths, and the pull request redline decodes those headers too.
The clean state also waits for `git.status` to report a clean tree.

## Synara 1.0.6 compatibility

1.0.6 is a reliability patch, and none of it adds an embedded surface.
Long chats stop rescanning their activity history on streaming and checkpoint paths, so opening and streaming into a long conversation costs less.
RPCs from the panel now wait in bounded first-in-first-out queues by request class instead of being rejected and retried, and repository and workspace-file refreshes are throttled with a final trailing read; the server-busy popup and its client heartbeat are gone, so the panel no longer raises that notice (the fork drops its localized copy of it).
The classification of requests moved into the shared package, so the fork's `/mcp` list and action requests and commit-message generation are classified as expensive reads there, as they were in the server before.
Runtime reconciliation keeps the live turn owner and pages through stale candidates, a provider handoff settles known outcomes without replaying them, and a partial model catalog no longer overwrites a complete one, which also discards the old cached catalog once.
Claude's model controls follow the effort, adaptive-thinking and fast-mode metadata of the installed CLI; the picker the embed shares drops the old synthetic "Default" effort, and an unset effort leaves Claude Code's own default in charge.
Git diff reads pin the `a/` and `b/` prefixes whatever the user's Git configuration says, including the per-file reads behind Changes.
Codex moderation metadata no longer becomes chat activity, and Antigravity quota (not offered in Lattice) uses the matching OAuth client.
The ASCII landing fading around the composer belongs to the standalone empty landing, which the embed replaces with its own empty thread.
Upstream turned the /, @ and + menus into opaque popovers and dropped the `chat-composer-menu-surface` class; the fork keeps that class as a style-free hook, so the embed still gives them the host-themed composer surface (`#fafafa` in the light theme) instead of the popover white.
1.0.6 adds no strings that render in the panel, and removing the server-busy popup retires its zh-CN entries.

## Synara 1.0.7 compatibility

1.0.7 is a performance and recovery patch, and none of it adds an embedded surface or a string that renders in the panel, so the zh-CN catalog is unchanged.
Long turns bound their repeated Git, event-history and checkpoint work: Claude keeps turn identifiers instead of every SDK message body, usage reads cache unchanged files and parse appended records (the fork's `/usage` fallback for a wrapped Claude login sits on top of that read), and live file-change captures share a three-second per-thread throttle with a trailing capture, so the panel's live-changes count updates at most about every three seconds during an edit burst.
Streaming Markdown splits an answer into settled top-level blocks and reuses them as it grows; upstream shifts each block's source positions so find offsets and task-list line numbers match a single parse, and the fork's transcript keeps the follow-up chips on the last reply by passing the last message id through the timeline's row context.
Read-only tools no longer refresh Git, and pull-request status refreshes at turn end, branch changes, focus and on a regular poll; the embedded Changes and Pull requests views keep reading Git's own file list.
Devin and Grok model switches start a fresh native session instead of resuming an incompatible one, Droid avoids a duplicated transcript bootstrap, stopped-but-retained OpenCode sessions no longer trap later turns, and a moved or missing project folder is reported as such before executable resolution instead of as a missing Claude installation.
A message edit that restores an earlier Git workspace first keeps a hidden recovery checkpoint, and refuses the edit if it cannot capture one, retained under a hidden Git ref (never shown in the chat or in Changes).
Desktop frame capture and browser-console quiescing, Windows process observers and Beta connector token reuse are standalone or Beta-only surfaces that Lattice does not embed.
