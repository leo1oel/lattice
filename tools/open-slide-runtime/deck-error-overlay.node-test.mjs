import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DECK_ERROR_OVERLAY_SOURCE } from "./deck-error-overlay.mjs";

test("a deck reload dismisses the error overlay raised for that deck's files", () => {
  const overlay = (file) => ({
    closed: false,
    shadowRoot: { querySelector: (selector) => (selector === ".file" ? { textContent: file } : null) },
    close() { this.closed = true; },
  });
  const talk = overlay("/shadow/workspace/slides/talk/index.tsx:3:26");
  const paper = overlay("/shadow/workspace/slides/paper/index.tsx:1:1");
  const listeners = new Map();
  const hot = { on: (event, listener) => listeners.set(event, listener) };
  const document = { querySelectorAll: (selector) => (selector === "vite-error-overlay" ? [talk, paper] : []) };
  runInNewContext(DECK_ERROR_OVERLAY_SOURCE.replaceAll("import.meta.hot", "hot"), { hot, document });

  listeners.get("open-slide:slide-changed")({ slideIds: ["talk"] });
  assert.equal(talk.closed, true);
  assert.equal(paper.closed, false);
});
