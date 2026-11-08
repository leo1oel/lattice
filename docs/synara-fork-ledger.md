# Synara fork ledger

What each Synara pin brought into Lattice's fork, and how the embedded panels
behave against the current pin. Each pin change adds or updates its entry here;
the pin procedure itself, the runtime boundary and the tool catalog are in
[`synara-runtime.md`](synara-runtime.md). Sizes and counts are dated
measurements; re-run the commands rather than quoting them.

## The current pin

The fork as a whole is **not** small. Measured on 2026-11-07 against upstream
`v1.1.0` (`b6aa37bc82eec649dd527c5956fdccc2c63d3b24`), the current integration changes
**781 files, +73,039 / −8,710 lines**. It carries embedded-workspace UI, a skills manager,
source-control and provider-health surfaces, spreadsheet and canvas tool brokers, and their
contracts. Treat "keep it in the seam" as the goal for new work. Re-measure after each sync:

```bash
git diff --shortstat v1.1.0 HEAD
```

The current pin is the upstream **1.1.0 stable release**, merged with the complete previous
`amp/lattice-v1.0.9-sync` history (which carries the earlier `amp/lattice-v1.0.8-sync`, `amp/lattice-v1.0.7-sync`, `amp/lattice-v1.0.6-sync`, `amp/lattice-v1.0.5-sync`, `amp/lattice-v1.0.4-sync`, `amp/lattice-v1.0.3-sync`, `amp/lattice-v1.0.1-sync` and `amp/lattice-v1.0.0-sync` histories). Upstream's account-aware provider configuration and standalone
Code review inbox remain available. The embedded **Pull requests** view now uses that inbox,
waits for the open Lattice workspace to bind, and fixes its project filter to that workspace.
Its requests reach only that project's repositories. Authored and review-requested filters recover
paginated matches on the server when the shared repository superset is truncated; an incomplete
GitHub response is reported explicitly rather than silently treated as a complete filtered list.
Both Git views send `synara:embed-ready`; missing CLI/authentication shows its unavailable or
sign-in state without query retries.
In the embed, Changes composes the commit message in the panel (with `git.generateCommitMessage` behind "Write the message for me"), stages by checkbox and reads a paper's change as sentences; Pull requests groups the project's pull requests by what needs the writer and says why an empty list is empty; a pull request opens on "In the paper", a red-pen reading of its changed sentences with Comment, Approve and Merge.
The fork's `docs/lattice-git-embed.md` describes these views and the data they read. The inbox, its filters and the item detail follow the host
locale through upstream's interface catalogs (see the 1.1.0 entry); GitHub content and agent prompts stay
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

On WebKit the composer draws its own caret (`ComposerDrawnCaretPlugin`): WebKit stretches the native caret on every line after a paragraph's first up through the leading above it, so in Lexical's one-paragraph composer it stood a full line pitch tall. The drawn 2px bar takes the glyph height of the text at the caret, hides for range selections, and gives the native caret back during IME composition; Chromium keeps the native caret.

The agent panel keeps Claude Code warm only while Lattice shows it. Lattice posts `lattice:agent-panel-visibility` `{visible}` when the frame is ready and on every change (the panel behind another tab, collapsed or hidden), because the frame stays mounted and its own `visibilityState` follows only the window.
Only a panel that is shown, in a visible window, reports its thread to the server (which keeps that thread out of the idle stop) and starts Claude ahead of Send; a panel hidden for 30 seconds gives its thread up, which stops an unused warm runtime, and the frame treats itself as hidden until Lattice first says otherwise.
A new chat's warm runtime is adopted by its first send only while every setting Claude Code reads at spawn (`claudeLaunchSettings`: "Load my MCP servers", process priority and the disabled skills) still matches; otherwise the send starts a fresh one, and the panel's next report re-warms the draft under the new settings.

