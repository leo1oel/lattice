import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createViteConfig } from "@open-slide/core/vite";
import { stop as stopEsbuild } from "esbuild";
import { createServer as createViteServer, optimizeDeps, resolveConfig } from "vite";

const VERSION = "1.19.1";
const RUNTIME_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PREVIOUS_CONTENT_LIMIT = 2 * 1024 * 1024;
const PREVIOUS_CONTENT_TOTAL_LIMIT = 8 * 1024 * 1024;
const EVENT_HISTORY_LIMIT = 8 * 1024 * 1024;
const ECHO_TTL_MS = 5_000;
const TRANSFORM_IDLE_MS = 10_000;
const BLOCKED_ROUTES = new Set(["/__update-check", "/__update-package", "/__restart-server", "/__server-status"]);
const MUTATION_ROUTE_PREFIXES = [
  "/__assets",
  "/__comments",
  "/__design",
  "/__edit",
  "/__folders",
  "/__lattice/rename-asset",
  "/__notes",
  "/__slides",
];

const LATTICE_EDITOR_STYLES = `

/* Open Slide uses brand for editor interactions: the Present button, active
   page number, selected thumbnail, resize affordance, and focus indicators.
   Lattice's subtle active surface gives those controls a light-gray treatment;
   destructive/status colors remain semantically distinct. */
:root {
  --brand: var(--accent);
  --brand-foreground: var(--accent-foreground);
  --brand-soft: var(--accent);
  --ring: var(--muted-foreground);
  --sidebar-ring: var(--muted-foreground);
}

/* Keep small labels such as the active page number legible while backgrounds
   and selection outlines use the lighter active surface above. */
.text-brand {
  color: var(--muted-foreground);
}

/* The split Present control is a flat Lattice surface. Open Slide's brand
   button adds a bottom shadow that reads as a stray border, and brightens an
   already-light neutral on hover. Preserve only the divider between halves. */
[data-lattice-present] > button {
  box-shadow: none;
  filter: none;
}
[data-lattice-present] > button + button {
  box-shadow: inset 1px 0 0 oklch(0 0 0 / 0.12);
}
[data-lattice-present] > button:hover {
  background: color-mix(in oklch, var(--brand) 94%, black);
  filter: none;
}
[data-lattice-present] > button:active {
  background: color-mix(in oklch, var(--brand) 90%, black);
  filter: none;
}

/* The save action sits inside an already elevated card. Its brand variant's
   extra bottom shadow reads as a dark border rather than useful depth. */
[data-lattice-save-card] [data-variant="brand"] {
  box-shadow: none;
  filter: none;
}

/* Match Lattice's quiet, hover-revealed PDF and editor scrollbar. */
@media (pointer: fine) {
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"] {
    padding: 0;
    border: 0;
    opacity: 0;
    transition: opacity 120ms ease-out 160ms;
  }
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"][data-hovering],
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"][data-scrolling] {
    opacity: 1;
    transition-duration: 160ms;
    transition-delay: 0ms;
  }
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"] > [data-slot="scroll-area-thumb"] {
    flex: none;
    width: 4px;
    margin: 8px auto;
    transform: translateX(-2px);
    background: color-mix(in srgb, var(--foreground) 8%, transparent);
    transition: background-color 160ms ease-in-out, width 160ms ease-in-out;
  }
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"]:hover > [data-slot="scroll-area-thumb"] {
    width: 6px;
    background: color-mix(in srgb, var(--foreground) 12%, transparent);
  }
  [data-slot="scroll-area"]:has([data-slot="scroll-area-viewport"] aside)
    > [data-slot="scroll-area-scrollbar"] > [data-slot="scroll-area-thumb"]:active {
    background: color-mix(in srgb, var(--foreground) 16%, transparent);
  }
}
`;

export function transformOpenSlideEditorStyles(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/styles.css")) return null;
  const fontImport = '@import "@fontsource-variable/geist";';
  if (!source.includes(fontImport) || !source.includes('"Geist Variable"')) {
    throw new Error("Open Slide's editor font contract changed");
  }
  const withLatticeFont = source
    .replace(fontImport, '@import "@fontsource-variable/inter";')
    .replaceAll('"Geist Variable"', '"Inter Variable"');
  return `${withLatticeFont}${LATTICE_EDITOR_STYLES}`;
}

export function transformOpenSlideThumbnailRail(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/components/thumbnail-rail.tsx")) return null;
  const roomyGap = "group/thumb flex w-full items-start gap-2.5 rounded-[6px]";
  const trailingNumber = "mt-1.5 flex w-7 shrink-0 flex-col items-end gap-1";
  if (!source.includes(roomyGap) || !source.includes(trailingNumber)) {
    throw new Error("Open Slide's thumbnail rail layout contract changed");
  }
  // Center the preview itself inside the hover surface and place the folio in
  // the resulting left gutter. Keeping both items in normal flex flow makes
  // the much wider preview look right-heavy even when their bounds are centered.
  return source
    .replace(
      roomyGap,
      "group/thumb relative flex w-full items-start justify-center gap-1 rounded-[6px]",
    )
    .replace(
      trailingNumber,
      "absolute left-2 mt-1.5 flex w-7 shrink-0 flex-col items-start gap-1",
    );
}

export function transformOpenSlideComments(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/lib/inspector/use-comments.ts")) return null;
  const silentRemove = `      const res = await fetch(\`/__comments/\${id}?slideId=\${encodeURIComponent(slideId)}\`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(\`DELETE /__comments/\${id} → \${res.status}\`);
      await refetch();`;
  if (!source.includes(silentRemove)) {
    throw new Error("Open Slide's comment removal contract changed");
  }
  // Upstream lets delete failures escape from an unawaited click handler, so
  // read-only and network errors look like a dead button. Keep the comment and
  // surface the server's explanation in the existing comment-panel error row.
  return source.replace(silentRemove, `      try {
        const res = await fetch(\`/__comments/\${id}?slideId=\${encodeURIComponent(slideId)}\`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? \`DELETE /__comments/\${id} → \${res.status}\`);
        }
        await refetch();
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }`);
}

export function transformOpenSlideInspectorPanel(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/components/inspector/inspector-panel.tsx")) return null;
  const agentImport = "import { useAgentSocketConnected } from '@/lib/use-agent-socket';\n";
  const badgeCall = "            <AgentWatchingBadge />\n";
  const badgeStart = "function AgentWatchingBadge() {";
  const badgeEnd = "// The cue animation re-mounts with every element selection;";
  if (
    !source.includes(agentImport)
    || !source.includes(badgeCall)
    || !source.includes(badgeStart)
    || !source.includes(badgeEnd)
  ) {
    throw new Error("Open Slide's inspector agent badge contract changed");
  }
  // Lattice shows included context beside the agent composer. A second badge
  // inside the inspector claims the agent is actively watching and duplicates
  // connection state without giving the user another action.
  let transformed = source
    .replace(agentImport, "")
    .replace(badgeCall, "");
  const start = transformed.indexOf(badgeStart);
  const end = transformed.indexOf(badgeEnd, start);
  transformed = `${transformed.slice(0, start)}${transformed.slice(end)}`;
  return transformed;
}

