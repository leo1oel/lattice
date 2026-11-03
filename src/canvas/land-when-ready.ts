import type { EditorView } from "@codemirror/view";
import { frameCoalescer } from "../app/effect-helpers";
import { surfaceShown } from "../editor/focus-when-shown";

/** How long a jump waits for its source view to be ready before landing as best it can. */
const LANDING_WAIT_MS = 1000;

/**
 * Run `land` in the source view once a jump can land there, a frame at a time
 * until then; the returned function cancels it. Ready means two things:
 * - the view holds `source`: codemirror-host holds an external value back
 *   while someone is typing, so the view can still carry the previous file's
 *   text when a jump arrives;
 * - its surface is shown (focus-when-shown.ts): opening a comment from the
 *   panel over the document moves the canvas into a Trellis tab that shows a
 *   frame or more later. Landed before then, the browser refused the editor
 *   focus and the writer's typing after the jump went nowhere.
 * Neither waits forever: a best-effort landing beats a request nobody answers.
 */
export function landWhenReady(targetView: () => EditorView | null, source: string, land: (view: EditorView) => void): () => void {
  const deadline = performance.now() + LANDING_WAIT_MS;
  const [schedule, cancel] = frameCoalescer(() => {
    const view = targetView();
    if (!view) return;
    const ready = view.state.doc.toString() === source && surfaceShown(view.dom);
    if (!ready && performance.now() < deadline) schedule();
    else land(view);
  });
  schedule();
  return cancel;
}