The panel answers `lattice:composer-prompt` (version 1), which lets Lattice put a prompt in the agent composer or send it, in the active chat or a new one, for Open Slide's in-canvas agent buttons.
A draft fills an empty composer or goes on a new line under the user's text, and focuses the composer; an empty draft only focuses it.
A send goes through the composer's own Send with the selected provider, model and access mode and the Lattice host context, but as its own queued turn, so the user's unsent draft is neither sent nor cleared; behind a live turn it waits in the queue.
An unavailable provider or a failed send leaves the prompt as a draft instead; behind a pending question or approval it joins the saved draft the composer returns to, so it never becomes an answer.
The composer takes focus only once the panel frame has it, so Lattice focuses the frame when it wants the cursor there.
Each request gets one `synara:composer-prompt-result` with the outcome (`drafted`, `sent`, `queued`) or an error code (`invalid`, `workspace-mismatch`, `no-provider`, `awaiting-input`, `send-failed`).
Only the panel's focused chat answers, so a side chat or a second split pane never acts on the same request.
The slide host context now types Open Slide's `pendingComments` and `previewUrl`: a malformed comment or link is dropped on its own instead of the snapshot, and the composer's context details count the comments ("3 comments", zh-CN "3 条评论").

The panel posts `synara:turn-activity` (version 1) for its active thread, so Lattice can show the agent at work on an Open Slide canvas: `state` is `running` while the latest turn is live, `waiting` while that turn has a pending approval or question, and `idle` once it completes, is interrupted or fails.
It also names the `workspaceRoot`, `threadId`, `turnId` and the session's `provider` (`id` is Synara's provider kind such as `claudeAgent` or `codex`, `label` its display name such as "Claude"), and, while a tool call is in flight, `tool` with its title, a one-line read target or command as `detail`, and the file paths it reads or writes relative to the workspace root (an edit's files, or the file a shell command such as Codex's `sed -n 1,5p` reads; paths outside the workspace are dropped); no tool input contents or output are sent.
A tool that starts and ends between two sends is never reported in flight.
Messages go out at most four a second and the trailing one is always the current state, so the final `idle` is never lost; a thread the panel switches away from, or a closed chat view's, gets an `idle` first, and a remounted chat view re-sends its state once.

The pin also gives the agent `preview_latex_figure`: it sends a figure's body (with extra preamble lines, the document whose preamble to use, the line width, and optionally the caption, label and placement) to Lattice, which typesets it alone and answers with a PNG that reaches the model as image content (see [the agent tool boundary](synara-runtime.md#agent-tool-boundary)).
It rides the presentation channel as the action `preview_figure`, since that broker, its result route and the web relay already carry one rendered image back per request, and the broker's timeout message now names a preview rather than the presentation tool.
The host policy tells the agent to preview every figure it draws or changes, fix what reads badly in the image, and insert the `figure` environment the tool returns with its ordinary file edit.

Claude gets Lattice's bundled skills natively, as Codex already did through `skills/extraRoots/set`. Each Claude session loads a local plugin named `lattice` from `claude-skills-plugin/<hash of the served set>/` under the Synara home (the SDK `plugins` option, with MCP discovery off), which links every enabled skill from `SYNARA_BUNDLED_SKILLS_DIR` and `~/.synara/skills`; nothing is written to `~/.claude` or the project.
Claude lists them as `lattice:<name>` and can load one itself; the host context's `presentationAuthoring.claudeSkill` names `lattice:authoring-presentations` for that reason, beside the bare `skill` name Codex uses.
A skill turned off in Settings (`skills.disabled`, so research-writing by default) stays out, and a toggle reaches the next session, not a running one; the disabled set is one of the `claudeLaunchSettings`, so a warm draft spawned before a toggle is not adopted.
Naming a served skill with `$` adds a short pointer to its `lattice:` name (and its path) instead of pasting the SKILL.md; any other skill is still inlined.
The listing costs about 555 characters (two skills, about 140 tokens) in the first user message's cached block; the system prompt and tool list are unchanged.