export function transformOpenSlideSaveFeedback(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (modulePath.endsWith("/@open-slide/core/src/app/components/inspector/save-bar.tsx")) {
    const swallowedFailure = `    // Each provider surfaces its own errors via toast; swallow here so
    // one failure doesn't reject the combined save.
    await Promise.all(tasks).catch(() => {});`;
    if (!source.includes(swallowedFailure)) {
      throw new Error("Open Slide's combined save contract changed");
    }
    return source.replace(swallowedFailure, `    // Each provider owns its detailed error toast, but the rejection must
    // reach SaveCard so a failed write is never announced as saved.
    await Promise.all(tasks);`);
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/components/panel/save-card.tsx")) {
    const optimisticSave = `  const handleSave = async () => {
    await onSave();
    setJustSaved(true);
  };`;
    const cardRoot = `    <div
      {...dataAttrs}
      className={cn(`;
    if (!source.includes(optimisticSave) || !source.includes(cardRoot)) {
      throw new Error("Open Slide's save card contract changed");
    }
    return source
      .replace(optimisticSave, `  const handleSave = async () => {
    try {
      await onSave();
      setJustSaved(true);
    } catch {
      // The provider already displayed the detailed failure. Keep the draft
      // dirty and avoid replacing that truthful state with a Saved message.
    }
  };`)
      .replace(cardRoot, `    <div
      {...dataAttrs}
      data-lattice-save-card=""
      className={cn(`);
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/components/inspector/inspector-provider.tsx")) {
    const reportedPartialFailure = "      if (failures.length > 0) toast.error(`${t.inspector.saveFailed} ${failures.join('; ')}`);";
    if (!source.includes(reportedPartialFailure)) {
      throw new Error("Open Slide's inspector partial-save contract changed");
    }
    // A batch can return HTTP 200 while individual edits fail. Reject that
    // outcome too, so the save card keeps the remaining edits marked dirty.
    return source.replace(
      reportedPartialFailure,
      "      if (failures.length > 0) throw new Error(failures.join('; '));",
    );
  }
  if (modulePath.endsWith("/@open-slide/core/src/app/components/style-panel/design-provider.tsx")) {
    const reportedDesignFailure = "    if (!r.ok) toast.error(r.error ?? 'Failed to save');";
    if (!source.includes(reportedDesignFailure)) {
      throw new Error("Open Slide's design save contract changed");
    }
    return source.replace(reportedDesignFailure, `    if (!r.ok) {
      const message = r.error ?? 'Failed to save';
      toast.error(message);
      throw new Error(message);
    }`);
  }
  return null;
}

export function transformOpenSlideToolbar(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/routes/slide.tsx")) return null;
  const viewportCentered = "pointer-events-none relative flex min-w-0 justify-center px-2 md:absolute md:inset-x-0";
  const presentGroup = '<div className="inline-flex items-stretch">';
  const badgeCall = "{import.meta.env.DEV && <AgentConnectedBadge />}";
  const badgeStart = "function AgentConnectedBadge() {";
  const badgeEnd = "function SelectionReporter() {";
  if (
    !source.includes(viewportCentered)
    || !source.includes(presentGroup)
    || !source.includes(badgeCall)
    || !source.includes(badgeStart)
    || !source.includes(badgeEnd)
  ) {
    throw new Error("Open Slide's toolbar layout contract changed");
  }
  // Open Slide's absolute md+ title can overlap both toolbar groups when a
  // deck is hosted in a narrow Lattice pane. Keep its mobile behavior, then
  // let the title consume and truncate within the real remaining space.
  let transformed = source.replace(
    viewportCentered,
    "pointer-events-none relative flex min-w-0 justify-center px-2 md:flex-1",
  );
  transformed = transformed.replace(
    presentGroup,
    '<div data-lattice-present className="inline-flex items-stretch">',
  );
  transformed = transformed.replace(
    badgeCall,
    "{import.meta.env.DEV && <AgentConnectionWarning />}",
  );
  const start = transformed.indexOf(badgeStart);
  const end = transformed.indexOf(badgeEnd, start);
  const warning = `function AgentConnectionWarning() {
  const t = useLocale();
  const connected = useAgentSocketConnected();
  if (connected) return null;
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="ml-1 flex shrink-0 cursor-help items-center gap-1.5 rounded-[3px] border border-hairline bg-card px-1.5 py-0.5 text-[10.5px] text-foreground/85 outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span aria-hidden className="relative inline-flex size-1.5 rounded-full bg-rose-500" />
              {t.slide.agentDisconnected}
            </button>
          }
        />
        <TooltipContent
          side="bottom"
          align="start"
          className="w-max max-w-[min(520px,calc(100vw-2rem))] text-center leading-relaxed"
        >
          {t.slide.agentDisconnectedTooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

`;
  return `${transformed.slice(0, start)}${warning}${transformed.slice(end)}`;
}

export function transformOpenSlideConnectionCopy(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  const replacements = modulePath.endsWith("/@open-slide/core/src/locale/en.ts")
    ? [
        ["agentDisconnected: 'Agent disconnected'", "agentDisconnected: 'Live context disconnected'"],
        [
          "'Lost connection to the dev server, so your agent can no longer see the current slide or inspector selection. Restart the dev server to restore the connection.'",
          "'The current slide and inspector selection are not syncing. The agent can still edit deck files. Reopen the presentation to restore live context.'",
        ],
        [
          "noThemesHintPrefix: 'Run '",
          "noThemesHintPrefix: 'Ask Lattice AI to create one, or enter '",
        ],
        [
          "noThemesHintSuffix: ' to author one — a markdown file under themes/ plus a sibling demo slide.'",
          "noThemesHintSuffix: ' in the AI composer and choose Create Theme from the slash menu.'",
        ],
        [
          "noDemoHintPrefix: 'Re-run '",
          "noDemoHintPrefix: 'Ask Lattice AI to regenerate it, or enter '",
        ],
        [
          "noDemoHintSuffix: ' for this theme to generate a preview slide.'",
          "noDemoHintSuffix: ' in the AI composer and choose Create Theme from the slash menu.'",
        ],
      ]
    : modulePath.endsWith("/@open-slide/core/src/locale/zh-cn.ts")
      ? [
          ["agentDisconnected: 'Agent 已断开'", "agentDisconnected: '页面上下文未同步'"],
          [
            "'已和 dev server 断开连接，agent 没办法再看到你目前的 slide 或 Inspector 选择。请重新启动 dev server 来恢复连接。'",
            "'当前页面与检查器选区未同步。Agent 仍可编辑演示文稿文件；请重新打开演示文稿以恢复实时上下文。'",
          ],
          [
            "noThemesHintPrefix: '运行 '",
            "noThemesHintPrefix: '让 Lattice AI 为你创建主题，或在 AI 输入框中输入 '",
          ],
          [
            "noThemesHintSuffix: ' 来创建一个 — 一个位于 themes/ 的 markdown 文件，加上同名的 demo slide。'",
            "noThemesHintSuffix: '，并从斜杠菜单中选择“创建主题”。'",
          ],
          [
            "noDemoHintPrefix: '对此主题重新运行 '",
            "noDemoHintPrefix: '让 Lattice AI 重新生成预览，或在 AI 输入框中输入 '",
          ],
          [
            "noDemoHintSuffix: ' 即可生成预览用的 slide。'",
            "noDemoHintSuffix: '，并从斜杠菜单中选择“创建主题”。'",
          ],
        ]
      : null;
  if (!replacements) return null;
  let transformed = source;
  for (const [before, after] of replacements) {
    if (!transformed.includes(before)) {
      throw new Error("Open Slide's locale copy contract changed");
    }
    transformed = transformed.replace(before, after);
  }
  return transformed;
}

