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
  "/__notes",
  "/__slides",
];

export function replaceOpenSlideEditorFont(source, id) {
  const modulePath = id.split("?", 1)[0].replaceAll("\\", "/");
  if (!modulePath.endsWith("/@open-slide/core/src/app/styles.css")) return null;
  const fontImport = '@import "@fontsource-variable/geist";';
  if (!source.includes(fontImport) || !source.includes('"Geist Variable"')) {
    throw new Error("Open Slide's editor font contract changed");
  }
  return source
    .replace(fontImport, '@import "@fontsource-variable/inter";')
    .replaceAll('"Geist Variable"', '"Inter Variable"');
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === "")) return null;
  return normalized;
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
      if (!response.write(frame)) response.destroy();
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

export function createBootstrapDocument(next) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Starting Open Slide</title></head>
<body><p id="status">Starting Open Slide…</p><script>
const next = ${scriptJson(next)};
const navigate = () => location.replace(next);
if (!("serviceWorker" in navigator)) navigate();
else navigator.serviceWorker.getRegistrations()
  .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
  .then(navigate, navigate);
</script></body></html>`;
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
  let vite;
  let sessionActivated = false;
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
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        // The origin-only referrer lets the loopback server distinguish its
        // own module graph from cross-site drive-by requests without exposing
        // the bootstrap token in subsequent requests.
        "referrer-policy": "origin",
        "x-content-type-options": "nosniff",
      }).end(createBootstrapDocument(safeBootstrapTarget(url.searchParams.get("next"))));
      return;
    }
    if (url.pathname.startsWith("/__lattice/") && req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      }).end(); return;
    }
    if (url.pathname === "/__lattice/events" && queue.authorized(req)) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
        connection: "keep-alive",
      }); queue.attach(res, Number.parseInt(req.headers["last-event-id"] || "0", 10) || 0); res.write(": ready\n\n"); return;
    }
    if (url.pathname === "/__lattice/access" && req.method === "POST" && queue.authorized(req)) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        access.update(body.leaseId, body.remove === true ? null : body.writable === true);
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
        await queue.sync(body.operations || []);
        res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      } catch (error) {
        res.writeHead(400, { "access-control-allow-origin": "*" }).end(String(error.message));
      }
      return;
    }
    if (url.pathname === "/__lattice/file" && req.method === "PUT" && queue.authorized(req)) {
      try {
        await queue.syncFile(url.searchParams.get("path"), req);
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
        name: "lattice:inter-editor-font",
        enforce: "pre",
        transform(source, id) {
          const transformed = replaceOpenSlideEditorFont(source, id);
          return transformed === null ? undefined : { code: transformed, map: null };
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
