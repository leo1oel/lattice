/**
 * Injected by scripts/perf-bench.mjs before any page script runs
 * (Page.addScriptToEvaluateOnNewDocument), so it measures the benchmark page
 * and the real app alike. Plain browser JavaScript, evaluated as a string.
 *
 * What it counts, cumulatively until `reset()`:
 *  - React commits, through a minimal DevTools global hook. React DOM calls
 *    `onCommitFiberRoot` after every commit; the walk below finds the
 *    components that actually rendered in it (the `PerformedWork` flag, only
 *    descending where a subtree's children changed, as React DevTools does)
 *    and how many hooks each of those renders ran. A commit in which no
 *    component rendered or mounted is counted apart, as idle: React only
 *    drops a same-value state update before rendering when the component has
 *    no update left over from its last one, so whether such an update costs
 *    an empty commit depends on how it interleaves with the component's real
 *    updates, which is timing (at startup, the PDF preview between PDF.js
 *    page-render events and the source editor's scrollbar).
 *  - DOM mutations: MutationObserver records over the whole document, split
 *    into child-list, attribute and text changes.
 *  - Long tasks and layout shifts (by the app region they happened in), from
 *    PerformanceObserver. These are wall-clock facts, reported but never gated.
 *
 * Style recalculations and layouts are counted by Chromium itself; the driver
 * reads them over CDP (Performance.getMetrics).
 */
(() => {
  if (window.__latticeProbe) return;
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo

  const blank = () => ({
    commits: 0,
    idleCommits: 0,
    renders: 0,
    mounts: 0,
    hooks: 0,
    components: new Map(),
    origins: new Map(),
    mutations: 0,
    childList: 0,
    attributes: 0,
    characterData: 0,
    addedNodes: 0,
    removedNodes: 0,
    longTasks: 0,
    longTaskMs: 0,
    layoutShift: 0,
    shiftRegions: new Map(),
  });
  let state = blank();

  const nameOf = (fiber) => {
    const type = fiber.type;
    if (!type) return "Anonymous";
    if (typeof type === "function") return type.displayName || type.name || "Anonymous";
    if (typeof type === "object") {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || "ForwardRef";
      if (type.type) return (type.type.displayName || type.type.name || "Memo");
    }
    return "Anonymous";
  };
  const hookCount = (fiber) => {
    if (fiber.tag === 1) return 0;
    let count = 0;
    for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "next" in hook; hook = hook.next) count += 1;
    return count;
  };
  // Where an update came from: a component whose own state or store snapshot
  // changed in this commit ("App#26" is App's 27th hook). Everything else that
  // rendered did so because a parent or a context did.
  const recordOrigins = (fiber, previous, name) => {
    if (fiber.tag === 1) {
      if (fiber.memoizedState !== previous.memoizedState) state.origins.set(`${name}#state`, (state.origins.get(`${name}#state`) || 0) + 1);
      return;
    }
    let hook = fiber.memoizedState;
    let before = previous.memoizedState;
    for (let index = 0; hook && before && typeof hook === "object" && "next" in hook; index += 1) {
      if (hook.queue && hook.memoizedState !== before.memoizedState) {
        const key = `${name}#${index}${hook.queue.getSnapshot ? " (store)" : ""}`;
        state.origins.set(key, (state.origins.get(key) || 0) + 1);
      }
      hook = hook.next;
      before = before.next;
    }
  };
  const record = (fiber, mount, previous) => {
    const name = nameOf(fiber);
    if (!mount && previous) recordOrigins(fiber, previous, name);
    const entry = state.components.get(name) || { renders: 0, mounts: 0 };
    if (mount) {
      entry.mounts += 1;
      state.mounts += 1;
    } else {
      entry.renders += 1;
      state.renders += 1;
    }
    state.hooks += hookCount(fiber);
    state.components.set(name, entry);
  };
  const mountSubtree = (fiber) => {
    // Iterative: a mounted document can be thousands of fibers deep in total.
    const stack = [fiber];
    while (stack.length) {
      const current = stack.pop();
      if (COMPONENT_TAGS.has(current.tag)) record(current, true);
      for (let child = current.child; child; child = child.sibling) stack.push(child);
    }
  };
  const walk = (next, prev) => {
    const stack = [[next, prev]];
    while (stack.length) {
      const [fiber, previous] = stack.pop();
      if (!previous) {
        mountSubtree(fiber);
        continue;
      }
      if (COMPONENT_TAGS.has(fiber.tag) && (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK) record(fiber, false, previous);
      if (fiber.child === previous.child) continue;
      for (let child = fiber.child; child; child = child.sibling) stack.push([child, child.alternate]);
    }
  };

  const renderers = new Map();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    inject(renderer) {
      const id = renderers.size + 1;
      renderers.set(id, renderer);
      return id;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const before = state.renders + state.mounts;
      try {
        walk(root.current, root.current.alternate);
      } catch {
        // Counting must never break the page.
      }
      if (state.renders + state.mounts > before) state.commits += 1;
      else state.idleCommits += 1;
    },
  };

  const countMutations = (records) => {
    for (const mutation of records) {
      state.mutations += 1;
      if (mutation.type === "childList") {
        state.childList += 1;
        state.addedNodes += mutation.addedNodes.length;
        state.removedNodes += mutation.removedNodes.length;
      } else if (mutation.type === "attributes") state.attributes += 1;
      else state.characterData += 1;
    }
  };
  const observer = new MutationObserver(countMutations);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  const REGIONS = [
    [".app-titlebar, .titlebar", "titlebar"],
    [".workspace-sidebar, .project-sidebar, .sidebar", "sidebar"],
    [".pdf-preview, .pdf-viewer", "pdf"],
    [".cm-editor", "source-editor"],
    [".markdown-preview, .ProseMirror", "visual-editor"],
    [".compile-diagnostics, .diagnostics-panel", "diagnostics"],
  ];
  const regionOf = (node) => {
    const element = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!element) return "other";
    for (const [selector, region] of REGIONS) {
      if (element.closest(selector)) return region;
    }
    return "other";
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks += 1;
        state.longTaskMs += entry.duration;
      }
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        state.layoutShift += entry.value;
        const region = regionOf(entry.sources && entry.sources[0] && entry.sources[0].node);
        state.shiftRegions.set(region, (state.shiftRegions.get(region) || 0) + entry.value);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // Engines without these entry types still report the counts above.
  }

  window.__latticeProbe = {
    reset() {
      observer.takeRecords();
      state = blank();
    },
    snapshot(top = 12) {
      // Count records still queued, so nothing is left for the next interval.
      countMutations(observer.takeRecords());
      const components = [...state.components]
        .map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => (b.renders + b.mounts) - (a.renders + a.mounts))
        .slice(0, top);
      return {
        commits: state.commits,
        idleCommits: state.idleCommits,
        renders: state.renders,
        mounts: state.mounts,
        hooks: state.hooks,
        mutations: state.mutations,
        childList: state.childList,
        attributes: state.attributes,
        characterData: state.characterData,
        addedNodes: state.addedNodes,
        removedNodes: state.removedNodes,
        longTasks: state.longTasks,
        longTaskMs: Math.round(state.longTaskMs),
        origins: Object.fromEntries([...state.origins].sort((a, b) => b[1] - a[1]).slice(0, top)),
        layoutShift: Number(state.layoutShift.toFixed(4)),
        shiftRegions: Object.fromEntries([...state.shiftRegions].map(([region, value]) => [region, Number(value.toFixed(4))])),
        components,
      };
    },
  };
})();