Every embedded frame (the Agent panel, the Git drawer's views, Settings' pages) leaves Lattice's own shortcuts to Lattice. It asks for them with `lattice:request-host-shortcuts`; Lattice answers, and sends again whenever the set changes, `lattice:host-shortcuts` (version 1) with the keys its window's command table can run at that moment, each as `{key, mod, ctrl, shift, alt}`.
A capture listener installed before the first render stops such a key ahead of every Synara binding and posts it back as `synara:host-shortcut` (`key`, `code` and the four modifier flags); Lattice dispatches it again on that frame's iframe element, so it runs as if pressed beside the frame, and drops one it does not run at that moment.
So with focus in a frame ⌘P is quick open rather than Synara's file search, ⌘1 the first workspace rather than a thread, and ⌘K, ⌘S, ⌘, and ⌘W work at all; a key Lattice does not claim (⌘F, ⌘C, ⌘Z) keeps its meaning in the frame.

The embedded frames now keep their local-only state across Lattice launches.
Lattice's window is `tauri://localhost` and the frames are `http://127.0.0.1:<port>`, so they are third-party and WebKit gives them partitioned localStorage that it drops when Lattice quits, whatever the port: every launch used to start from the default provider, sticky model and effort, hidden and ordered providers, and no drafts.
In the embed, `apps/web/src/bootstrap.ts` now reads the server's copy (`GET /api/lattice/embed-storage`, bearer-authenticated like the other Lattice relays) before any store hydrates, imports it into keys the session has not written, and mirrors changes back about once a second (`POST`, plus on `pagehide`); each frame mirrors independently, and the server keeps the newest reading of each key.
The copy is `userdata/lattice-embed-storage.json` under the Synara home, mode 0600, and holds only `synara:`/`synara.` keys within the desktop origin migration's bounds (2,048 entries, 16 MiB); Lattice reads none of it, and standalone Synara never calls the route.
A change in its last second before quit can still be lost, and the large pasted images Synara keeps in IndexedDB rather than localStorage are not mirrored; a draft's text is.