export function transformOpenSlideAssets(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  let transformed = source;
  const replace = (before, after) => {
    if (!transformed.includes(before)) {
      throw new Error("Open Slide's project asset contract changed");
    }
    transformed = transformed.replace(before, after);
  };

  if (modulePath.endsWith("/@open-slide/core/src/app/lib/assets.ts")) {
    replace(
      `  unused: boolean;
};`,
      `  unused: boolean;
  usedInPresentation?: boolean;
};`,
    );
    replace(
      `export type UploadOptions = { overwrite?: boolean };

export async function listAssets(slideId: string): Promise<AssetEntry[]> {
  const res = await fetch(\`/__assets/\${slideId}\`);
  if (!res.ok) throw new Error(\`GET /__assets/\${slideId} \${res.status}\`);
  const data = (await res.json()) as { assets?: AssetEntry[] };
  return data.assets ?? [];
}`,
      `export type UploadOptions = { overwrite?: boolean };

const GLOBAL_ASSET_SCOPE = '@global';

export async function listAssets(slideId: string): Promise<AssetEntry[]> {
  const res = await fetch(\`/__assets/\${GLOBAL_ASSET_SCOPE}\`);
  if (!res.ok) throw new Error(\`GET /__assets/\${GLOBAL_ASSET_SCOPE} \${res.status}\`);
  const data = (await res.json()) as { assets?: AssetEntry[] };
  const assets = data.assets ?? [];
  if (slideId === GLOBAL_ASSET_SCOPE) return assets;

  const usageRes = await fetch(
    \`/__lattice/assets-used?slideId=\${encodeURIComponent(slideId)}\`,
  );
  if (!usageRes.ok) {
    throw new Error(\`GET /__lattice/assets-used \${usageRes.status}\`);
  }
  const usageData = (await usageRes.json()) as { names?: string[] };
  const used = new Set(usageData.names ?? []);
  return assets.map((asset) => ({
    ...asset,
    usedInPresentation: used.has(asset.name),
  }));
}`,
    );
    replace(
      `async function renameAsset(slideId: string, from: string, to: string): Promise<Response> {
  return fetch(\`/__assets/\${slideId}/\${encodeURIComponent(from)}\`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: to }),
  });
}`,
      `async function renameAsset(_slideId: string, from: string, to: string): Promise<Response> {
  return fetch('/__lattice/rename-asset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
}`,
    );
    const scopedUrl = "/__assets/${slideId}/";
    if (!transformed.includes(scopedUrl)) {
      throw new Error("Open Slide's project asset routes changed");
    }
    transformed = transformed.replaceAll(scopedUrl, "/__assets/${GLOBAL_ASSET_SCOPE}/");
    replace("const list = await listAssets(slideId);", "const list = await listAssets(GLOBAL_ASSET_SCOPE);");
    replace(
      "if (!data || data.slideId === slideId) {",
      "if (!data || data.slideId === GLOBAL_ASSET_SCOPE || data.slideId === slideId) {",
    );
    return transformed;
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/components/asset-view.tsx")) {
    replace(
      `  const t = useLocale();

  const deferredQuery = useDeferredValue(query);`,
      `  const t = useLocale();
  const scopedAssets = useMemo(
    () => (scope === 'slide' ? assets.filter((asset) => asset.usedInPresentation) : assets),
    [assets, scope],
  );

  const deferredQuery = useDeferredValue(query);`,
    );
    replace("filterAssets(assets, {", "filterAssets(scopedAssets, {");
    replace(
      "[assets, deferredQuery, sort.direction, sort.key, typeFilter, usageFilter],",
      "[deferredQuery, scope, scopedAssets, sort.direction, sort.key, typeFilter, usageFilter],",
    );
    replace(
      "else toast.success(format(t.asset.toastUploadedAs, { name: next.name }));",
      `else {
        toast.success(format(t.asset.toastUploadedAs, { name: next.name }));
        if (!lockedToGlobal) setScope('global');
      }`,
    );
    replace(
      "else toast.success(format(t.asset.toastUploaded, { name: file.name }));",
      `else {
      toast.success(format(t.asset.toastUploaded, { name: file.name }));
      if (!lockedToGlobal) setScope('global');
    }`,
    );
    replace(
      "{scope === 'global' ? 'assets/' : `slides/${slideId}/assets/`}",
      "assets/",
    );
    replace(
      "{format(assets.length === 1 ? t.asset.fileCount.one : t.asset.fileCount.other, {",
      "{format(scopedAssets.length === 1 ? t.asset.fileCount.one : t.asset.fileCount.other, {",
    );
    replace(
      "count: assets.length.toString().padStart(2, '0'),",
      "count: scopedAssets.length.toString().padStart(2, '0'),",
    );
    replace("        ) : assets.length === 0 ? (", "        ) : scopedAssets.length === 0 ? (");
    replace(
      `            const assetPath =
              scope === 'global' ? \`@assets/\${target.name}\` : \`./assets/\${target.name}\`;`,
      "            const assetPath = `@assets/${target.name}`;",
    );
    replace(
      "const importPath = scope === 'global' ? `@assets/${asset.name}` : `./assets/${asset.name}`;",
      "const importPath = `@assets/${asset.name}`;",
    );
    return transformed;
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/components/inspector/asset-picker-dialog.tsx")) {
    replace(
      "const images = assets.filter((a) => a.mime.startsWith('image/'));",
      `const images = assets.filter(
    (asset) => asset.mime.startsWith('image/') && (scope === 'global' || asset.usedInPresentation),
  );`,
    );
    replace(
      "const path = scope === 'global' ? 'assets/' : `slides/${slideId}/assets/`;",
      "const path = 'assets/';",
    );
    replace("onPick(entry, scope);", "onPick(entry, 'global');");
    replace("onClick={() => onPick(asset, scope)}", "onClick={() => onPick(asset, 'global')}");
    return transformed;
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/components/image-placeholder.tsx")) {
    replace(
      "ops: [{ kind: 'replace-placeholder-with-image', assetPath: `./assets/${entry.name}` }],",
      "ops: [{ kind: 'replace-placeholder-with-image', assetPath: `@assets/${entry.name}` }],",
    );
    return transformed;
  }

  const localeReplacements = modulePath.endsWith("/@open-slide/core/src/locale/en.ts")
    ? [
        ["sectionAria: 'Slide assets'", "sectionAria: 'Presentation assets'"],
        ["scopeSlide: 'This slide'", "scopeSlide: 'This presentation'"],
        [
          "deleteAssetDescription: 'Delete {name}? Imports referencing this file in the slide will break.'",
          "deleteAssetDescription: 'Delete {name} from the project assets folder? This cannot be undone.'",
        ],
      ]
    : modulePath.endsWith("/@open-slide/core/src/locale/zh-cn.ts")
      ? [
          ["sectionAria: '幻灯片素材'", "sectionAria: '演示文稿素材'"],
          ["scopeSlide: '当前幻灯片'", "scopeSlide: '当前演示文稿'"],
          [
            "deleteAssetDescription: '要删除 {name} 吗?幻灯片中引用此文件的导入将失效。'",
            "deleteAssetDescription: '要从项目 assets 文件夹中删除 {name} 吗？此操作无法撤销。'",
          ],
        ]
      : null;
  if (!localeReplacements) return null;
  for (const [before, after] of localeReplacements) replace(before, after);
  return transformed;
}

