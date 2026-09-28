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
  removeOpenSlideCommentMarker,
  safeRelativePath,
  transformOpenSlideAssets,
  transformOpenSlideComments,
  transformOpenSlideConnectionCopy,
  transformOpenSlideEditorStyles,
  transformOpenSlideHomeChrome,
  transformOpenSlideInspectorPanel,
  transformOpenSlideSaveFeedback,
  transformOpenSlideSelection,
  transformOpenSlideThumbnailRail,
  transformOpenSlideToolbar,
} from "./server.mjs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { transform as transformTsx } from "esbuild";
import katex from "katex";
import * as icons from "./lucide-open-slide.mjs";

const CORE = "node_modules/@open-slide/core/";
const coreSource = (relative) => readFile(new URL(`./${CORE}${relative}`, import.meta.url), "utf8");

/** Apply one Lattice patch to a pinned Open Slide module, addressed as the runtime's dev server sees it. */
async function patchCore(transform, relative) {
  const source = await coreSource(relative);
  return { source, transformed: transform(source, `/runtime/${CORE}${relative}?direct`) };
}

/** Run a test body against a throwaway project root. */
async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Attach an event stream that records each frame's parsed payload. */
function recordFrames(queue, lastEventId) {
  const frames = [];
  const write = (frame) => {
    frames.push(JSON.parse(frame.split("data: ")[1]));
    return true;
  };
  queue.attach({ on() {}, write }, lastEventId);
  return frames;
}

const pageContext = (pageIndex) => ({
  slideId: "research-update", pageIndex, totalPages: 8, slideTitle: "Research update", view: "slides",
});

test("reports the exact pinned Open Slide version in the readiness handshake", async () => {
  const [manifest, server, installed, supervisor] = await Promise.all([
    readFile(new URL("./package.json", import.meta.url), "utf8"),
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
    coreSource("package.json"),
    readFile(new URL("../../src-tauri/src/presentation.rs", import.meta.url), "utf8"),
  ]);
  const version = JSON.parse(manifest).dependencies["@open-slide/core"];
  assert.equal(JSON.parse(installed).version, version);
  assert.equal(server.match(/const VERSION = "([^"]+)";/)?.[1], version);
  assert.equal(supervisor.match(/const VERSION: &str = "([^"]+)";/)?.[1], version);
});