Settings → Agent (Synara's Providers page) now starts its embed-only Generation defaults with **Default provider**, the provider new chats start on until a model is picked. It is the same row as Synara's General page, which Lattice does not frame; standalone Synara still shows it only on General. Lattice's settings search finds the page by that name.

A Claude turn that fails because Claude Code exited now says why, in plain words. Synara spawns Claude Code itself, so the Agent SDK never saw its stderr, and the card (and its **Copy error** text) read only "Claude Code process exited with code 1", about a millisecond after the turn started, whenever the `claude` Lattice runs died at startup; an outdated Claude Code that rejects one of the SDK's launch flags does exactly that (1.0.x rejects `--setting-sources`, 2.0.0 in Full access `--allow-dangerously-skip-permissions`).
The adapter now pipes that stderr (still copied to the sidecar's error log), keeps a bounded tail per process, and puts its most telling line, redacted, after the exit message, with a code the card turns into a localized line saying what went wrong and what to do: `claude_cli_outdated` (too old: run `claude update`), `claude_auth_required` (not signed in: run `claude auth login`), `claude_model_unavailable` (the account cannot use the model: Change model) or `claude_cli_failed` (stopped unexpectedly: run `claude -p hi`; also given when stderr was empty, under the generic text).
That line stays visible under the card's three-line clamp in the narrow panel, and Copy error includes it.
The Claude provider status also refuses a CLI older than the pinned SDK's flags (2.0.63, bisected against npm releases with Synara's real arguments): it reports "Claude Code <version> is too old. Run `claude update` in Terminal.", so the model picker shows Claude as needing setup, with **Open provider setup**, instead of offering models that fail at once. That line is kept short so the button stays inside the setup panel's 12.5rem height cap without scrolling. The check reuses the existing `--version` probe and skips the auth probe, so it adds no keychain read.

A model the Claude account cannot use is no longer offered again after it fails once. The picker lists Synara's static Claude catalog, so a model the account has no access to stayed selectable and every send with it failed with "There's an issue with the selected model".
When a turn fails with the Agent SDK's `model_not_found`, or Claude Code exits before a result with "There's an issue with the selected model" on stderr (`claude_model_unavailable`), the adapter records the model for that provider account, and ProviderHealth adds it to the account's status as the new optional `unavailableModels` field (`{model, reason, recordedAt}`), publishing at once.
The picker keeps the row but greys it with "Not available to your account" (zh-CN "你的账号用不了"), on the provider tab and on a starred preset; the composer moves to the provider's default model (or the first model not refused) without taking focus.
The entry clears only when a turn with that model succeeds, when the user rechecks the provider (`server.refreshProviders` with the new optional `explicit` flag, sent only by the sign-in window's status check and close: Settings → Agent → the Claude account → Sign in), when a refresh finds the instance's account changed (signed in or out, another auth method or subscription), or when the sidecar restarts (entries are kept in memory only). Automatic refreshes (the startup check 10 s after load, window focus at most every 15 s, the hourly check) keep it, or the model would be offered again within seconds and fail the same way. Synara's former "Refresh status" button on the Providers page is gone (removed with the fork's provider-enablement cleanup), so the embedded panel has no other explicit recheck. Entries cost no probe or keychain read, and a refresh keeps an entry recorded after it started.
The failed turn's card now also carries the localized next step for this code ("你的 Claude 账号用不了这个模型。请点「更改模型」换一个。"), which before covered only the stderr-classified `claude_model_unavailable`.
In a narrow panel the greyed row's reason truncates before the row's star instead of running under it, and the row's tooltip shows all of it.

Anthropic refusing the Claude account or the network it comes from is no longer reported as a missing sign-in. The API then answers 403 forbidden ("Request not allowed"); Claude Code prints "Failed to authenticate. API Error: 403 …" and the Agent SDK tags the turn `authentication_failed`, so the card used to say to run `claude auth login`, which cannot help.
Such a turn now fails with "Anthropic refused this Claude account or network (403 Request not allowed)." and the code `claude_access_forbidden`; the card's next step says signing in again is unlikely to help and to check the account's status or use another provider (zh-CN "Anthropic 拒绝了这个 Claude 账号或所在网络（403）。重新登录多半没用：请检查账号状态，或换用其他提供商。").
The stderr exit classifier checks for it before the sign-in check. `claude auth status` reads local credentials only and still reports a refused account as signed in (reproduced with Claude Code 2.1.296 against a mock API returning that 403), so the provider status stays ready; should a probe ever see the 403, it reports this refusal rather than unauthenticated.

Claude problems are now said next to the composer, where the writer is looking, not only in a clamped card, a banner at the top of the narrow panel, or a greyed row inside the model menu. One calm warning notice sits right above the composer (it wraps instead of truncating, and each problem can be dismissed), saying the most specific thing that applies: the composer just left a refused model ("你的 Claude 账号用不了 Fable 5.1，已自动换成 Sonnet 5。", with Change model, until the next send); Claude's status blocks sends (too old, signed out: the localized status, with Provider settings, while the top banner stays quiet); or the last turn failed for a Claude reason (403 refused, not signed in, too old, model refused, exited: that turn's next step, with Change model or Provider settings). While such a problem still blocks the next send, the model chip carries a warning mark with the reason in its tooltip. The allowance tip for a model switch stays quiet while the switched-model notice shows.