export function transformOpenSlideHomeChrome(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  let transformed = source;
  const remove = (fragment) => {
    if (!transformed.includes(fragment)) {
      throw new Error("Open Slide's home chrome contract changed");
    }
    transformed = transformed.replace(fragment, "");
  };
  const removeRange = (start, end) => {
    const startIndex = transformed.indexOf(start);
    const endIndex = transformed.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) {
      throw new Error("Open Slide's home chrome contract changed");
    }
    transformed = transformed.slice(0, startIndex) + transformed.slice(endIndex);
  };

  if (modulePath.endsWith("/@open-slide/core/src/app/components/sidebar/folder-item.tsx")) {
    const iconImport = "import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';\n";
    const emojiBranch = `  if (icon.type === 'emoji') {
    return (
      <span
        className={cn(
          'inline-flex size-5 items-center justify-center text-[15px] leading-none',
          className,
        )}
      >
        {icon.value}
      </span>
    );
  }
`;
    if (!transformed.includes(iconImport) || !transformed.includes(emojiBranch)) {
      throw new Error("Open Slide's sidebar icon contract changed");
    }
    const latticeIconBranch = `  if (icon.type === 'emoji') {
    const BuiltInIcon = icon.value === '🎞️'
      ? Presentation
      : icon.value === '🎨'
        ? Palette
        : icon.value === '🗂️'
          ? Image
          : icon.value === '📝'
            ? FileText
            : null;
    if (BuiltInIcon) {
      return (
        <BuiltInIcon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0', className)}
          strokeWidth={1.6}
        />
      );
    }
    return (
      <span
        className={cn(
          'inline-flex size-5 items-center justify-center text-[15px] leading-none',
          className,
        )}
      >
        {icon.value}
      </span>
    );
  }
`;
    return transformed
      .replace(
        iconImport,
        "import { FileText, Image, MoreHorizontal, Palette, Pencil, Presentation, Trash2 } from 'lucide-react';\n",
      )
      .replace(emojiBranch, latticeIconBranch);
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/routes/home.tsx")) {
    const spaciousGrid = "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-9 md:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]";
    const oversizedTitle = "font-heading text-[32px] font-semibold leading-[1.05] tracking-[-0.025em] md:text-[44px]";
    if (!transformed.includes(spaciousGrid) || !transformed.includes(oversizedTitle)) {
      throw new Error("Open Slide's home content contract changed");
    }
    return transformed
      .replace(
        spaciousGrid,
        "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-7 md:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]",
      )
      .replace(
        oversizedTitle,
        "font-heading text-[26px] font-semibold leading-tight tracking-[-0.02em] md:text-[28px]",
      );
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/routes/themes.tsx")) {
    const oversizedTitle = "font-heading text-[32px] font-semibold leading-[1.05] tracking-[-0.025em] md:text-[44px]";
    if (!transformed.includes(oversizedTitle)) {
      throw new Error("Open Slide's themes title contract changed");
    }
    return transformed.replace(
      oversizedTitle,
      "font-heading text-[26px] font-semibold leading-tight tracking-[-0.02em] md:text-[28px]",
    );
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/routes/home-shell.tsx")) {
    remove("import { Menu } from 'lucide-react';\n");
    remove("import { LanguageToggle } from '@/components/language-toggle';\n");
    remove("import { ThemeToggle } from '@/components/theme-toggle';\n");
    remove(`import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
`);
    remove("import { CommandMenuTrigger } from '../components/command/command-menu';\n");
    remove("import { HomeCommandMenu } from '../components/command/home-command-menu';\n");
    remove("import { FolderIconChip } from '../components/sidebar/folder-item';\n");
    remove(`  const [commandOpen, setCommandOpen] = useState(false);
  const openCommandMenu = useCallback(() => setCommandOpen(true), []);

`);
    remove("          onOpenCommandMenu={openCommandMenu}\n");
    removeRange(
      "        <div className=\"flex items-center justify-between border-b border-hairline bg-sidebar px-4 py-3 md:hidden\">\n",
      "        <div\n          className={cn(\n",
    );
    remove(`
      <HomeCommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        folders={manifest.folders}
        titleMap={titleMap}
        onSelectView={selectFolder}
      />
`);
    const reactImport = "import { useCallback, useMemo, useState } from 'react';\n";
    const resizableReactImport = "import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';\n";
    const homeShellStart = "export function HomeShell() {";
    const sidebarStart = "      <div className=\"hidden md:block\">\n        <Sidebar\n";
    const sidebarEnd = "        />\n      </div>\n\n      <div className=\"relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-canvas\">";
    if (
      !transformed.includes(reactImport)
      || !transformed.includes(homeShellStart)
      || !transformed.includes(sidebarStart)
      || !transformed.includes(sidebarEnd)
    ) {
      throw new Error("Open Slide's home layout contract changed");
    }
    const resizableSidebar = `const HOME_SIDEBAR_WIDTH_STORAGE_KEY = 'open-slide:home-sidebar-width';
const DEFAULT_HOME_SIDEBAR_WIDTH = 264;
const MIN_HOME_SIDEBAR_WIDTH = 200;
const MAX_HOME_SIDEBAR_WIDTH = 480;
const HOME_SIDEBAR_RESIZE_LABELS: Record<string, string> = {
  en: 'Resize sidebar',
  'zh-CN': '调整侧边栏宽度',
  'zh-TW': '調整側邊欄寬度',
  ja: 'サイドバーの幅を調整',
};

function readStoredHomeSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_HOME_SIDEBAR_WIDTH;
  const raw = window.localStorage.getItem(HOME_SIDEBAR_WIDTH_STORAGE_KEY);
  const parsed = raw == null ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HOME_SIDEBAR_WIDTH;
  return Math.min(MAX_HOME_SIDEBAR_WIDTH, Math.max(MIN_HOME_SIDEBAR_WIDTH, parsed));
}

function ResizableHomeSidebar({ children }: { children: ReactNode }) {
  const t = useLocale();
  const [width, setWidth] = useState<number>(readStoredHomeSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(HOME_SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  useEffect(() => {
    if (!resizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  const stopResize = () => {
    dragRef.current = null;
    setResizing(false);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setResizing(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = dragRef.current.startWidth + event.clientX - dragRef.current.startX;
    setWidth(Math.min(MAX_HOME_SIDEBAR_WIDTH, Math.max(MIN_HOME_SIDEBAR_WIDTH, next)));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopResize();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      setWidth((current) => Math.max(MIN_HOME_SIDEBAR_WIDTH, current - step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      setWidth((current) => Math.min(MAX_HOME_SIDEBAR_WIDTH, current + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      setWidth(DEFAULT_HOME_SIDEBAR_WIDTH);
    }
  };

  return (
    <div className="relative hidden shrink-0 md:block" style={{ width }}>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={HOME_SIDEBAR_RESIZE_LABELS[t.id] ?? HOME_SIDEBAR_RESIZE_LABELS.en}
        aria-valuenow={width}
        aria-valuemin={MIN_HOME_SIDEBAR_WIDTH}
        aria-valuemax={MAX_HOME_SIDEBAR_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={stopResize}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setWidth(DEFAULT_HOME_SIDEBAR_WIDTH)}
        className={cn(
          'group/resize absolute inset-y-0 right-0 z-20 w-1.5 translate-x-1/2 cursor-col-resize touch-none outline-none',
          'focus-visible:bg-brand/20',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-brand opacity-0 transition-opacity duration-150',
            'group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100',
            resizing && 'opacity-100',
          )}
        />
      </div>
    </div>
  );
}

`;
    return transformed
      .replace(reactImport, resizableReactImport)
      .replace(homeShellStart, `${resizableSidebar}${homeShellStart}`)
      .replace(sidebarStart, "      <ResizableHomeSidebar>\n        <Sidebar\n")
      .replace(sidebarEnd, "        />\n      </ResizableHomeSidebar>\n\n      <div className=\"relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-canvas\">");
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/components/sidebar/sidebar.tsx")) {
    remove("import { LanguageToggle } from '@/components/language-toggle';\n");
    remove("import { ThemeToggle } from '@/components/theme-toggle';\n");
    remove("import { CommandMenuTrigger } from '../command/command-menu';\n");
    remove("import { SidebarFooter } from './sidebar-footer';\n");
    remove("  onOpenCommandMenu,\n");
    remove("  onOpenCommandMenu: () => void;\n");
    removeRange(
      "      <div className=\"flex items-center justify-between px-4 pt-5 pb-4\">\n",
      "      <div className=\"px-2\">\n",
    );
    remove(`
      <div className="border-t border-hairline">
        <SidebarFooter />
      </div>
`);
    const fixedWidth = "relative flex h-full w-[16.5rem] shrink-0 flex-col";
    const navigationStart = "      <div className=\"px-2\">\n";
    if (!transformed.includes(fixedWidth) || !transformed.includes(navigationStart)) {
      throw new Error("Open Slide's home layout contract changed");
    }
    return transformed
      .replace(fixedWidth, "relative flex h-full w-full shrink-0 flex-col")
      .replace(navigationStart, "      <div className=\"px-2 pt-3\">\n");
  }

  if (modulePath.endsWith("/@open-slide/core/src/app/components/command/command-menu.tsx")) {
    remove("import { Check, Languages, Loader2, Monitor, Moon, RotateCw, Search, Sun } from 'lucide-react';\n");
    transformed = "import { Check, Loader2, RotateCw, Search } from 'lucide-react';\n" + transformed;
    remove("import { useTheme } from 'next-themes';\n");
    remove("import { LOCALE_OPTIONS, setLocale } from '@/lib/locale-store';\n");
    remove("import { format, useLocale } from '@/lib/use-locale';\n");
    transformed = transformed.replace(
      "import { useRestartServer } from '@/lib/use-restart-server';\n",
      "import { useLocale } from '@/lib/use-locale';\nimport { useRestartServer } from '@/lib/use-restart-server';\n",
    );
    remove("  const { theme, setTheme } = useTheme();\n");
    remove(`    const appearance: CommandSpec[] = [
      {
        id: 'theme-light',
        label: format(t.commandMenu.themeItem, { name: t.themeToggle.light }),
        icon: <Sun />,
        keywords: ['theme', 'light', 'appearance'],
        active: theme === 'light',
        run: () => setTheme('light'),
      },
      {
        id: 'theme-dark',
        label: format(t.commandMenu.themeItem, { name: t.themeToggle.dark }),
        icon: <Moon />,
        keywords: ['theme', 'dark', 'appearance'],
        active: theme === 'dark',
        run: () => setTheme('dark'),
      },
      {
        id: 'theme-system',
        label: format(t.commandMenu.themeItem, { name: t.themeToggle.system }),
        icon: <Monitor />,
        keywords: ['theme', 'system', 'appearance'],
        active: theme === 'system',
        run: () => setTheme('system'),
      },
      ...LOCALE_OPTIONS.map((option) => ({
        id: \`locale-\${option.id}\`,
        label: format(t.commandMenu.languageItem, { name: option.label }),
        icon: <Languages />,
        keywords: ['language', 'locale', option.id],
        active: t.id === option.id,
        run: () => setLocale(option.id),
      })),
    ];

`);
    remove("      { id: 'appearance', heading: t.commandMenu.groupAppearance, items: appearance },\n");
    const dependencies = "  }, [t, theme, setTheme, canRestart, restarting, restartServer]);\n";
    if (!transformed.includes(dependencies)) {
      throw new Error("Open Slide's home chrome contract changed");
    }
    return transformed.replace(
      dependencies,
      "  }, [t, canRestart, restarting, restartServer]);\n",
    );
  }

  return null;
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) return null;
  return normalized;
}