test("provides every runtime icon imported by the pinned Open Slide editor", async () => {
  const root = new URL(`./${CORE}src/app/`, import.meta.url);
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.[jt]sx?$/.test(file)) continue;
    // Strip TypeScript first so type-only Lucide imports don't count as runtime exports.
    const source = await readFile(new URL(file, root), "utf8");
    const { code } = await transformTsx(source, { loader: file.endsWith("x") ? "tsx" : "ts" });
    for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from ["']lucide-react["']/g)) {
      for (const specifier of match[1].split(",")) {
        const name = specifier.trim().split(/\s+as\s+/)[0];
        if (name) assert.ok(name in icons, `${file} requires missing icon ${name}`);
      }
    }
  }
});

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
  assert.match(transformed, /@source "[^"]+\/server\.mjs";/);
  assert.doesNotMatch(transformed, /Geist/);
  assert.match(transformed, /--brand: var\(--accent\)/);
  assert.match(transformed, /--brand-foreground: var\(--accent-foreground\)/);
  assert.match(transformed, /--brand-soft: var\(--accent\)/);
  assert.match(transformed, /--ring: var\(--muted-foreground\)/);
  assert.match(transformed, /--sidebar-ring: var\(--muted-foreground\)/);
  assert.match(transformed, /\.text-brand \{\s*color: var\(--muted-foreground\)/);
  assert.match(transformed, /\[data-lattice-present\] > button \{\s*box-shadow: none/);
  assert.match(transformed, /\[data-lattice-present\] > button:hover \{\s*background: color-mix\(in oklch, var\(--brand\) 94%, black\)/);
  assert.match(transformed, /\[data-lattice-save-card\] \[data-variant="brand"\] \{\s*box-shadow: none/);
  assert.match(transformed, /:has\(\[data-slot="scroll-area-viewport"\] aside\)/);
  assert.match(transformed, /\[data-scrolling\]/);
  assert.match(transformed, /width: 4px/);
  assert.match(transformed, /opacity: 0/);
  assert.equal(transformOpenSlideEditorStyles(source, "/project/styles.css"), null);
});

test("centers vertical slide previews with folios in the left gutter", async () => {
  const { source, transformed } = await patchCore(
    transformOpenSlideThumbnailRail, "src/app/components/thumbnail-rail.tsx",
  );
  assert.match(transformed, /group\/thumb relative flex w-full items-start justify-center gap-1 rounded-\[6px\] pl-2/);
  assert.match(transformed, /absolute left-2 mt-1\.5 flex w-7 shrink-0 flex-col items-start gap-1/);
  assert.doesNotMatch(transformed, /group\/thumb flex w-full items-start gap-2\.5/);
  assert.doesNotMatch(transformed, /mt-1\.5 flex w-7 shrink-0 flex-col items-end gap-1/);
  assert.equal(transformOpenSlideThumbnailRail(source, "/project/thumbnail-rail.tsx"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("surfaces comment deletion failures and removes the manual apply instruction", async () => {
  const [{ source: hookSource, transformed: hook }, { transformed: widget }] = await Promise.all([
    patchCore(transformOpenSlideComments, "src/app/lib/inspector/use-comments.ts"),
    patchCore(transformOpenSlideComments, "src/app/components/inspector/comment-widget.tsx"),
  ]);
  assert.match(hook, /const body = \(await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) as \{ error\?: string \}/);
  assert.match(hook, /setError\(String\(\(e as Error\)\.message \?\? e\)\)/);
  assert.doesNotMatch(hook, /if \(!res\.ok\) throw new Error\(`DELETE/);
  assert.doesNotMatch(widget, /apply-comments/);
  assert.equal(transformOpenSlideComments(hookSource, "/project/use-comments.ts"), null);
  await Promise.all([hook, widget].map((source) => transformTsx(source, { loader: "tsx" })));
});

test("deletes only the requested comment marker when inline JSX follows it", () => {
  const first = '{/* @slide-comment id="c-11111111" ts="2026-09-03T00:00:00.000Z" text="eyJub3RlIjoiZmlyc3QifQ" */}';
  const second = '{/* @slide-comment id="c-22222222" ts="2026-09-03T00:00:01.000Z" text="eyJub3RlIjoic2Vjb25kIn0" */}';
  const source = `<h1>\n  ${first}\n  ${second}Title</h1>`;
  assert.equal(removeOpenSlideCommentMarker(source, "c-22222222"), `<h1>\n  ${first}\n  Title</h1>`);
  assert.equal(removeOpenSlideCommentMarker(`<h1>\n  ${first}\n  Title</h1>`, "c-11111111"), "<h1>\n  Title</h1>");
  assert.equal(removeOpenSlideCommentMarker(source, "c-deadbeef"), null);
});

test("removes the redundant inspector agent-watching badge", async () => {
  const { source, transformed } = await patchCore(
    transformOpenSlideInspectorPanel, "src/app/components/inspector/inspector-panel.tsx",
  );
  assert.doesNotMatch(transformed, /AgentWatchingBadge|useAgentSocketConnected|agentWatching/);
  assert.equal(transformOpenSlideInspectorPanel(source, "/project/inspector-panel.tsx"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("only reports a save after every Open Slide edit succeeds", async () => {
  const [bar, card, inspector, design] = await Promise.all([
    "inspector/save-bar.tsx",
    "panel/save-card.tsx",
    "inspector/inspector-provider.tsx",
    "style-panel/design-provider.tsx",
  ].map((file) => patchCore(transformOpenSlideSaveFeedback, `src/app/components/${file}`)));
  assert.match(bar.transformed, /await Promise\.all\(tasks\);/);
  assert.doesNotMatch(bar.transformed, /Promise\.all\(tasks\)\.catch/);
  assert.match(card.transformed, /data-lattice-save-card/);
  assert.match(card.transformed, /try \{\s*await onSave\(\);\s*setJustSaved\(true\);\s*\} catch \{/);
  assert.match(inspector.transformed, /if \(failures\.length > 0\) throw new Error\(failures\.join\('; '\)\);/);
  assert.match(design.transformed, /if \(!r\.ok\) \{\s*const message = r\.error \?\? 'Failed to save';[\s\S]*throw new Error\(message\);/);
  assert.equal(transformOpenSlideSaveFeedback(bar.source, "/project/save-bar.tsx"), null);
  await Promise.all([bar, card, inspector, design]
    .map(({ transformed }) => transformTsx(transformed, { loader: "tsx" })));
});

test("recovers only an unambiguous inspector instance after comment HMR", async () => {
  const source = await coreSource("src/app/components/inspector/inspector-provider.tsx");
  const transformed = transformOpenSlideSelection(
    source, `/runtime/${CORE}src/app/components/inspector/inspector-provider.tsx`,
  );
  await transformTsx(transformed, { loader: "tsx" });
  const body = transformed.match(/const revalidate = \(\) => \{([\s\S]*?)\n {4}\};/)[1];
  const { code } = await transformTsx(`function revalidate() {${body}\n} revalidate();`, { loader: "ts" });
  const first = { tagName: "DIV", textContent: "First card" };
  const second = { tagName: "DIV", textContent: "Second card" };
  const connected = { line: 8, column: 2, anchor: { ...first, isConnected: true } };
  for (const [candidates, expected] of [
    [[first, second], second],
    [[first], null],
    [[{ ...second, tagName: "SPAN" }], null],
    [[second, { ...second }], null],
    [[], null],
  ]) {
    let result;
    runInNewContext(code, {
      selection: [connected, { line: 3, column: 31, anchor: { ...second, isConnected: false } }],
      slideId: "test",
      root: { querySelectorAll: () => candidates },
      findSlideSource: (anchor) => anchor === connected.anchor ? connected : { line: 3, column: 31, anchor },
      rememberTarget: (target) => target,
      setSelection: (value) => { result = value; },
    });
    assert.equal(result[0], connected, "preserve other connected selections");
    assert.equal(result.length, expected ? 2 : 1);
    assert.equal(result[1]?.anchor ?? null, expected);
  }
  assert.equal(transformOpenSlideSelection(source, "/project/index.tsx"), null);
  assert.throws(() => transformOpenSlideSelection("changed", "/@open-slide/core/src/app/components/inspector/inspector-provider.tsx"));
});

test("keeps the Open Slide title in bounds and shows connection status only as a warning", async () => {
  const { source, transformed } = await patchCore(transformOpenSlideToolbar, "src/app/routes/slide.tsx");
  assert.match(transformed, /min-w-0 justify-center px-2 md:flex-1/);
  assert.doesNotMatch(transformed, /md:absolute|md:inset-x-0/);
  assert.match(transformed, /<div data-lattice-present className="inline-flex items-stretch">/);
  assert.match(transformed, /<AgentConnectionWarning \/>/);
  assert.match(transformed, /if \(connected\) return null/);
  assert.match(transformed, /t\.slide\.agentDisconnected/);
  assert.match(transformed, /const \{ slideId, selected, pendingCount, comments \} = useInspector\(\)/);
  assert.match(transformed, /pendingEdits: pendingCount > 0/);
  assert.match(transformed, /pendingComments: comments/);
  assert.match(transformed, /slice\(0, 12_000\)/);
  assert.doesNotMatch(transformed, /slice\(0, 120\)/);
  assert.doesNotMatch(transformed, /AgentConnectedBadge|bg-emerald-500|t\.slide\.agentConnected/);
  // Embedded toolbar patches must preserve both beta.2 export paths and the
  // new editable export's command-menu action, rather than its old placeholder.
  assert.match(transformed, /onClick=\{exportPptx\}/);
  assert.match(transformed, /onClick=\{exportImagePptx\}/);
  assert.match(transformed, /onExportPptx: exportPptx/);
  assert.doesNotMatch(transformed, /pptxComingSoonTooltip/);
  assert.equal(transformOpenSlideToolbar(source, "/project/slides/talk/index.tsx"), null);
  await transformTsx(transformed, { loader: "tsx" });
});

test("uses Lattice-specific connection and theme guidance", async () => {
  const [{ source: enSource, transformed: en }, { transformed: zh }] = await Promise.all([
    patchCore(transformOpenSlideConnectionCopy, "src/locale/en.ts"),
    patchCore(transformOpenSlideConnectionCopy, "src/locale/zh-cn.ts"),
  ]);
  assert.match(en, /agentDisconnected: 'Live context disconnected'/);
  assert.match(en, /The agent can still edit deck files/);
  assert.match(en, /noThemesHintPrefix: 'Ask Lattice AI to create one, or enter '/);
  assert.match(en, /choose Create Theme from the slash menu/);
  assert.match(en, /commentsApplyHintPrefix: 'Included automatically with your next Lattice AI message\.'/);
  assert.match(en, /commentsApplyHintSuffix: ''/);
  assert.match(zh, /agentDisconnected: '页面上下文未同步'/);
  assert.match(zh, /Agent 仍可编辑演示文稿文件/);
  assert.match(zh, /noThemesHintPrefix: '让 Lattice AI 为你创建主题/);
  assert.match(zh, /从斜杠菜单中选择“创建主题”/);
  assert.match(zh, /commentsApplyHintPrefix: '这些评论会自动包含在你发送给 Lattice AI 的下一条消息中。'/);
  assert.match(zh, /commentsApplyHintSuffix: ''/);
  assert.equal(transformOpenSlideConnectionCopy(enSource, "/project/locale/en.ts"), null);
  await Promise.all([en, zh].map((source) => transformTsx(source, { loader: "ts" })));
});

test("removes the redundant home header while keeping the resizable navigation", async () => {
  const [
    { source: homeSource, transformed: home },
    { transformed: sidebar },
    { source: folderItemSource, transformed: folderItem },
    { transformed: command },
  ] = await Promise.all([
    "src/app/routes/home-shell.tsx",
    "src/app/components/sidebar/sidebar.tsx",
    "src/app/components/sidebar/folder-item.tsx",
    "src/app/components/command/command-menu.tsx",
  ].map((file) => patchCore(transformOpenSlideHomeChrome, file)));
  for (const transformed of [home, sidebar]) {
    assert.doesNotMatch(transformed, /appTitle|CommandMenuTrigger|LanguageToggle|ThemeToggle/);
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
  assert.match(sidebar, /className="space-y-0.5 px-2 pt-3"/);
  assert.equal(folderItem, null); // V2 supplies native Lucide icons for built-in views.
  assert.match(folderItemSource, /all: LayoutGrid/);
  assert.match(folderItemSource, /draft: PenLine/);
  assert.match(folderItemSource, /themes: Palette/);
  assert.match(folderItemSource, /assets: FolderOpen/);
  assert.doesNotMatch(command, /LOCALE_OPTIONS|setLocale|useTheme|setTheme|theme-light/);
  assert.equal(transformOpenSlideHomeChrome(homeSource, "/project/home-shell.tsx"), null);
  await Promise.all([home, sidebar, folderItemSource, command]
    .map((source) => transformTsx(source, { loader: "tsx" })));
});

test("uses a denser slide grid and compact section titles on the embedded home screen", async () => {
  const [{ transformed: home }, { source: themesSource, transformed: themes }] = await Promise.all([
    patchCore(transformOpenSlideHomeChrome, "src/app/routes/home.tsx"),
    patchCore(transformOpenSlideHomeChrome, "src/app/routes/themes.tsx"),
  ]);
  assert.equal(themes, null); // V2's compact theme heading no longer needs patching.
  assert.match(home, /minmax\(200px,1fr\)/);
  assert.match(home, /md:grid-cols-\[repeat\(auto-fill,minmax\(220px,1fr\)\)\]/);
  assert.match(home, /gap-x-4 gap-y-7/);
  assert.doesNotMatch(home, /minmax\(300px,1fr\)/);
  for (const transformed of [home, themesSource]) {
    assert.match(transformed, /text-\[19px\].*md:text-\[21px\]/);
    assert.doesNotMatch(transformed, /md:text-\[44px\]/);
  }
  await Promise.all([home, themesSource].map((source) => transformTsx(source, { loader: "tsx" })));
});

test("presents one project asset library with current-presentation filtering", async () => {
  const modules = [
    ["src/app/lib/assets.ts", "ts"],
    ["src/app/components/asset-view.tsx", "tsx"],
    ["src/app/components/inspector/asset-picker-dialog.tsx", "tsx"],
    ["src/app/components/image-placeholder.tsx", "tsx"],
  ];
  const transformed = new Map();
  for (const [modulePath, loader] of modules) {
    const result = (await patchCore(transformOpenSlideAssets, modulePath)).transformed;
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
  const [{ transformed: en }, { transformed: zh }] = await Promise.all([
    patchCore(transformOpenSlideAssets, "src/locale/en.ts"),
    patchCore(transformOpenSlideAssets, "src/locale/zh-cn.ts"),
  ]);
  assert.match(en, /scopeSlide: 'This presentation'/);
  assert.match(en, /Delete \{name\} from the project assets folder\? This cannot be undone\./);
  assert.match(zh, /scopeSlide: '当前演示文稿'/);
  assert.match(zh, /要从项目 assets 文件夹中删除 \{name\} 吗？此操作无法撤销。/);
  await Promise.all([en, zh].map((source) => transformTsx(source, { loader: "ts" })));
});

test("finds only global assets imported by the current presentation", () => withTempRoot(async (root) => {
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
}));

test("migrates legacy deck assets into the project library and reports bridge mutations", () => withTempRoot(async (root) => {
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
  assert.equal(await readFile(path.join(localAssets, "interactive.html"), "utf8"), "<div>interactive</div>");
  await assert.rejects(readFile(path.join(localAssets, "hero.png")));
  const paths = frames.map((frame) => JSON.parse(frame.split("data: ")[1]).path);
  assert.ok(paths.includes("assets/hero-1.png"));
  assert.ok(paths.includes("slides/talk/index.tsx"));
  assert.ok(paths.includes("slides/talk/assets/hero.png"));
  close();
  assert.equal(queue.connected(), false);
}));

test("renames a project asset and rewrites every presentation reference", () => withTempRoot(async (root) => {
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
}));

test("accepts normalized project-relative paths and rejects traversal and absolute paths", () => {
  assert.equal(safeRelativePath("slides/intro.tsx"), "slides/intro.tsx");
  assert.equal(safeRelativePath("slides\\intro.tsx"), "slides/intro.tsx");
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
  const localStorage = { setItem: (key, value) => stored.set(key, value) };
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
  for (const [headers, expected] of [
    [{ referer: "http://127.0.0.1:4321/s/talk" }, true],
    [{ origin: "http://127.0.0.1:4321" }, true],
    [{ "sec-fetch-site": "same-origin" }, true],
    [{ referer: "https://attacker.example/", "sec-fetch-site": "cross-site" }, false],
  ]) assert.equal(isSameOriginBrowserRequest({ headers }, "127.0.0.1:4321"), expected);
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

test("does not report initial files or exact host mirror echoes", () => withTempRoot(async (root) => {
  await mkdir(path.join(root, "slides", "talk"), { recursive: true });
  const entry = path.join(root, "slides", "talk", "index.tsx");
  await writeFile(entry, "before");
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  await utimes(entry, oldTime, oldTime);
  const queue = createMutationQueue(root, "secret");
  await queue.seed();
  await queue.enqueue("add", entry);
  await queue.sync([{ path: "slides/talk/index.tsx", kind: "write", text: "before" }]);
  assert.equal((await stat(entry)).mtimeMs, oldTime.getTime());
  await queue.sync([{ path: "slides/talk/index.tsx", kind: "write", text: "after" }]);
  await queue.enqueue("change", entry);
}));

test("keeps event streams connected when a large mutation applies backpressure", () => withTempRoot(async (root) => {
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
}));

test("streams host files into the shadow without retaining temporary files", () => withTempRoot(async (root) => {
  const queue = createMutationQueue(root, "secret");
  await queue.seed();
  await queue.syncFile("slides/talk/index.tsx", Readable.from([Buffer.from("export "), Buffer.from("default []")]));
  assert.equal(await readFile(path.join(root, "slides", "talk", "index.tsx"), "utf8"), "export default []");
}));

test("streams the current page and inspector selection to Lattice", () => withTempRoot(async (root) => {
  const queue = createMutationQueue(root, "secret");
  const frames = recordFrames(queue);
  queue.reportCurrent(pageContext(2));
  queue.reportCurrent({
    pendingEdits: true,
    pendingComments: [{
      id: "c-1234abcd", line: 44.9, ts: "2026-09-03T00:00:00.000Z", note: "  Make this chart larger.  ", hint: "  chart  ",
    }],
    selection: { line: 42.8, column: 6.2, tagName: "H1", text: "  Q2   Roadmap  " },
  });
  const { context } = frames.at(-1);
  assert.deepEqual(context, {
    ...pageContext(2),
    pageNumber: 3,
    pagePath: "slides/research-update/index.tsx",
    pendingEdits: true,
    pendingComments: [{
      id: "c-1234abcd", line: 44, ts: "2026-09-03T00:00:00.000Z", note: "Make this chart larger.", hint: "chart",
    }],
    selection: { line: 42, column: 6, tagName: "h1", text: "Q2 Roadmap" },
    updatedAt: context.updatedAt,
  });
  assert.match(context.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Comments stay attached while inspecting a different block, and its text
  // is useful context rather than the upstream 120-character teaser.
  const text = "Second card text. ".repeat(40).trim();
  queue.reportCurrent({ selection: { line: 50, column: 2, tagName: "div", text } });
  const changed = frames.at(-1).context;
  assert.equal(changed.selection.text, text);
  assert.deepEqual(changed.pendingComments, context.pendingComments);
  queue.reportCurrent({ selection: { line: 50, column: 2, text: "a".repeat(13_000) } });
  assert.equal(frames.at(-1).context.selection.text.length, 12_000);
}));

test("streams a source mutation before the comment context derived from it", () => withTempRoot(async (root) => {
  const entry = path.join(root, "slides", "talk", "index.tsx");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "before");
  const queue = createMutationQueue(root, "secret");
  await queue.seed();
  const frames = recordFrames(queue);
  await writeFile(entry, "after");
  await queue.enqueue("write", entry);
  queue.reportCurrent({
    slideId: "talk",
    pageIndex: 0,
    totalPages: 1,
    pendingComments: [{ id: "c-1234abcd", line: 1, ts: "2026-09-03T00:00:00.000Z", note: "Make this larger" }],
  });
  assert.equal(frames[0].path, "slides/talk/index.tsx");
  assert.equal(frames[0].text, "after");
  assert.equal(frames[1].type, "context");
  assert.equal(frames[1].context.pendingComments[0].id, "c-1234abcd");
}));

test("does not replay a previous iframe's page to a fresh event stream", () => {
  const queue = createMutationQueue("/tmp/project", "secret");
  queue.reportCurrent(pageContext(1));
  const freshFrames = recordFrames(queue);
  assert.deepEqual(freshFrames, []);
  queue.reportCurrent(pageContext(2));
  assert.equal(freshFrames[0].context.pageNumber, 3);
  queue.reportCurrent(pageContext(3));
  const reconnectFrames = recordFrames(queue, 2);
  assert.equal(reconnectFrames[0].context.pageNumber, 4);
});

test("replays everything after a bridge cursor of zero and announces the cursor", () => {
  const queue = createMutationQueue("/tmp/project", "secret");
  // A bridge that attached before the first event learned cursor 0. Anything
  // broadcast while it was between streams must come back on resume, or the
  // project never receives an edit Open Slide already accepted.
  assert.equal(queue.attach({ on() {}, write() { return true; } }), 0);
  queue.reportCurrent(pageContext(1));
  queue.reportCurrent(pageContext(2));
  const resumed = [];
  const cursor = queue.attach({
    on() {},
    write(frame) { resumed.push(JSON.parse(frame.split("data: ")[1])); return true; },
  }, 0);
  assert.deepEqual(resumed.map((event) => event.id), [1, 2]);
  assert.equal(cursor, 2);
});