Usage refreshes no longer raise a macOS Keychain prompt every few seconds. Before, every usage poll ran `security find-generic-password` for "Claude Code-credentials" (and "Factory CLI" for a Factory login) several times, each read whose access list lacks `security` raised a "security wants to use the login keychain" prompt, "Allow" covered that one read only, and a denied read was retried on the next poll, so typing the password never stopped them.
The server now reads each Keychain item at most once and keeps the answer in the sidecar's memory (`apps/server/src/providerUsage/keychainReads.ts`, for Claude, Codex, Cursor and Factory): a granted secret is reused for 12 hours (and re-read once only when the token it carried is found expired or rejected), concurrent refreshes share one read, and a denied or failed read is not tried again until the user presses Refresh on the usage page (`forceRefresh`), which Lattice frames as Settings → Agent → Usage & limits, or the sidecar restarts with Lattice; a rewritten credential file re-checks only an item that was absent, never a denial. `security` now gets 60 seconds instead of 5, which killed it while its prompt was still open, so a password typed after that reached no one.
In the embed that usage page hides its sidebar-only rows (the sidebar usage accounts and the sidebar ring choice), since Lattice embeds no Synara rail or sidebar for them to change (fork `164c06dbb856aba95e7b967f5d6e5cb273900ae0`); it keeps the popover options, Refresh and the provider cards, and standalone Synara is unchanged.

