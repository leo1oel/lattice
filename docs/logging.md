# Reading the logs

Lattice writes one log, `lattice.log`, in
`~/Library/Logs/app.leo1oel.researchwriter/`. It rotates at 2 MB and keeps
five old files. Settings → Logs → Open log folder shows the folder, and Export
there builds a redacted bundle for a bug report. The agent sidecar keeps its
own logs; see [`synara-runtime.md`](synara-runtime.md).

## Wide events

Each operation that matters writes **one** line when it finishes, under
`lattice::event` (Rust) or as a JSON line from the webview:

```text
[…][lattice::event][INFO] {"event":"latex.compile","outcome":"failed","duration_ms":4120,"project":"3f9c2a71d0","engine":"pdflatex","latexmk_runs":1,"latexmk_ms":3990,"errors":2,"first_error_code":"latex-tool-missing",…}
```

| `event` | Written when |
| --- | --- |
| `latex.compile` | a build ends (`failed` means the document has LaTeX errors; `error` means Lattice could not build at all) |
| `overleaf.sync` | a sync ends: file counts each way, download and upload bytes, HTTP requests and retries |
| `project.open` | a project opens, at launch or by choice: file count, bytes, scan time |
| `texlab.start` | the language server starts or restarts, with the reason |
| `synara.start` | the agent sidecar starts or restarts: port mode, health polls |
| `browser.session` | an Open in browser session ends: how, tab reconnects, messages relayed |
| `pdf.session` | a PDF viewer closes a document: range reads, bytes read, time to first bytes |

Every event has `event`, `outcome` (`success`, `error`, `failed`, `cancelled`,
or `abandoned` when it never finished) and `duration_ms`. A step's time is
`<step>_ms`. A failure adds `error_kind` (stable, for grouping), `error_cause`
(the error's first line) and `error_fix` (what to do). `operation_id` and
`request_id` match the frontend's `app.operation` lines for the same action.

Events never hold document text, tokens, cookies, one-time codes or full home
paths. Paths are project-relative; the project is a short hash (`project`).

## For a bug report or an agent

- Grep for the operation: `grep 'lattice::event' lattice.log | grep latex.compile`.
- Look for `"outcome":"error"` first; `error_kind` and `error_fix` say what broke.
- Plain lines around an event, and `WARN`/`ERROR` lines, are the detail.

## More detail

The default level is info in release builds and debug in development builds.
Set `LATTICE_LOG` (`error`, `warn`, `info`, `debug` or `trace`) to change it,
for example:

```bash
LATTICE_LOG=debug /Applications/Lattice.app/Contents/MacOS/Lattice
```

`debug` adds Lattice's own detail; only `trace` lets the window, network and
file-watch libraries log below info.

## Adding an event

Rust: `wide_event::Operation::start("area.verb", classify)` and `.run(…)` or
`.run_sync(…)` around the work; inside it, at any depth, `wide_event::record`,
`add` and `step`. Frontend: `startWideEvent` in `src/telemetry/wide-event.ts`.
Add counts and sizes, not content; give each failure kind a fix.
