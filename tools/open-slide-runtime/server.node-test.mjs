import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessPolicy,
  createBootstrapDocument,
  createMutationQueue,
  createOpenSlideSessionScript,
  isSameOriginBrowserRequest,
  listUsedGlobalAssetNames,
  migrateLegacySlideAssets,
  renameGlobalAsset,
  safeRelativePath,
  transformOpenSlideAssets,
  transformOpenSlideComments,
  transformOpenSlideConnectionCopy,
  transformOpenSlideEditorStyles,
  transformOpenSlideHomeChrome,
  transformOpenSlideThumbnailRail,
  transformOpenSlideToolbar,
} from "./server.mjs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { transform as transformTsx } from "esbuild";
import katex from "katex";

test("typesets bundled KaTeX formulas without throwing", () => {
  const html = katex.renderToString(
    String.raw`\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V`,
    { displayMode: true, throwOnError: false, strict: false },
  );
  assert.match(html, /katex-display/);
  assert.match(html, /mfrac/);
});

test("uses Lattice typography, interaction colors, and scrollbars in the Open Slide editor", () => {
  const source = `@import "@fontsource-variable/geist";
@theme inline {
  --font-sans: "Geist Variable", sans-serif;
  --font-heading: "Geist Variable", system-ui, sans-serif;
}`;
  const transformed = transformOpenSlideEditorStyles(
    source,
    "/runtime/node_modules/@open-slide/core/src/app/styles.css?direct",
  );
  assert.match(transformed, /@fontsource-variable\/inter/);
  assert.match(transformed, /"Inter Variable"/);
  assert.doesNotMatch(transformed, /Geist/);
  assert.match(transformed, /--brand: var\(--accent\)/);
  assert.match(transformed, /--brand-foreground: var\(--accent-foreground\)/);
  assert.match(transformed, /--brand-soft: var\(--accent\)/);
  assert.match(transformed, /--ring: var\(--muted-foreground\)/);
  assert.match(transformed, /--sidebar-ring: var\(--muted-foreground\)/);
  assert.match(transformed, /\.text-brand \{\s*color: var\(--muted-foreground\)/);
  assert.match(transformed, /\[data-lattice-present\] > button \{\s*box-shadow: none/);
  assert.match(transformed, /\[data-lattice-present\] > button:hover \{\s*background: color-mix\(in oklch, var\(--brand\) 94%, black\)/);
  assert.match(transformed, /:has\(\[data-slot="scroll-area-viewport"\] aside\)/);
  assert.match(transformed, /\[data-scrolling\]/);
  assert.match(transformed, /width: 4px/);
  assert.match(transformed, /opacity: 0/);
  assert.equal(transformOpenSlideEditorStyles(source, "/project/styles.css"), null);
});

test("centers vertical slide previews with folios in the left gutter", async () => {
  const source = await readFile(
    new URL("./node_modules/@open-slide/core/src/app/components/thumbnail-rail.tsx", import.meta.url),
    "utf8",
  );
  const transformed = transformOpenSlideThumbnailRail(
    source,
    "/runtime/node_modules/@open-slide/core/src/app/components/thumbnail-rail.tsx?direct",
  );
  assert.match(transformed, /group\/thumb relative flex w-full items-start justify-center gap-1 rounded-\[6px\]/);
  assert.match(transformed, /absolute left-2 mt-1\.5 flex w-7 shrink-0 flex-col items-start gap-1/);
  assert.doesNotMatch(transformed, /group\/thumb flex w-full items-start gap-2\.5/);
  assert.doesNotMatch(transformed, /mt-1\.5 flex w-7 shrink-0 flex-col items-end gap-1/);
  assert.equal(transformOpenSlideThumbnailRail(source, "/project/thumbnail-rail.tsx"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("surfaces comment deletion failures in the existing comment panel", async () => {
  const source = await readFile(
    new URL("./node_modules/@open-slide/core/src/app/lib/inspector/use-comments.ts", import.meta.url),
    "utf8",
  );
  const transformed = transformOpenSlideComments(
    source,
    "/runtime/node_modules/@open-slide/core/src/app/lib/inspector/use-comments.ts?direct",
  );
  assert.match(transformed, /const body = \(await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) as \{ error\?: string \}/);
  assert.match(transformed, /setError\(String\(\(e as Error\)\.message \?\? e\)\)/);
  assert.doesNotMatch(transformed, /if \(!res\.ok\) throw new Error\(`DELETE/);
  assert.equal(transformOpenSlideComments(source, "/project/use-comments.ts"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("keeps the Open Slide title in bounds and shows connection status only as a warning", async () => {
  const source = await readFile(
    new URL("./node_modules/@open-slide/core/src/app/routes/slide.tsx", import.meta.url),
    "utf8",
  );
  const transformed = transformOpenSlideToolbar(
    source,
    "/runtime/node_modules/@open-slide/core/src/app/routes/slide.tsx?direct",
  );
  assert.match(transformed, /min-w-0 justify-center px-2 md:flex-1/);
  assert.doesNotMatch(transformed, /md:absolute|md:inset-x-0/);
  assert.match(transformed, /<div data-lattice-present className="inline-flex items-stretch">/);
  assert.match(transformed, /<AgentConnectionWarning \/>/);
  assert.match(transformed, /if \(connected\) return null/);
  assert.match(transformed, /t\.slide\.agentDisconnected/);
  assert.doesNotMatch(transformed, /AgentConnectedBadge|bg-emerald-500|t\.slide\.agentConnected/);
  assert.equal(transformOpenSlideToolbar(source, "/project/slides/talk/index.tsx"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("uses Lattice-specific connection and theme guidance", async () => {
  const localeRoot = "./node_modules/@open-slide/core/src/locale";
  const [enSource, zhSource] = await Promise.all([
    readFile(new URL(`${localeRoot}/en.ts`, import.meta.url), "utf8"),
    readFile(new URL(`${localeRoot}/zh-cn.ts`, import.meta.url), "utf8"),
  ]);
  const en = transformOpenSlideConnectionCopy(
    enSource,
    "/runtime/node_modules/@open-slide/core/src/locale/en.ts?direct",
  );
  const zh = transformOpenSlideConnectionCopy(
    zhSource,
    "/runtime/node_modules/@open-slide/core/src/locale/zh-cn.ts?direct",
  );

  assert.match(en, /agentDisconnected: 'Live context disconnected'/);
  assert.match(en, /The agent can still edit deck files/);
  assert.match(en, /noThemesHintPrefix: 'Ask Lattice AI to create one, or enter '/);
  assert.match(en, /choose Create Theme from the slash menu/);
  assert.match(zh, /agentDisconnected: '页面上下文未同步'/);
  assert.match(zh, /Agent 仍可编辑演示文稿文件/);
  assert.match(zh, /noThemesHintPrefix: '让 Lattice AI 为你创建主题/);
  assert.match(zh, /从斜杠菜单中选择“创建主题”/);
  assert.equal(transformOpenSlideConnectionCopy(enSource, "/project/locale/en.ts"), null);
  await Promise.all([en, zh].map((source) => transformTsx(source, { loader: "ts" })));
});

test("removes the redundant home header while keeping the resizable navigation", async () => {
  const homePath = "src/app/routes/home-shell.tsx";
  const sidebarPath = "src/app/components/sidebar/sidebar.tsx";
  const folderItemPath = "src/app/components/sidebar/folder-item.tsx";
  const commandPath = "src/app/components/command/command-menu.tsx";
  const [homeSource, sidebarSource, folderItemSource, commandSource] = await Promise.all([
    readFile(new URL(`./node_modules/@open-slide/core/${homePath}`, import.meta.url), "utf8"),
    readFile(new URL(`./node_modules/@open-slide/core/${sidebarPath}`, import.meta.url), "utf8"),
    readFile(new URL(`./node_modules/@open-slide/core/${folderItemPath}`, import.meta.url), "utf8"),
    readFile(new URL(`./node_modules/@open-slide/core/${commandPath}`, import.meta.url), "utf8"),
  ]);

  const home = transformOpenSlideHomeChrome(
    homeSource,
    `/runtime/node_modules/@open-slide/core/${homePath}?direct`,
  );
  const sidebar = transformOpenSlideHomeChrome(
    sidebarSource,
    `/runtime/node_modules/@open-slide/core/${sidebarPath}?direct`,
  );
  const folderItem = transformOpenSlideHomeChrome(
    folderItemSource,
    `/runtime/node_modules/@open-slide/core/${folderItemPath}?direct`,
  );
  const command = transformOpenSlideHomeChrome(
    commandSource,
    `/runtime/node_modules/@open-slide/core/${commandPath}?direct`,
  );

  for (const transformed of [home, sidebar]) {
    assert.doesNotMatch(
      transformed,
      /appTitle|CommandMenuTrigger|LanguageToggle|ThemeToggle/,
    );
  }
  assert.doesNotMatch(home, /HomeCommandMenu|commandOpen|openCommandMenu/);
  assert.match(home, /<Outlet context=\{ctx\} \/>/);
  assert.match(sidebar, /<FolderItem/);
  assert.match(home, /function ResizableHomeSidebar/);
  assert.match(home, /open-slide:home-sidebar-width/);
  assert.match(home, /role="separator"/);
  assert.match(home, /aria-valuenow=\{width\}/);
  assert.match(home, /onPointerMove=\{onPointerMove\}/);
  assert.match(home, /onKeyDown=\{onKeyDown\}/);
  assert.match(home, /onDoubleClick=\{\(\) => setWidth\(DEFAULT_HOME_SIDEBAR_WIDTH\)\}/);
  assert.match(home, /<ResizableHomeSidebar>/);
  assert.doesNotMatch(home, /<div className="hidden md:block">/);
  assert.doesNotMatch(sidebar, /SidebarFooter/);
  assert.match(sidebar, /h-full w-full shrink-0/);
  assert.doesNotMatch(sidebar, /w-\[16\.5rem\]/);
  assert.match(sidebar, /className="px-2 pt-3"/);
  assert.match(folderItem, /FileText, Image, MoreHorizontal, Palette, Pencil, Presentation, Trash2/);
  assert.match(folderItem, /icon\.value === '🎞️'[\s\S]*\? Presentation/);
  assert.match(folderItem, /icon\.value === '🎨'[\s\S]*\? Palette/);
  assert.match(folderItem, /icon\.value === '🗂️'[\s\S]*\? Image/);
  assert.match(folderItem, /icon\.value === '📝'[\s\S]*\? FileText/);
  assert.match(folderItem, /className=\{cn\('size-3\.5 shrink-0', className\)\}/);
  assert.match(folderItem, /strokeWidth=\{1\.6\}/);
  assert.doesNotMatch(command, /LOCALE_OPTIONS|setLocale|useTheme|setTheme|theme-light/);
  assert.equal(transformOpenSlideHomeChrome(homeSource, "/project/home-shell.tsx"), null);
  await Promise.all(
    [home, sidebar, folderItem, command]
      .map((source) => transformTsx(source, { loader: "tsx" })),
  );
});

test("uses a denser slide grid and compact section titles on the embedded home screen", async () => {
  const [homeSource, themesSource] = await Promise.all([
    readFile(
      new URL("./node_modules/@open-slide/core/src/app/routes/home.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("./node_modules/@open-slide/core/src/app/routes/themes.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const home = transformOpenSlideHomeChrome(
    homeSource,
    "/runtime/node_modules/@open-slide/core/src/app/routes/home.tsx?direct",
  );
  const themes = transformOpenSlideHomeChrome(
    themesSource,
    "/runtime/node_modules/@open-slide/core/src/app/routes/themes.tsx?direct",
  );

  assert.match(home, /minmax\(200px,1fr\)/);
  assert.match(home, /md:grid-cols-\[repeat\(auto-fill,minmax\(220px,1fr\)\)\]/);
  assert.match(home, /gap-x-4 gap-y-7/);
  assert.doesNotMatch(home, /minmax\(300px,1fr\)/);
  for (const transformed of [home, themes]) {
    assert.match(transformed, /text-\[26px\].*md:text-\[28px\]/);
    assert.doesNotMatch(transformed, /md:text-\[44px\]/);
  }
  await Promise.all([home, themes].map((source) => transformTsx(source, { loader: "tsx" })));
});

test("presents one project asset library with current-presentation filtering", async () => {
  const sourceRoot = new URL("./node_modules/@open-slide/core/", import.meta.url);
  const modules = [
    ["src/app/lib/assets.ts", "ts"],
    ["src/app/components/asset-view.tsx", "tsx"],
    ["src/app/components/inspector/asset-picker-dialog.tsx", "tsx"],
    ["src/app/components/image-placeholder.tsx", "tsx"],
  ];
  const transformed = new Map();
  for (const [modulePath, loader] of modules) {
    const source = await readFile(new URL(modulePath, sourceRoot), "utf8");
    const result = transformOpenSlideAssets(
      source,
      `/runtime/node_modules/@open-slide/core/${modulePath}?direct`,
    );
    transformed.set(modulePath, result);
    await transformTsx(result, { loader });
  }

  const assets = transformed.get("src/app/lib/assets.ts");
  assert.match(assets, /const GLOBAL_ASSET_SCOPE = '@global'/);
  assert.match(assets, /__lattice\/assets-used/);
  assert.match(assets, /usedInPresentation: used\.has\(asset\.name\)/);
  assert.match(assets, /fetch\('\/__lattice\/rename-asset'/);
  assert.doesNotMatch(assets, /fetch\(`\/__assets\/\$\{slideId\}/);

  const view = transformed.get("src/app/components/asset-view.tsx");
  assert.match(view, /scope === 'slide' \? assets\.filter\(\(asset\) => asset\.usedInPresentation\)/);
  assert.match(view, /const assetPath = `@assets\/\$\{target\.name\}`/);
  assert.match(view, /const importPath = `@assets\/\$\{asset\.name\}`/);
  assert.doesNotMatch(view, /slides\/\$\{slideId\}\/assets|`\.\/assets/);

  const picker = transformed.get("src/app/components/inspector/asset-picker-dialog.tsx");
  assert.match(picker, /scope === 'global' \|\| asset\.usedInPresentation/);
  assert.match(picker, /onPick\(asset, 'global'\)/);
  assert.doesNotMatch(picker, /slides\/\$\{slideId\}\/assets/);

  const placeholder = transformed.get("src/app/components/image-placeholder.tsx");
  assert.match(placeholder, /assetPath: `@assets\/\$\{entry\.name\}`/);
  assert.doesNotMatch(placeholder, /assetPath: `\.\/assets/);
});

test("labels the derived asset scope as the current presentation", async () => {
  const localeRoot = "./node_modules/@open-slide/core/src/locale";
  const [enSource, zhSource] = await Promise.all([
    readFile(new URL(`${localeRoot}/en.ts`, import.meta.url), "utf8"),
    readFile(new URL(`${localeRoot}/zh-cn.ts`, import.meta.url), "utf8"),
  ]);
  const en = transformOpenSlideAssets(
    enSource,
    "/runtime/node_modules/@open-slide/core/src/locale/en.ts?direct",
  );
  const zh = transformOpenSlideAssets(
    zhSource,
    "/runtime/node_modules/@open-slide/core/src/locale/zh-cn.ts?direct",
  );
  assert.match(en, /scopeSlide: 'This presentation'/);
  assert.match(en, /Delete \{name\} from the project assets folder\? This cannot be undone\./);
  assert.match(zh, /scopeSlide: '当前演示文稿'/);
  assert.match(zh, /要从项目 assets 文件夹中删除 \{name\} 吗？此操作无法撤销。/);
  await Promise.all([en, zh].map((source) => transformTsx(source, { loader: "ts" })));
});

test("finds only global assets imported by the current presentation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-assets-"));
  try {
    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(path.join(root, "slides", "talk"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "assets", "used.png"), "used"),
      writeFile(path.join(root, "assets", "unused.png"), "unused"),
      writeFile(
        path.join(root, "slides", "talk", "index.tsx"),
        "import hero from '@assets/used.png';\nconst other = '@assets/unused.png-copy';\nexport default [hero, other];\n",
      ),
    ]);
    assert.deepEqual(await listUsedGlobalAssetNames(root, "talk"), ["used.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates legacy deck assets into the project library and reports bridge mutations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-assets-"));
  try {
    const entry = path.join(root, "slides", "talk", "index.tsx");
    const localAssets = path.join(root, "slides", "talk", "assets");
    await mkdir(localAssets, { recursive: true });
    await mkdir(path.join(root, "assets"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "assets", "hero.png"), "existing-global"),
      writeFile(path.join(localAssets, "hero.png"), "deck-specific"),
      writeFile(path.join(localAssets, "notes.txt"), "unused but preserved"),
      writeFile(path.join(localAssets, "interactive.html"), "<div>interactive</div>"),
      writeFile(
        entry,
        "import hero from './assets/hero.png';\nimport interactive from './assets/interactive.html?raw';\nexport default [hero, interactive];\n",
      ),
    ]);
    const queue = createMutationQueue(root, "secret");
    const frames = [];
    let close;
    queue.attach({
      on(event, handler) { if (event === "close") close = handler; },
      write(frame) { frames.push(frame); return true; },
    });
    assert.equal(queue.connected(), true);
    await queue.seed();

    const result = await migrateLegacySlideAssets(root, queue);
    await delay(80);

    assert.deepEqual(result, { copied: 2, rewritten: 1, removed: 2 });
    assert.equal(await readFile(path.join(root, "assets", "hero-1.png"), "utf8"), "deck-specific");
    assert.equal(await readFile(path.join(root, "assets", "notes.txt"), "utf8"), "unused but preserved");
    const migratedSource = await readFile(entry, "utf8");
    assert.match(migratedSource, /from '@assets\/hero-1\.png'/);
    assert.match(migratedSource, /from '\.\/assets\/interactive\.html\?raw'/);
    assert.equal(
      await readFile(path.join(localAssets, "interactive.html"), "utf8"),
      "<div>interactive</div>",
    );
    await assert.rejects(readFile(path.join(localAssets, "hero.png")));
    const paths = frames.map((frame) => JSON.parse(frame.split("data: ")[1]).path);
    assert.ok(paths.includes("assets/hero-1.png"));
    assert.ok(paths.includes("slides/talk/index.tsx"));
    assert.ok(paths.includes("slides/talk/assets/hero.png"));
    close();
    assert.equal(queue.connected(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renames a project asset and rewrites every presentation reference", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-assets-"));
  try {
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets", "old.png"), "asset");
    for (const id of ["alpha", "beta"]) {
      await mkdir(path.join(root, "slides", id), { recursive: true });
      await writeFile(
        path.join(root, "slides", id, "index.tsx"),
        `import image from '@assets/old.png';\nexport default [image];\n`,
      );
    }
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    const result = await renameGlobalAsset(root, "old.png", "new.png", queue);
    await delay(80);

    assert.equal(result.ok, true);
    assert.deepEqual(result.updatedSlides, ["alpha", "beta"]);
    assert.equal(await readFile(path.join(root, "assets", "new.png"), "utf8"), "asset");
    await assert.rejects(readFile(path.join(root, "assets", "old.png")));
    for (const id of ["alpha", "beta"]) {
      const source = await readFile(path.join(root, "slides", id, "index.tsx"), "utf8");
      assert.match(source, /from '@assets\/new\.png'/);
      assert.doesNotMatch(source, /old\.png/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts normalized project-relative paths", () => {
  assert.equal(safeRelativePath("slides/intro.tsx"), "slides/intro.tsx");
  assert.equal(safeRelativePath("slides\\intro.tsx"), "slides/intro.tsx");
});

test("rejects traversal and absolute paths", () => {
  assert.equal(safeRelativePath("../secret"), null);
  assert.equal(safeRelativePath("slides/../../secret"), null);
  assert.equal(safeRelativePath("/tmp/secret"), null);
});

test("bootstraps Lattice appearance settings and removes an obsolete service worker", () => {
  const document = createBootstrapDocument("/s/talk", { locale: "zh-CN", theme: "dark" });
  assert.match(document, /getRegistrations/);
  assert.match(document, /registration\.unregister/);
  assert.match(document, /location\.replace\(next\)/);
  assert.match(document, /"locale":"zh-CN","theme":"dark"/);
  assert.match(document, /localStorage\.setItem\("open-slide:locale", preferences\.locale\)/);
  assert.match(document, /localStorage\.setItem\("theme", preferences\.theme\)/);
  assert.doesNotMatch(document, /serviceWorker\.register/);
  assert.doesNotMatch(document, /<p id="status">/);
  assert.doesNotMatch(document, /cookie/i);
});

test("applies session preferences before opening authenticated presentation windows", () => {
  const calls = [];
  const stored = new Map();
  const location = new URL("http://127.0.0.1:4321/s/talk");
  const localStorage = {
    setItem(key, value) {
      stored.set(key, value);
    },
  };
  const window = {
    open(...args) {
      calls.push(args);
      return null;
    },
  };
  runInNewContext(
    createOpenSlideSessionScript("session-secret", { locale: "zh-CN", theme: "dark" }),
    { localStorage, location, URL, window },
  );

  window.open("/s/talk/presenter", "presenter", "popup,width=1280,height=800");
  window.open("https://example.com/help", "help");

  assert.equal(stored.get("open-slide:locale"), "zh-CN");
  assert.equal(stored.get("theme"), "dark");
  assert.equal(
    calls[0][0],
    "http://127.0.0.1:4321/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter",
  );
  assert.deepEqual(calls[0].slice(1), ["presenter", "popup,width=1280,height=800"]);
  assert.equal(calls[1][0], "https://example.com/help");
});

test("accepts only browser requests originating from the activated loopback app", () => {
  const host = "127.0.0.1:4321";
  assert.equal(isSameOriginBrowserRequest({
    headers: { referer: "http://127.0.0.1:4321/s/talk" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { origin: "http://127.0.0.1:4321" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { "sec-fetch-site": "same-origin" },
  }, host), true);
  assert.equal(isSameOriginBrowserRequest({
    headers: { referer: "https://attacker.example/", "sec-fetch-site": "cross-site" },
  }, host), false);
});

test("keeps native mutations read-only until every active lease is writable", () => {
  const access = createAccessPolicy();
  const writer = "11111111-1111-1111-1111-111111111111";
  const reader = "22222222-2222-2222-2222-222222222222";
  assert.equal(access.writable(), false);
  access.update(writer, true);
  assert.equal(access.writable(), true);
  access.update(reader, false);
  assert.equal(access.writable(), false);
  access.update(reader, null);
  assert.equal(access.writable(), true);
});

test("does not report initial files or exact host mirror echoes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    await mkdir(path.join(root, "slides", "talk"), { recursive: true });
    const entry = path.join(root, "slides", "talk", "index.tsx");
    await writeFile(entry, "before");
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    await queue.enqueue("add", entry);
    await queue.sync([{ path: "slides/talk/index.tsx", kind: "write", text: "after" }]);
    await queue.enqueue("change", entry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps event streams connected when a large mutation applies backpressure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-backpressure-"));
  try {
    const entry = path.join(root, "slides", "talk", "index.tsx");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "before");
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    const frames = [];
    let destroyed = false;
    queue.attach({
      on() {},
      write(frame) {
        frames.push(frame);
        return false;
      },
      destroy() {
        destroyed = true;
      },
    });

    await writeFile(entry, "after".repeat(40_000));
    await queue.enqueue("write", entry);
    await delay(80);

    assert.equal(frames.length, 1);
    assert.match(frames[0], /"path":"slides\/talk\/index\.tsx"/);
    assert.equal(destroyed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams host files into the shadow without retaining temporary files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    const queue = createMutationQueue(root, "secret");
    await queue.seed();
    await queue.syncFile(
      "slides/talk/index.tsx",
      Readable.from([Buffer.from("export "), Buffer.from("default []")]),
    );
    assert.equal(
      await readFile(path.join(root, "slides", "talk", "index.tsx"), "utf8"),
      "export default []",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams the current page and inspector selection to Lattice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    const queue = createMutationQueue(root, "secret");
    const frames = [];
    queue.attach({
      on() {},
      write(frame) { frames.push(frame); return true; },
    });

    queue.reportCurrent({
      slideId: "research-update",
      pageIndex: 2,
      totalPages: 8,
      slideTitle: "Research update",
      view: "slides",
    });
    queue.reportCurrent({
      selection: { line: 42.8, column: 6.2, tagName: "H1", text: "  Q2   Roadmap  " },
    });

    const context = JSON.parse(frames.at(-1).split("data: ")[1]).context;
    assert.deepEqual(context, {
      slideId: "research-update",
      pageIndex: 2,
      pageNumber: 3,
      totalPages: 8,
      slideTitle: "Research update",
      view: "slides",
      pagePath: "slides/research-update/index.tsx",
      selection: { line: 42, column: 6, tagName: "h1", text: "Q2 Roadmap" },
      updatedAt: context.updatedAt,
    });
    assert.match(context.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
