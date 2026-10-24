import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform as transformTsx } from "esbuild";
import { createServer as createViteServer } from "vite";
import { createAgentActivityChannel, normalizeAgentActivity, transformOpenSlideAgentPresence } from "./agent-presence.mjs";

const CORE = "node_modules/@open-slide/core/";
const coreRoot = realpathSync(fileURLToPath(new URL(`./${CORE}`, import.meta.url)));
// React as Open Slide's own pages load it.
const coreRequire = createRequire(path.join(coreRoot, "package.json"));

/** Compile the patched presence module against Open Slide's locale and stand-ins for its other `@/` modules. */
async function loadPresence(transformed) {
  const modules = {
    "@/lib/use-locale": `export { format } from ${JSON.stringify(path.join(coreRoot, "src/locale/format.ts"))};
      import { en } from ${JSON.stringify(path.join(coreRoot, "src/locale/en.ts"))};
      export const useLocale = () => en;`,
    "@/lib/utils": "export const cn = (...names) => names.filter(Boolean).join(' ');",
  };
  const { outputFiles } = await build({
    stdin: { contents: `${transformed}\nexport { AgentPresencePill };`, loader: "tsx", resolveDir: coreRoot },
    bundle: true,
    write: false,
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    logLevel: "silent",
    plugins: [{
      name: "open-slide-modules",
      setup(build) {
        build.onResolve({ filter: /^@\// }, ({ path: id }) => (id in modules ? { path: id, namespace: "stub" } : undefined));
        build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path: id }) => ({ contents: modules[id], loader: "ts", resolveDir: coreRoot }));
      },
    }],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(coreRequire, module, module.exports);
  return module.exports;
}

async function patchCore(relative) {
  const source = await readFile(new URL(`./${CORE}${relative}`, import.meta.url), "utf8");
  return { source, transformed: transformOpenSlideAgentPresence(source, `/runtime/${CORE}${relative}?v=1`) };
}

const RUNNING = {
  state: "running",
  provider: { id: "claudeAgent", label: "Claude Code" },
  tool: { title: "Edit", detail: "slides/talk/index.tsx" },
  decks: ["talk"],
};

test("shows the Lattice turn's provider and tool in the pill and opens the Lattice panel on click", async () => {
  const { source, transformed } = await patchCore("src/app/components/agent/agent-presence.tsx");
  const { AgentPresence, AgentPresencePill } = await loadPresence(transformed);
  const react = coreRequire("react");
  const { renderToStaticMarkup } = coreRequire("react-dom/server");
  const activity = { ...normalizeAgentActivity(RUNNING), slideId: "talk" };
  const markup = renderToStaticMarkup(react.createElement(AgentPresence, { activity, revision: 1 }));
  // The glow stays upstream's; the pill names the provider and its current tool.
  assert.match(markup, /class="agent-glow"/);
  assert.match(markup, /<button type="button" data-inspector-ui="true"[^>]*>.*Claude Code is editing.*Edit index\.tsx/);
  assert.match(
    renderToStaticMarkup(react.createElement(AgentPresence, { activity: { ...activity, phase: "waiting" }, revision: 1 })),
    /Waiting for you/,
  );

  const posted = [];
  globalThis.window = { parent: { postMessage: (message, origin) => posted.push({ message, origin }) } };
  try {
    AgentPresencePill({ activity }).props.onClick();
  } finally {
    delete globalThis.window;
  }
  assert.equal(posted.length, 1);
  assert.deepEqual({ ...posted[0].message, nonce: typeof posted[0].message.nonce }, {
    type: "lattice:agent-request", version: 1, kind: "open", slideId: "talk", nonce: "string",
  });
  assert.equal(posted[0].origin, "*");

  assert.equal(transformOpenSlideAgentPresence(source, "/project/slides/talk/agent-presence.tsx"), null);
  const agent = await patchCore("src/app/lib/agent/use-agent.ts");
  await transformTsx(agent.transformed, { loader: "tsx" });
  assert.throws(
    () => transformOpenSlideAgentPresence(agent.source.replace("useAgentSessions();", "useSessions();"), `/r/${CORE}src/app/lib/agent/use-agent.ts`),
    /agent presence contract changed/,
  );
});

test("shows a turn only on the decks it names and drops it when the runtime goes away", async () => {
  const { transformed } = await patchCore("src/app/lib/agent/use-agent.ts");
  const hook = transformed.slice(transformed.indexOf("export function useAgentActivity"), transformed.indexOf("export function useAgentDock"));
  const store = transformed.slice(transformed.indexOf("type LatticeAgentActivity"));
  const { code } = await transformTsx(`${hook}\n${store}`.replaceAll("export ", "").replaceAll("import.meta.hot", "hot"), { loader: "ts" });
  const handlers = new Map();
  const sent = [];
  const hot = { on: (event, handler) => handlers.set(event, handler), send: (event) => sent.push(event) };
  // A hook that reads the store as React would on each render.
  const react = { useSyncExternalStore: (_subscribe, read) => read(), useMemo: (compute) => compute() };
  const useAgentActivity = new Function("hot", "useSyncExternalStore", "useMemo", `${code}; return useAgentActivity;`)(
    hot, react.useSyncExternalStore, react.useMemo,
  );
  assert.deepEqual(sent, ["lattice:agent-activity-request"]);
  assert.equal(useAgentActivity("talk"), null);
  handlers.get("lattice:agent-activity")({ activity: { ...normalizeAgentActivity(RUNNING) } });
  assert.deepEqual(useAgentActivity("talk"), {
    provider: "claudeAgent", label: "Claude Code", phase: "tool", title: "Edit", detail: "slides/talk/index.tsx", slideId: "talk",
  });
  assert.equal(useAgentActivity("other-deck"), null);
  handlers.get("lattice:agent-activity")({ activity: null });
  assert.equal(useAgentActivity("talk"), null);
  handlers.get("lattice:agent-activity")({ activity: normalizeAgentActivity(RUNNING) });
  handlers.get("vite:ws:disconnect")();
  assert.equal(useAgentActivity("talk"), null);
});

test("keeps only a live turn that names a deck, with bounded copy", () => {
  assert.deepEqual(normalizeAgentActivity({ ...RUNNING, tool: undefined }), {
    provider: "claudeAgent", label: "Claude Code", phase: "thinking", title: null, detail: null, decks: ["talk"],
  });
  assert.deepEqual(normalizeAgentActivity({ ...RUNNING, state: "waiting" }), {
    provider: "claudeAgent", label: "Claude Code", phase: "waiting", title: null, detail: null, decks: ["talk"],
  });
  assert.equal(normalizeAgentActivity({ ...RUNNING, state: "idle" }), null);
  assert.equal(normalizeAgentActivity({ ...RUNNING, decks: [] }), null);
  assert.equal(normalizeAgentActivity({ ...RUNNING, decks: ["../talk", "a/b"] }), null);
  assert.equal(normalizeAgentActivity(null), null);
  const odd = normalizeAgentActivity({ ...RUNNING, provider: {}, tool: { title: "x".repeat(500), detail: 3 }, decks: ["talk", "talk", 7] });
  assert.equal(odd.label, "Lattice AI");
  assert.equal(odd.provider, "");
  assert.equal(odd.title.length, 200);
  assert.equal(odd.detail, null);
  assert.deepEqual(odd.decks, ["talk"]);
});

/** POST `body` to the channel as the runtime's route would. */
async function post(channel, body) {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  const res = { status: 0, writeHead(status) { this.status = status; return this; }, end() { return this; } };
  await channel.receive(req, res);
  return res.status;
}

test("pushes the host's presence to every page and replays it to a page that loads mid-turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-presence-"));
  const channel = createAgentActivityChannel();
  const server = http.createServer();
  const vite = await createViteServer({
    root,
    configFile: false,
    logLevel: "silent",
    cacheDir: path.join(root, ".vite"),
    plugins: [channel.plugin],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: { server }, watch: null },
  });
  server.on("request", vite.middlewares);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const pages = [];
  const connect = async () => {
    const socket = new WebSocket(url, "vite-hmr");
    const received = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "custom" && message.event === "lattice:agent-activity") received.push(message.data.activity);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    pages.push(socket);
    return { socket, received };
  };
  const settle = (condition) => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => (condition() ? resolve() : Date.now() - started > 5_000 ? reject(new Error("timed out")) : setTimeout(check, 10));
    check();
  });
  try {
    const first = await connect();
    assert.equal(await post(channel, { activity: RUNNING }), 204);
    await settle(() => first.received.length === 1);
    assert.equal(first.received[0].phase, "tool");
    const late = await connect();
    late.socket.send(JSON.stringify({ type: "custom", event: "lattice:agent-activity-request" }));
    await settle(() => late.received.length === 1);
    assert.deepEqual(late.received[0], first.received[0]);
    assert.equal(await post(channel, { activity: { ...RUNNING, state: "idle" } }), 204);
    await settle(() => first.received.length === 2 && late.received.length === 2);
    assert.equal(first.received[1], null);
    assert.equal(await post(channel, "{"), 400);
    assert.equal(await post(channel, { activity: RUNNING, padding: "x".repeat(20_000) }), 400);
  } finally {
    for (const socket of pages) socket.close();
    await vite.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
