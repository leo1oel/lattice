# Driving the app

Three ways to see Lattice run, cheapest first. Pick the first one that can show what you need.

- **The mock-backend page**, for UI work, screenshots and QA. `pnpm perf:bench --serve` builds `tools/perf-bench/` (the real frontend over an in-memory backend holding `scripts/perf-fixture.mjs`'s project, or the bundled tutorial sample once the Guided tutorial entry opens it, so the guided tour can be driven there) and prints its URL; add `--dev` for hot reload.
  Start with `pnpm perf:bench --serve --smoke --port 0`: it reports progress on stderr while it builds (about 15 s), opens the page in headless Chrome, and prints the URL only once the editor is up. Otherwise it exits 1 with the page's errors, its failed and unanswered requests, its text and a screenshot. `pnpm perf:bench --smoke` checks once and exits (`--url` checks a page already served). Until the app renders, the page itself shows and logs any load error, and says so if nothing rendered after 20 s.
  Run the server where it outlives your shell call. Codex ends a call's processes when it returns, so a server backgrounded there with `&` dies with an empty log. A pueue job works everywhere: `id=$(pueue add --print-task-id -- pnpm perf:bench --serve --smoke --chrome --port 0)`, read the URL with `pueue log "$id"`, and stop it with `pueue kill -s SIGTERM "$id"` (a plain kill skips the cleanup and leaves the build and the browser profile in TMPDIR).
  The page takes `theme=system|light|dark`, `lang=en|zh-CN|system` and the fixture sizes as query parameters. It clears storage on load, so set theme and language there, not in `localStorage`. `--lang zh-CN` (or `system`) serves and smoke-checks the page in that language, and `--locale zh-CN` gives `--smoke`'s browser that language, which `lang=system` follows. `pnpm test:e2e-harness` runs these smoke checks in each language and a `--serve --chrome` SIGTERM cycle end to end (it is not part of `pnpm check`; CI runs it in `.github/workflows/bench-harness.yml` when a harness input changes).
  Drive it with `playwright-core` (a devDependency; `import { chromium, webkit } from "playwright-core"`). Playwright's WebKit lacks some CSS the system WKWebView has, so treat its WebKit timings as pessimistic.
  For `chrome-devtools-axi`, add `--chrome` and export the `CHROME_DEVTOOLS_AXI_BROWSER_URL` it prints. Without it the bridge launches an installed Google Chrome, and where there is none it fails with `BRIDGE_NOT_READY`.
  Keep scratch files (TMPDIR, caches, copied registries) outside the checkout: the dev server watches every file under it.
  Tree rows live in a shadow root: click them with `page.locator('[data-item-path="…"]')`, which pierces it.
- **The browser-hosted real app**, when the Rust backend matters (builds, Overleaf, the file system). `node scripts/perf-lab.mjs host <task>` serves a lab build (below) with its fixture open; drive the printed URL with `playwright-core`.
- **The real-window lab**, for frame rates, input latency and memory in the real WKWebView window. `scripts/perf-lab.mjs` builds Lattice with the `perf-lab` Cargo feature, runs scenarios from `src/platform/perf-lab-harness.ts` through native input, and compares medians of two builds (`--as` stages a second one, such as `main` for a baseline). A typical session:

  ```bash
  node scripts/gen-perf-fixture.mjs /tmp/fixture && (cd /tmp/fixture && latexmk -pdf main.tex)
  node scripts/perf-lab.mjs build my-task --reuse-runtimes            # in this branch's checkout
  node scripts/perf-lab.mjs build my-task --reuse-runtimes --as main  # in a checkout of main
  node scripts/perf-lab.mjs fixture my-task /tmp/fixture
  for r in 1 2 3 4 5; do for v in wk wkmain; do node scripts/perf-lab.mjs run my-task $v f$r --scenarios idle,latexTyping,pdfScroll; done; done
  node scripts/perf-lab.mjs compare my-task wk wkmain --runs f
  ```

  The script's header lists every command and flag. The `hugePdf` and `imagePdf` scenarios need `huge.pdf` and `images.pdf` in the fixture, which no script generates; the WebKit-vs-Chromium lab's copies are in `/Users/Shared/lattice-tests/webkit-vs-chromium/genfiles/`.

Everything that runs a Lattice binary runs it as the `latticetest` account, never as yourself. `perf-lab.mjs` enforces the rules that keep a lab away from the real app: an `app.latticetest.<task>` bundle identifier (so its data, caches and keychain item are its own), a per-task port that is never 18452 (the shipped app's browser port, often live), files under `/Users/Shared/lattice-tests/<task>/`, and one lab app at a time.
Before a real-host pass, request a slot from firstmate and probe availability with `lockf -t 1 /tmp/lattice-inapp-test.lock /usr/bin/true`.
If occupied, record the wait and continue independent source/mock-backend work.
Once the slot is assigned, acquire the lock for a finite driver with a bounded acquisition timeout (for example `lockf -t 300 /tmp/lattice-inapp-test.lock <your driver>`), retain it through the driver, and release it when driving ends.
A failed acquisition supplies no product evidence; firstmate schedules the next attempt.
