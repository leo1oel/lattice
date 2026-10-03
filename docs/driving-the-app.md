# Driving the app

Three ways to see Lattice run, cheapest first. Pick the first one that can show what you need.

- **The mock-backend page**, for UI work, screenshots and QA. `pnpm perf:bench --serve` builds `tools/perf-bench/` (the real frontend over an in-memory backend holding `scripts/perf-fixture.mjs`'s project) and prints its URL; add `--dev` for hot reload.
  The page takes `theme=system|light|dark`, `lang=en|zh-CN|system` and the fixture sizes as query parameters. It clears storage on load, so set theme and language there, not in `localStorage`.
  Drive it with `playwright-core` (a devDependency; `import { chromium, webkit } from "playwright-core"`). Playwright's WebKit lacks some CSS the system WKWebView has, so treat its WebKit timings as pessimistic.
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
Hold the shared in-app lock for the whole session, for example `lockf -t 3600 /tmp/lattice-inapp-test.lock <your driver>`.