const PRESENTATION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const ASSET_FORBIDDEN_RE = /[/\\:*?"<>|]/;

function validAssetName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return null;
  if (
    ASSET_FORBIDDEN_RE.test(trimmed)
    || [...trimmed].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    || trimmed.startsWith(".")
    || trimmed.startsWith("~")
  ) return null;
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 && dot < trimmed.length - 1 ? trimmed : null;
}

async function presentationEntries(root) {
  const slidesRoot = path.join(root, "slides");
  let entries;
  try {
    entries = await fs.readdir(slidesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && PRESENTATION_ID_RE.test(entry.name))
    .map((entry) => ({
      id: entry.name,
      entry: path.join(slidesRoot, entry.name, "index.tsx"),
      assets: path.join(slidesRoot, entry.name, "assets"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function replaceQuotedAssetPath(source, before, after) {
  let transformed = source;
  for (const quote of ["'", "\"", "`"]) {
    transformed = transformed.replaceAll(`${quote}${before}${quote}`, `${quote}${after}${quote}`);
  }
  return transformed;
}

export async function listUsedGlobalAssetNames(root, slideId) {
  if (!PRESENTATION_ID_RE.test(slideId)) throw new Error("Invalid presentation ID");
  const source = await fs.readFile(path.join(root, "slides", slideId, "index.tsx"), "utf8");
  let entries;
  try {
    entries = await fs.readdir(path.join(root, "assets"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && validAssetName(entry.name))
    .map((entry) => entry.name)
    .filter((name) => ["'", "\"", "`"].some((quote) => (
      source.includes(`${quote}@assets/${name}${quote}`)
    )))
    .sort((left, right) => left.localeCompare(right));
}

export async function renameGlobalAsset(root, from, to, queue = null) {
  from = validAssetName(from);
  to = validAssetName(to);
  if (!from || !to) return { ok: false, status: 400, error: "Invalid asset name" };
  if (from === to) return { ok: true, status: 200, name: to, updatedSlides: [] };
  const assetsRoot = path.join(root, "assets");
  const sourceAsset = path.join(assetsRoot, from);
  const targetAsset = path.join(assetsRoot, to);
  try {
    const stat = await fs.stat(sourceAsset);
    if (!stat.isFile()) return { ok: false, status: 404, error: "Asset not found" };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, status: 404, error: "Asset not found" };
    throw error;
  }
  try {
    await fs.access(targetAsset);
    return { ok: false, status: 409, error: "Target already exists" };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sourcePath = `@assets/${from}`;
  const targetPath = `@assets/${to}`;
  const updates = [];
  for (const presentation of await presentationEntries(root)) {
    let source;
    try {
      source = await fs.readFile(presentation.entry, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const transformed = replaceQuotedAssetPath(source, sourcePath, targetPath);
    if (transformed !== source) updates.push({ ...presentation, source, transformed });
  }

  await fs.rename(sourceAsset, targetAsset);
  const written = [];
  try {
    for (const update of updates) {
      await fs.writeFile(update.entry, update.transformed);
      written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      await fs.writeFile(update.entry, update.source).catch(() => undefined);
    }
    await fs.rename(targetAsset, sourceAsset).catch(() => undefined);
    throw error;
  }

  if (queue) {
    await queue.enqueue("create", targetAsset);
    for (const update of updates) await queue.enqueue("write", update.entry);
    await queue.enqueue("delete", sourceAsset);
  }
  return {
    ok: true,
    status: 200,
    name: to,
    updatedSlides: updates.map((update) => update.id),
  };
}

async function fileDigest(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function filesEqual(left, right) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (leftStat.size !== rightStat.size) return false;
  const [leftDigest, rightDigest] = await Promise.all([fileDigest(left), fileDigest(right)]);
  return leftDigest === rightDigest;
}

function availableAssetCopyName(name, occupied) {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);
  for (let index = 1; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, 120 - extension.length - suffix.length)}${suffix}${extension}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

export async function migrateLegacySlideAssets(root, queue = null) {
  const assetsRoot = path.join(root, "assets");
  await fs.mkdir(assetsRoot, { recursive: true });
  const occupied = new Set(
    (await fs.readdir(assetsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  const copied = [];
  const rewritten = [];
  const removals = [];

  for (const presentation of await presentationEntries(root)) {
    let localEntries;
    try {
      localEntries = await fs.readdir(presentation.assets, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let source = null;
    try {
      source = await fs.readFile(presentation.entry, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const originalSource = source;

    for (const entry of localEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !validAssetName(entry.name)) continue;
      const localAsset = path.join(presentation.assets, entry.name);
      const localPath = `./assets/${entry.name}`;
      let targetName = entry.name;
      let targetAsset = path.join(assetsRoot, targetName);
      if (occupied.has(targetName) && !await filesEqual(localAsset, targetAsset)) {
        targetName = availableAssetCopyName(entry.name, occupied);
        targetAsset = path.join(assetsRoot, targetName);
      }
      if (source?.includes(localPath)) {
        const next = replaceQuotedAssetPath(source, localPath, `@assets/${targetName}`);
        // Preserve unusual dynamic references rather than deleting the file
        // underneath syntax that Open Slide cannot safely rewrite.
        if (next === source || next.includes(localPath)) continue;
        source = next;
      }
      if (!occupied.has(targetName)) {
        await fs.copyFile(localAsset, targetAsset);
        occupied.add(targetName);
        copied.push(targetAsset);
      }
      removals.push({ file: localAsset, directory: presentation.assets });
    }
    if (source !== null && source !== originalSource) {
      rewritten.push({ file: presentation.entry, source });
    }
  }

  for (const update of rewritten) await fs.writeFile(update.file, update.source);
  for (const removal of removals) await fs.unlink(removal.file);
  for (const directory of new Set(removals.map((removal) => removal.directory))) {
    await fs.rmdir(directory).catch(() => undefined);
  }
  if (queue) {
    for (const file of copied) await queue.enqueue("create", file);
    for (const update of rewritten) await queue.enqueue("write", update.file);
    for (const removal of removals) await queue.enqueue("delete", removal.file);
  }
  return { copied: copied.length, rewritten: rewritten.length, removed: removals.length };
}

function equalSecret(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  return req.headers.authorization?.replace(/^Bearer /, "") || "";
}

export function createMutationQueue(root, controlToken) {
  const clients = new Set();
  const pending = new Map();
  const echoes = new Map();
  const known = new Map();
  const history = [];
  let historyBytes = 0;
  let knownContentBytes = 0;
  let sequence = 0;
  let timer;
  let currentSlide = null;
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  const remember = (data) => data
    ? { digest: digest(data), size: data.length, data: data.length <= PREVIOUS_CONTENT_LIMIT ? data : null }
    : null;
  const rememberKnown = (relative, entry) => {
    const previous = known.get(relative);
    if (previous?.data) knownContentBytes -= previous.data.length;
    known.delete(relative);
    if (!entry) return;
    known.set(relative, entry);
    if (entry.data) knownContentBytes += entry.data.length;
    if (knownContentBytes <= PREVIOUS_CONTENT_TOTAL_LIMIT) return;
    for (const value of known.values()) {
      if (!value.data || value === entry) continue;
      knownContentBytes -= value.data.length;
      value.data = null;
      if (knownContentBytes <= PREVIOUS_CONTENT_TOTAL_LIMIT) break;
    }
  };
  const rememberFile = async (absolute) => {
    const stat = await fs.stat(absolute);
    if (stat.size <= PREVIOUS_CONTENT_LIMIT) return remember(await fs.readFile(absolute));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    return { digest: hash.digest("hex"), size: stat.size, data: null };
  };
  const expectEcho = (relative, signatures) => {
    echoes.set(relative, { signatures, expiresAt: Date.now() + ECHO_TTL_MS });
  };
  const consumeEcho = (relative, signature) => {
    const echo = echoes.get(relative);
    if (!echo) return false;
    if (echo.expiresAt <= Date.now()) {
      echoes.delete(relative);
      return false;
    }
    if (!echo.signatures.has(signature)) return false;
    echoes.delete(relative);
    return true;
  };
  const broadcast = (event) => {
    sequence += 1;
    const frame = `id: ${sequence}\ndata: ${JSON.stringify({ id: sequence, ...event })}\n\n`;
    const frameBytes = Buffer.byteLength(frame);
    if (frameBytes <= EVENT_HISTORY_LIMIT) {
      history.push({ id: sequence, frame, bytes: frameBytes });
      historyBytes += frameBytes;
      while (historyBytes > EVENT_HISTORY_LIMIT && history.length > 1) {
        historyBytes -= history.shift().bytes;
      }
    }
    for (const response of clients) {
      // `write()` returning false means Node buffered the complete frame and
      // wants the producer to observe backpressure; it does not mean the SSE
      // client disconnected. Destroying here cut large source-change events
      // short, so comments appeared to save and then raised "network error".
      response.write(frame);
    }
  };
  async function enqueue(kind, absolute) {
    const relative = safeRelativePath(path.relative(root, absolute));
    if (!relative || path.basename(relative).startsWith(".lattice-sync-")) return;
    let data;
    try { data = kind === "delete" ? null : await fs.readFile(absolute); } catch { kind = "delete"; }
    const signature = `${kind}:${data ? digest(data) : ""}`;
    if (consumeEcho(relative, signature)) return;
    const previous = pending.get(relative)?.previous ?? known.get(relative)?.data ?? null;
    const current = known.get(relative);
    if (
      (data && current?.size === data.length && current.digest === digest(data))
      || (!data && !current)
    ) return;
    pending.set(relative, { kind, data, previous });
    clearTimeout(timer);
    timer = setTimeout(flush, 40);
  }
  function flush() {
    for (const [relative, event] of pending) {
      const utf8 = event.data?.toString("utf8");
      const text = event.data && Buffer.from(utf8, "utf8").equals(event.data) ? utf8 : undefined;
      const previousUtf8 = event.previous?.toString("utf8");
      const previousText = event.previous && Buffer.from(previousUtf8, "utf8").equals(event.previous)
        ? previousUtf8
        : undefined;
      broadcast({
        path: relative,
        kind: event.kind,
        ...(event.data ? (text === undefined ? { base64: event.data.toString("base64") } : { text }) : {}),
        ...(event.previous
          ? (previousText === undefined
              ? { previousBase64: event.previous.toString("base64") }
              : { previousText })
          : {}),
      });
      rememberKnown(relative, remember(event.data));
    }
    pending.clear();
  }
  function reportCurrent(raw) {
    if (raw == null || typeof raw !== "object") return;
    const next = currentSlide ? { ...currentSlide } : {
      slideId: "",
      pageIndex: 0,
      pageNumber: 1,
      totalPages: 1,
      slideTitle: "",
      view: "slides",
      pagePath: "",
      selection: null,
    };
    if (typeof raw.slideId === "string") {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(raw.slideId)) return;
      const totalPages = typeof raw.totalPages === "number"
        && Number.isFinite(raw.totalPages)
        && raw.totalPages > 0
        ? Math.floor(raw.totalPages)
        : 1;
      const pageIndex = Math.max(0, Math.min(
        totalPages - 1,
        typeof raw.pageIndex === "number" && Number.isFinite(raw.pageIndex)
          ? Math.floor(raw.pageIndex)
          : 0,
      ));
      if (currentSlide?.slideId !== raw.slideId || currentSlide.pageIndex !== pageIndex) {
        next.selection = null;
      }
      next.slideId = raw.slideId;
      next.pageIndex = pageIndex;
      next.pageNumber = pageIndex + 1;
      next.totalPages = totalPages;
      next.slideTitle = typeof raw.slideTitle === "string" ? raw.slideTitle.slice(0, 200) : raw.slideId;
      next.view = raw.view === "assets" ? "assets" : "slides";
      next.pagePath = `slides/${raw.slideId}/index.tsx`;
    }
    if (Object.hasOwn(raw, "selection")) {
      const selection = raw.selection;
      next.selection = selection
        && typeof selection === "object"
        && typeof selection.line === "number"
        && Number.isFinite(selection.line)
        && typeof selection.column === "number"
        && Number.isFinite(selection.column)
        ? {
            line: Math.max(1, Math.floor(selection.line)),
            column: Math.max(0, Math.floor(selection.column)),
            tagName: typeof selection.tagName === "string"
              ? selection.tagName.toLowerCase().slice(0, 32)
              : "unknown",
            text: typeof selection.text === "string"
              ? selection.text.replace(/\s+/g, " ").trim().slice(0, 120)
              : "",
          }
        : null;
    }
    if (!next.slideId) return;
    currentSlide = next;
    broadcast({
      type: "context",
      context: { ...next, updatedAt: new Date().toISOString() },
    });
  }
  async function sync(operations) {
    for (const operation of operations) {
      const relative = safeRelativePath(operation.path);
      if (!relative || !["write", "create", "delete"].includes(operation.kind)) throw new Error("Invalid sync operation");
      const target = path.join(root, relative);
      if (operation.kind === "delete") {
        expectEcho(relative, new Set(["delete:"]));
        rememberKnown(relative, null);
        await fs.rm(target, { recursive: true, force: true });
      } else {
        const data = operation.base64 !== undefined ? Buffer.from(operation.base64, "base64") : Buffer.from(operation.text ?? "");
        // Watchers do not reliably distinguish create from write, so accept either echo kind.
        expectEcho(relative, new Set([`create:${digest(data)}`, `write:${digest(data)}`]));
        rememberKnown(relative, remember(data));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
      }
    }
  }
  async function syncFile(relative, readable) {
    relative = safeRelativePath(relative);
    if (!relative) throw new Error("Invalid sync path");
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(
      path.dirname(target),
      `.lattice-sync-${randomBytes(12).toString("hex")}`,
    );
    const hash = createHash("sha256");
    const chunks = [];
    let size = 0;
    const inspect = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > 256 * 1024 * 1024) {
          callback(new Error("Synced files cannot exceed 256 MiB"));
          return;
        }
        hash.update(chunk);
        if (size <= PREVIOUS_CONTENT_LIMIT) chunks.push(Buffer.from(chunk));
        else chunks.length = 0;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(readable, inspect, createWriteStream(temporary, { flags: "wx" }));
      const signature = hash.digest("hex");
      expectEcho(relative, new Set([`create:${signature}`, `write:${signature}`]));
      rememberKnown(relative, {
        digest: signature,
        size,
        data: size <= PREVIOUS_CONTENT_LIMIT ? Buffer.concat(chunks) : null,
      });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  async function seed() {
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if ([".git", ".research", "dist", "node_modules"].includes(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const relative = safeRelativePath(path.relative(root, absolute));
          if (relative) rememberKnown(relative, await rememberFile(absolute));
        }
      }
    };
    await visit(root);
  }
  return {
    enqueue,
    reportCurrent,
    sync,
    syncFile,
    seed,
    attach(response, lastEventId = 0) {
      clients.add(response);
      response.on("close", () => clients.delete(response));
      for (const event of history) {
        if (event.id > lastEventId) response.write(event.frame);
      }
    },
    connected: () => clients.size > 0,
    authorized: (req) => equalSecret(bearer(req), controlToken),
  };
}

export function createAccessPolicy() {
  const leases = new Map();
  return {
    update(leaseId, writable) {
      if (typeof leaseId !== "string" || !/^[a-f0-9-]{36}$/i.test(leaseId)) {
        throw new Error("Invalid presentation lease");
      }
      if (writable === null) leases.delete(leaseId);
      else leases.set(leaseId, writable === true);
    },
    writable() {
      return leases.size > 0 && [...leases.values()].every(Boolean);
    },
  };
}

function safeBootstrapTarget(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const url = new URL(value, "http://127.0.0.1");
    return url.origin === "http://127.0.0.1" ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function isSameOriginBrowserRequest(req, host) {
  const expected = `http://${host}`;
  if (req.headers.origin === expected) return true;
  try {
    if (new URL(req.headers.referer).origin === expected) return true;
  } catch {
    // Requests without a referrer still carry Fetch Metadata in modern WebViews.
  }
  return req.headers["sec-fetch-site"] === "same-origin";
}

function normalizeOpenSlidePreferences(preferences = {}) {
  return {
    locale: preferences.locale === "en" || preferences.locale === "zh-CN"
      ? preferences.locale
      : null,
    theme: preferences.theme === "light" || preferences.theme === "dark"
      ? preferences.theme
      : null,
  };
}

export function createBootstrapDocument(next, preferences = {}) {
  const normalizedPreferences = normalizeOpenSlidePreferences(preferences);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Starting Open Slide</title></head>
<body><script>
const next = ${scriptJson(next)};
const preferences = ${scriptJson(normalizedPreferences)};
try {
  if (preferences.locale) localStorage.setItem("open-slide:locale", preferences.locale);
  if (preferences.theme) localStorage.setItem("theme", preferences.theme);
} catch {}
const navigate = () => location.replace(next);
if (!("serviceWorker" in navigator)) navigate();
else navigator.serviceWorker.getRegistrations()
  .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
  .then(navigate, navigate);
</script></body></html>`;
}

export function createOpenSlideSessionScript(sessionToken, preferences = {}) {
  return `(() => {
  const sessionToken = ${scriptJson(sessionToken)};
  const preferences = ${scriptJson(normalizeOpenSlidePreferences(preferences))};
  try {
    if (preferences.locale) localStorage.setItem("open-slide:locale", preferences.locale);
    if (preferences.theme) localStorage.setItem("theme", preferences.theme);
  } catch {}
  const nativeOpen = window.open.bind(window);
  window.open = (value, target, features) => {
    if (typeof value === "string") {
      try {
        const requested = new URL(value, location.href);
        if (requested.origin === location.origin && requested.pathname !== "/__lattice/bootstrap") {
          const next = requested.pathname + requested.search + requested.hash;
          const bootstrap = new URL("/__lattice/bootstrap", location.origin);
          bootstrap.searchParams.set("token", sessionToken);
          bootstrap.searchParams.set("next", next);
          value = bootstrap.href;
        }
      } catch {}
    }
    return nativeOpen(value, target, features);
  };
})();`;
}

export async function start({ root = process.env.OPEN_SLIDE_SHADOW_ROOT, controlToken = process.env.OPEN_SLIDE_CONTROL_TOKEN } = {}) {
  if (!root || !controlToken) throw new Error("Managed shadow root and control token are required");
  root = await fs.realpath(root);
  const cacheDir = process.env.OPEN_SLIDE_CACHE_ROOT;
  if (!cacheDir) throw new Error("Managed Vite cache root is required");
  await fs.mkdir(cacheDir, { recursive: true });
  const sessionToken = randomBytes(32).toString("base64url");
  const queue = createMutationQueue(root, controlToken);
  const access = createAccessPolicy();
  await queue.seed();
  let receivedHostSync = false;
  let legacyMigrationNeeded = true;
  let legacyMigrationPromise = null;
  const migrateAssetsIfReady = async () => {
    if (
      !receivedHostSync
      || !legacyMigrationNeeded
      || !access.writable()
      || !queue.connected()
    ) return;
    if (legacyMigrationPromise) return legacyMigrationPromise;
    legacyMigrationPromise = (async () => {
      do {
        legacyMigrationNeeded = false;
        await migrateLegacySlideAssets(root, queue);
      } while (legacyMigrationNeeded && access.writable());
    })();
    try {
      await legacyMigrationPromise;
    } catch (error) {
      legacyMigrationNeeded = true;
      throw error;
    } finally {
      legacyMigrationPromise = null;
    }
  };
  let vite;
  let sessionActivated = false;
  let sessionPreferences = {};
  let transformIdleTimer;
  const scheduleTransformIdle = () => {
    clearTimeout(transformIdleTimer);
    transformIdleTimer = setTimeout(() => {
      // Vite restarts esbuild automatically on the next TSX transform. Keeping
      // its Go service alive while the user only reads or presents a deck costs
      // well over 100 MiB without making that idle experience any faster.
      stopEsbuild();
      globalThis.gc?.();
    }, TRANSFORM_IDLE_MS);
    transformIdleTimer.unref();
  };
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) { res.writeHead(403).end(); return; }
    scheduleTransformIdle();
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === "/__lattice/bootstrap" && equalSecret(url.searchParams.get("token"), sessionToken)) {
      sessionActivated = true;
      sessionPreferences = {
        locale: url.searchParams.get("locale"),
        theme: url.searchParams.get("theme"),
      };
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        // The origin-only referrer lets the loopback server distinguish its
        // own module graph from cross-site drive-by requests without exposing
        // the bootstrap token in subsequent requests.
        "referrer-policy": "origin",
        "x-content-type-options": "nosniff",
      }).end(createBootstrapDocument(
        safeBootstrapTarget(url.searchParams.get("next")),
        sessionPreferences,
      ));
      return;
    }
    if (url.pathname.startsWith("/__lattice/") && req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, last-event-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      }).end(); return;
    }
    if (url.pathname === "/__lattice/events" && queue.authorized(req)) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
        connection: "keep-alive",
      });
      queue.attach(res, Number.parseInt(req.headers["last-event-id"] || "0", 10) || 0);
      res.write(": ready\n\n");
      // Asset migration can emit binaries larger than the bounded replay
      // history. Wait for the durable host bridge so no canonical copy exists
      // only in this disposable shadow workspace.
      void migrateAssetsIfReady().catch((error) => console.error("Open Slide asset migration failed", error));
      return;
    }
    if (url.pathname === "/__lattice/access" && req.method === "POST" && queue.authorized(req)) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        access.update(body.leaseId, body.remove === true ? null : body.writable === true);
        await migrateAssetsIfReady();
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      } catch (error) {
        res.writeHead(400, { "access-control-allow-origin": "*" }).end(String(error.message));
      }
      return;
    }
    if (url.pathname === "/__lattice/sync" && req.method === "POST" && queue.authorized(req)) {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 40 * 1024 * 1024) throw new Error("Sync request is too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks));
        const operations = Array.isArray(body.operations) ? body.operations : [];
        if (operations.some((operation) => (
          typeof operation?.path === "string"
          && /^slides\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\//i.test(operation.path)
        ))) {
          legacyMigrationNeeded = true;
        }
        await queue.sync(operations);
        receivedHostSync = true;
        await migrateAssetsIfReady();
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      } catch (error) {
        res.writeHead(400, { "access-control-allow-origin": "*" }).end(String(error.message));
      }
      return;
    }
    if (url.pathname === "/__lattice/file" && req.method === "PUT" && queue.authorized(req)) {
      try {
        const relative = safeRelativePath(url.searchParams.get("path"));
        await queue.syncFile(relative, req);
        if (/^slides\/[a-z0-9]+(?:-[a-z0-9]+)*\/assets\//i.test(relative)) {
          legacyMigrationNeeded = true;
        }
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      } catch (error) {
        res.writeHead(400, { "access-control-allow-origin": "*" }).end(String(error.message));
      }
      return;
    }
    if (BLOCKED_ROUTES.has(url.pathname)) { res.writeHead(404).end(); return; }
    if (!sessionActivated || !isSameOriginBrowserRequest(req, host)) {
      res.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      }).end("<!doctype html><title>Open Slide session expired</title><body><h1>Open Slide session expired</h1><p>Close and reopen this presentation in Lattice.</p></body>");
      return;
    }
    if (
      req.method !== "GET"
      && req.method !== "HEAD"
      && MUTATION_ROUTE_PREFIXES.some((prefix) => (
        url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
      ))
      && !access.writable()
    ) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "This Lattice project is read-only." }));
      return;
    }
    if (url.pathname === "/__lattice/assets-used" && req.method === "GET") {
      try {
        const names = await listUsedGlobalAssetNames(root, url.searchParams.get("slideId") || "");
        res.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json",
        }).end(JSON.stringify({ names }));
      } catch (error) {
        const status = error.code === "ENOENT" ? 404 : 400;
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (url.pathname === "/__lattice/rename-asset" && req.method === "POST") {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16 * 1024) throw new Error("Rename request is too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks));
        const result = await renameGlobalAsset(root, body.from, body.to, queue);
        res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    vite.middlewares(req, res);
  });
  server.prependListener("upgrade", (req, socket) => {
    const host = req.headers.host || "";
    if (!/^127\.0\.0\.1:\d+$/.test(host) || !sessionActivated || req.headers.origin !== `http://${host}`) socket.destroy();
    else scheduleTransformIdle();
  });
  // Lattice owns the workspace layout. Passing an explicit config prevents
  // Open Slide from executing a project-provided open-slide.config.ts inside
  // this unsandboxed Node process.
  const config = await createViteConfig({ userCwd: root, mode: "serve", config: {} });
  const viteConfig = {
    ...config,
    cacheDir,
    configFile: false,
    plugins: [
      {
        name: "lattice:session-bridge",
        enforce: "pre",
        transformIndexHtml: {
          order: "pre",
          handler() {
            return [{
              tag: "script",
              children: createOpenSlideSessionScript(sessionToken, sessionPreferences),
              injectTo: "head-prepend",
            }];
          },
        },
      },
      {
        name: "lattice:embedded-ui",
        enforce: "pre",
        transform(source, id) {
          let transformed = source;
          let changed = false;
          for (const transform of [
            transformOpenSlideEditorStyles,
            transformOpenSlideThumbnailRail,
            transformOpenSlideComments,
            transformOpenSlideInspectorPanel,
            transformOpenSlideSaveFeedback,
            transformOpenSlideToolbar,
            transformOpenSlideConnectionCopy,
            transformOpenSlideAssets,
            transformOpenSlideHomeChrome,
          ]) {
            const next = transform(transformed, id);
            if (next !== null) {
              transformed = next;
              changed = true;
            }
          }
          return changed ? { code: transformed, map: null } : undefined;
        },
      },
      ...(config.plugins ?? []),
      {
        name: "lattice:current-slide-context",
        apply: "serve",
        configureServer(viteServer) {
          viteServer.ws.on("open-slide:current", (raw) => queue.reportCurrent(raw));
        },
      },
    ],
    resolve: {
      ...config.resolve,
      alias: [
        {
          find: /^@open-slide\/core$/,
          replacement: path.join(RUNTIME_ROOT, "node_modules/@open-slide/core/dist/index.js"),
        },
        {
          find: /^@fontsource-variable\/inter$/,
          replacement: path.join(RUNTIME_ROOT, "node_modules/@fontsource-variable/inter/index.css"),
        },
        {
          find: /^lucide-react$/,
          replacement: path.join(RUNTIME_ROOT, "lucide-open-slide.mjs"),
        },
        {
          find: /^katex$/,
          replacement: path.join(RUNTIME_ROOT, "node_modules/katex/dist/katex.mjs"),
        },
        {
          find: /^katex\/dist\/katex\.min\.css$/,
          replacement: path.join(RUNTIME_ROOT, "node_modules/katex/dist/katex.min.css"),
        },
        ...Object.entries(config.resolve?.alias ?? {}).map(([find, replacement]) => ({ find, replacement })),
      ],
    },
    // stdout is the parent-process readiness protocol. Vite's informational
    // optimizer messages would otherwise race the JSON handshake after an app
    // update invalidates the cache.
    logLevel: "error",
    // Avoid crawling Open Slide's whole source tree, but prebundle its large UI
    // dependencies explicitly. Leaving lucide and Base UI as native ESM makes
    // the webview fetch and parse thousands of modules before it can render.
    optimizeDeps: {
      ...config.optimizeDeps,
      entries: [],
      noDiscovery: true,
      include: [
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom",
        "react-dom/client",
        "next-themes",
        "react-router-dom",
        "@base-ui/react/button",
        "@base-ui/react/context-menu",
        "@base-ui/react/dialog",
        "@base-ui/react/menu",
        "@base-ui/react/merge-props",
        "@base-ui/react/popover",
        "@base-ui/react/progress",
        "@base-ui/react/scroll-area",
        "@base-ui/react/select",
        "@base-ui/react/separator",
        "@base-ui/react/slider",
        "@base-ui/react/tabs",
        "@base-ui/react/toggle",
        "@base-ui/react/toggle-group",
        "@base-ui/react/tooltip",
        "@base-ui/react/use-render",
        "@dnd-kit/core",
        "@dnd-kit/sortable",
        "@dnd-kit/utilities",
        "use-sync-external-store/shim",
        "use-sync-external-store/shim/with-selector",
        "lucide-react",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
        "cmdk",
        "emoji-picker-react",
        "fflate",
        "html-to-image",
        "react-image-crop",
        "sonner",
      ],
    },
    server: {
      ...(config.server || {}),
      fs: {
        ...config.server?.fs,
        allow: [...(config.server?.fs?.allow ?? []), path.join(RUNTIME_ROOT, "node_modules")],
      },
      middlewareMode: true,
      hmr: { server },
    },
  };
  // Finish the dependency bundle before the webview connects. Besides avoiding
  // Vite's first-navigation reload, the one-shot optimizer can release its
  // large esbuild context before the long-lived transform service starts.
  const resolvedConfig = await resolveConfig(viteConfig, "serve");
  await optimizeDeps(resolvedConfig, false, true);
  vite = await createViteServer(viteConfig);
  stopEsbuild();
  globalThis.gc?.();
  vite.watcher.on("add", (file) => {
    scheduleTransformIdle();
    void queue.enqueue("create", file);
  });
  vite.watcher.on("change", (file) => {
    scheduleTransformIdle();
    void queue.enqueue("write", file);
  });
  vite.watcher.on("unlink", (file) => {
    scheduleTransformIdle();
    void queue.enqueue("delete", file);
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  process.stdout.write(`${JSON.stringify({ ready: true, port, sessionToken, controlToken, version: VERSION })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(transformIdleTimer);
    setTimeout(() => process.exit(0), 750);
    server.closeAllConnections?.();
    await vite.close().catch(() => undefined);
    stopEsbuild();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  if (process.env.OPEN_SLIDE_PARENT_PIPE === "1") {
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
  }
  return { server, vite, port, sessionToken, controlToken };
}

if (process.argv[1] === new URL(import.meta.url).pathname) start().catch((error) => { console.error(error); process.exit(1); });
