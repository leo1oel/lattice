import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { transform as transformTsx } from "esbuild";
import { createServer as createViteServer } from "vite";
import { createAgentActivityChannel, normalizeAgentActivity, transformOpenSlideAgentPresence } from "./agent-presence.mjs";

const CORE = "node_modules/@open-slide/core/";

async function patchCore(relative) {
  const source = await readFile(new URL(`./${CORE}${relative}`, import.meta.url), "utf8");
  return { source, transformed: transformOpenSlideAgentPresence(source, `/runtime/${CORE}${relative}?v=1`) };
}

const RUNNING = {
  state: "running",
  provider: { id: "claude", label: "Claude Code" },
  tool: { title: "Edit", detail: "slides/talk/index.tsx" },
  decks: ["talk"],
};

test("feeds the deck's presence from the Lattice turn instead of Open Slide's sessions", async () => {
  const [agent, presence] = await Promise.all([
    patchCore("src/app/lib/agent/use-agent.ts"),
    patchCore("src/app/components/agent/agent-presence.tsx"),
  ]);
  assert.doesNotMatch(agent.transformed, /sessions\.find\(\(s\) => s\.slideId === slideId/);
  assert.match(agent.transformed, /useSyncExternalStore\(subscribeLatticeAgentActivity, readLatticeAgentActivity\)/);
  assert.match(agent.transformed, /import\.meta\.hot\.on\('lattice:agent-activity'/);
  assert.match(agent.transformed, /import\.meta\.hot\.send\('lattice:agent-activity-request'\)/);
  assert.doesNotMatch(presence.transformed, /ProviderLogo|setDockOpen|useAgentState|status\?\.providers/);
  assert.match(presence.transformed, /data-inspector-ui\n {6}onClick=\{\(\) => requestLatticeAgent\('open', activity\.slideId\)\}/);
  assert.match(presence.transformed, /format\(t\.agent\.presenceEditing, \{ provider: activity\.label \}\)/);
  assert.match(presence.transformed, /window\.parent\.postMessage\(\{ type: 'lattice:agent-request'/);
  // The glow, sweep and the rest of the pill stay upstream's.
  assert.match(presence.transformed, /agent-glow[\s\S]*agent-sweep[\s\S]*t\.agent\.presenceWaiting/);
  for (const { transformed } of [agent, presence]) await transformTsx(transformed, { loader: "tsx" });
  assert.equal(transformOpenSlideAgentPresence(agent.source, "/project/slides/talk/index.tsx"), null);
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
    provider: "claude", label: "Claude Code", phase: "tool", title: "Edit", detail: "slides/talk/index.tsx", slideId: "talk",
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
    provider: "claude", label: "Claude Code", phase: "thinking", title: null, detail: null, decks: ["talk"],
  });
  assert.deepEqual(normalizeAgentActivity({ ...RUNNING, state: "waiting" }), {
    provider: "claude", label: "Claude Code", phase: "waiting", title: null, detail: null, decks: ["talk"],
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