The panel now finds Claude Code and Codex where they usually live, even when the login shell's PATH leaves them out, and says how to link one when it finds neither (fork `dc74f1f3f57ba84a0d43556ff866dae2a52c6633`, [fork PR 6](https://github.com/leo1oel/synara/pull/6)).
The sidecar's PATH came only from `<shell> -ilc 'printenv PATH'` at server start (cached by rc-file fingerprint for up to 7 days), so a CLI was "not installed or not on PATH" whenever that shell did not export its folder non-interactively: Apple-silicon Homebrew (`/opt/homebrew/bin`, including `brew install --cask codex`) set up outside the zsh files, nvm loaded lazily or only from `.bashrc` under a bash login shell, mise's prompt hook, PATH set only in `config.fish` while the account shell is zsh, Claude Code's native `~/.local/bin` install without its PATH line, its older `~/.claude/local` install reached through an alias, an npm prefix without a PATH line, an rc slower than the 5-second probe, an nvm default switched since the PATH was cached, or a CLI installed while Lattice ran.
After hydration the server now appends the existing folders of a fixed list (`packages/shared/src/cliInstallDirectories.ts`: `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, the `~/.npmrc` prefix bin, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.asdf/shims`, mise's shims and nvm's default-version bin), after every entry already there, so the writer's own PATH order always wins; no rc file runs. It appends again before every provider status refresh (only `stat`s), so a CLI installed while Lattice runs is found by the panel's Check again, by showing the panel again, or by the focus and hourly refreshes, without a restart.
When every enabled Claude Code and Codex status says its CLI was not found (also when a binary path set in Settings is wrong) and no other provider is ready, the composer notice says "Lattice can't find Claude Code or Codex" (zh-CN "Lattice 找不到 Claude Code 或 Codex"), whichever provider is selected: each agent with one copyable install command (wrapped, not cut off, in a narrow panel) (Claude Code's `curl -fsSL https://claude.ai/install.sh | bash`; Codex's `npm install -g @openai/codex`, or `brew install --cask codex`) and its sign-in command (`claude auth login`, `codex login`), where Lattice looks, **Set path…** and **Check again**; in a short panel the title and the two actions stay in view and the steps between them scroll. The top provider banner stays quiet meanwhile.
**Set path…** posts `synara:open-settings` with the new optional `target: "provider-binary-paths"`; Lattice opens Settings → Agent → Providers and sends the target with its `lattice:set-settings-section` request; the page opens Claude Code's and Codex's Provider tools rows and answers `synara:settings-reveal` `{section, top, contentHeight}` with the top of Claude Code's binary path field (its label), and Lattice scrolls its Settings viewport there; Codex's field is in the row above. A runtime pinned before it ignores `target` and opens the page's top; a Lattice that predates it ignores the reveal.
**Check again** is `server.refreshProviders` with `explicit` (it also forgets refused models, as the sign-in window's recheck does); showing the panel while the notice is up runs an automatic refresh too. Both re-run only the existing status probes, so they add no keychain read; with no CLI found, the probes stop at `--version`.

A long draft no longer pushes the composer out of the top of a short Agent panel (fork `b9b10778968a38c25e7542ddb117bdd6a8601315`, [fork PR 8](https://github.com/leo1oel/synara/pull/8)).
The composer floats at the bottom of the panel and grows upward, and its editor began scrolling inside itself only at a fixed 200px; the Agent panel shares its column with Papers, so it is often shorter than the composer's full height (about 300px with the model row), and the composer kept growing under the thread header and past the frame's top until the draft was clipped away. A narrower panel wraps the same text onto more lines, so it got there with less text.
The editor's cap is now the smaller of 200px and the room the chat column leaves it, never under two lines (`useComposerEditorRoom` in the fork's `apps/web/src/components/chat/composerEditorRoom.ts`, written to `--composer-editor-max-height` on the composer form); a panel tall enough for the full composer is unchanged.

The history menu (the chat title's history popup) now lists the open folder's Claude Code and Codex sessions started in other editors, under **From other editors** (zh-CN "来自其他编辑器"), and choosing one continues it as a chat of the project (fork `e65411ae69a15eb8fb3d82bb983df344905ce412`, [fork PR 7](https://github.com/leo1oel/synara/pull/7)).
Discovery is read-only and reads only that folder's sessions (`apps/server/src/provider/folderSessionDiscovery.ts`): Claude's `<config dir>/projects/<the folder with every non-alphanumeric as "-">/*.jsonl` (a bounded head and tail read each), and Codex's `<base home>/sessions` walked newest first, reading only each rollout's first record (`session_meta`, up to its first newline) and stopping after 2,000 files, with the head read only for this folder's sessions. Titles come from a `/rename`, `session_index.jsonl` or the first prompt: the first untagged text part of the first user message, so the IDE context the VS Code extension sends ahead of what the user typed (`<ide_opened_file>…`) is skipped (fork `32a6171923f8d5371cb035dd816b495ef191547b`, [fork PR 9](https://github.com/leo1oel/synara/pull/9)). A session counts only when its recorded cwd is the folder itself, so a subfolder, a parent, or another folder whose Claude directory name collides never shows. Every enabled account is scanned (each Claude or Codex account's own home), at most 20 sessions per provider; a session some live chat already continues is left out, and empty sessions are skipped.
`orchestration.listFolderSessions {projectId}` runs each time the menu opens (and retries a failed scan while it stays open, since the first opening can race the service's startup); `orchestration.openFolderSession` re-discovers the session for that project before trusting its id, creates a chat in the project, and hands it to upstream's `importThread`, which resumes the native session and imports its history into the chat. Codex now resumes in place there (`continueInPlace`), as Claude already did, so the chat keeps the session's own id: `claude --resume` or VS Code and Lattice continue one conversation, and only the agent CLI, on the next turn, writes to its store. A resume that fails deletes the new chat; a session listed as "Untitled session" opens as "Claude Code session" or "Codex session" (fork PR 9). Synara's sidebar import still forks Codex.

The rate-limit notice above the composer keeps its close button on its first line at every panel width, and is written entirely in the interface language with a readable reset time ("Approaching rate limit (92% used). Resets in about 47 h.", zh-CN "即将达到速率限制（已用 92%）。约 47 小时后重置。"; minutes under an hour, hours under two days, days beyond) (fork `4594911aec9a7f710d062199673e5188ddd237ad`, [fork PR 10](https://github.com/leo1oel/synara/pull/10)). Before, the shared `AlertAction` dropped below the text under Tailwind's 640px `sm` breakpoint, which the panel's iframe always hits, and the percentage and the reset time ("Resets in 2822m.") were hard-coded English. The strings are new `lattice` catalog entries; only `RateLimitBanner.tsx` changes.

When the installed Codex is older than 0.153.0, the model picker's Codex tab says so in one status line, "Update Codex to 0.153.0+ to use GPT-6 Astra" (zh-CN "将 Codex 升级到 0.153.0+ 以使用 GPT-6 Astra"), above its list and its empty search (fork `66cacbd9e96039b8737a8c61033f95a9139d2a65`, [fork PR 11](https://github.com/leo1oel/synara/pull/11)).
The tab lists exactly what Codex's `model/list` returns, which replaces the static catalog that already names `gpt-6-astra`, and Codex's own catalog gives GPT-6 Astra `minimal_client_version: 0.153.0`, so an older Codex left it out with no word why ([#685](https://github.com/leo1oel/lattice/issues/685)).
The check reads the version the Codex status probe already reports (`codexNeedsUpdateForAstra` in the fork's `apps/web/src/components/chat/ComposerModelPicker.logic.ts`); an unknown or unparseable version shows nothing. Astra is not added to an older Codex's list, since those clients lack the tool modes it needs.

In the Git drawer, the empty states of Changes and Pull requests sit centred in the panel's height, a little above the middle, instead of 24px from the top with most of the panel empty below (fork `58f34d951baddad6757284e702bb96de21ae9e1c`, [fork PR 12](https://github.com/leo1oel/synara/pull/12)).
A panel too short for one starts it at the top and scrolls rather than clipping its drawing, and an empty state above a list (closed pull requests under "No open pull requests") keeps its place at the top. Only `.lattice-git-empty` in the fork's `apps/web/src/index.css` changes; `GitRepositorySetup.browser.tsx` checks both heights.

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

## Synara 1.0.8 compatibility

1.0.8 adds a running-subagents capsule above the composer: while any of the chat's subagents works, during the turn or after it settles, it reads "N agents running" and scrolls to the newest one's card when clicked. Its copy is in the zh-CN catalog.
The turn's diff is complete while the turn still runs: the live-changes capsule opens the captured patch of the running Codex turn instead of a partial one.
Codex warnings that are not tied to a turn (approval-review and native runtime warnings) show in the chat, and a Codex chat whose resume falls back to a fresh session gets its transcript context back.
Provider switches from the model picker go through Hand off, so a switch that cannot happen yet is refused with a localized notice that says why.
At 768px and wider the panel's open-thread tabs gain a trailing + that starts a new chat in the same project (localized).
Upstream also closes the active tab on Cmd/Ctrl+W, but the fork leaves that chord to Lattice in the embed at every width, so it still reaches Lattice's own File ▸ Close Tab, as it does in a narrow panel.
The access-mode notices a Lattice permission change can raise are localized too.
Upstream's Code OSS editor (Monaco with language services and a debugger) is Beta-only: the server refuses its RPCs and the web client keeps the Pierre engine on Stable, so Lattice never loads it. Its web client still ships in the bundle; the TypeScript compiler its language worker needs is pruned from the staged server.
Hubs keeping requests and follow-ups together, Devin background work, the Environment panel's project actions and the top-bar visibility settings, Safari and Hyprland setup, and the sidebar and Spaces fixes are standalone surfaces that Lattice does not embed.
Server-side, agent-booted simulators shut down once a turn settles and they are idle, terminals with large process tables are reused, SQLite reclaims deleted pages conservatively, and a retired per-turn MCP write credential is recovered and diagnosed.

## Synara 1.0.9 compatibility

1.0.9 puts the Code OSS editor engine (editable files, diffs and previews, TypeScript and JavaScript intelligence, JavaScript debugging) and Settings → Connectors in Stable. The embed opens files in Lattice's own editor and exposes neither a Connectors pane nor a debugger, so none of it loads in the panel; the turn diff keeps its read-only viewer. The server's `editor.*` RPCs now answer on Stable, but nothing in the embed calls them, so the TypeScript compiler stays pruned from the staged server (the build still fails if a bundle other than the language worker imports it) and the staged runtime stays at 168.4 MB.
`/goal` in an idle persisted chat now commits a visible "Goal …" message and starts the first turn; its confirmation toast is localized.
Stop retries stay attached to their original runtime and turn, interrupt-only controls keep queued messages (the queue shows paused with Continue and Edit), command progress keeps its identity across recovery, and provider errors read plainly. After a host restart mid-turn the chat shows the error with "Continue task".
OpenCode sign-in and cold model discovery use private servers, pre-migration SQLite backups are compressed, and local project favicons become project glyphs in the standalone sidebar.
Hub workers omit Snooze and Hub actions, and the landing pattern runs continuous beneath the composer, both standalone surfaces.
The toolchain moves to Bun 1.4.4; Lattice's pin, release workflows and preparation message follow.
A new chat pre-warms Claude before its first send creates the thread. The gateway lets that draft's own credential initialize and list the `lattice` tools until then, and refuses its tool calls until the thread exists. Before this, the warm session had no `mcp__lattice__*` tools for the whole chat.
Claude's policy now gets the `show_visual` line whenever Codex's does, and the `<lattice_active_context>` block no longer carries the refresh `requestId`.

## Synara 1.1.0 compatibility

1.1.0 ships its own interface catalogs (i18next, English, Spanish and Simplified Chinese; Chinese is Beta-only in upstream's desktop builds, gated by desktop flavor). The panel now uses them: the fork's Lingui catalog (2,289 zh-CN entries) is gone, and strings whose English matches an upstream message take upstream's key and Chinese.
What upstream does not translate (Lattice's Git, pull request, Skills, MCP, empty-thread and provider-usage adaptations, about 800 messages) lives in a `lattice` namespace beside upstream's catalogs (`packages/shared/src/locales/<locale>/lattice.json`; Spanish repeats the English, since Lattice ships no Spanish).
`apps/web/src/i18n/latticeZhOverrides.json` (35 entries) keeps Lattice's wording where upstream's Chinese contradicts the terms Lattice's own interface uses (PR rather than 拉取请求, AI 助手 and 子助手 rather than 智能体, 工作树 rather than worktree; upstream's 技能 matches Lattice's Skills page and stays) or the meaning in context (PR **Approve**, "Never" used, the PR **Conversation** tab, "pull/rebase", and Synara named inside Lattice). The diff panel's scope labels (本轮差异, 工作区, 未暂存), which upstream leaves in English, are translated at display.
The panel follows the language Lattice puts in the handshake (`?locale=`), whatever the OS language or a saved preference says; upstream's new Settings → General → Language row is hidden in the embed. Upstream's `bun run i18n:check` and `i18n:extract --check` pass with the overlay.
Upstream's "Resume after usage limits" (off by default) appears in Settings → Agent → Providers, Performance group. Its waits are server-owned: a restarted Lattice restores them, and Stop cancels them.
Upstream now continues chats interrupted by an unexpected server shutdown on its own. Lattice stops its service with SIGTERM whenever the writer quits, so under the Lattice host profile nothing continues by itself: after a restart, whether Lattice quit or was killed mid-turn, the reply keeps what had streamed, its header reads "Interrupted after …" with the elapsed time, and the composer waits for the writer.
Narration renders as prose with compact tool rows, subagent rows show model and effort, the right dock remembers its width per thread, and folders dragged from an editor tree attach to the composer. The task-list row reads "1 of 3 tasks".
Pi moves to 1.4.0, whose `providers/azure` and `utils/model-operations` imports load through the on-demand provider runtime like its other modules. The Pi lockfile changes, so a writer who installed Pi installs it once more from Settings → Providers.
The staged runtime is 170.3 MB (1.0.9: 168.4 MB); Lingui's runtime leaves the web bundle, and upstream's catalogs and `mdast-util-from-markdown` arrive.
Offline `synara-compact-database` maintenance, Claude Stop and steer ownership fences, SDK error results, crash and queue recovery, photo-draft preservation and Cursor safe-storage tokens are server-side or standalone changes with no embedded surface.

