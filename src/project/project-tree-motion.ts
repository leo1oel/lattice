import { spring } from "../components/ui/motion-values";

const rowsSelector = '[data-file-tree-virtualized-sticky="true"] > [data-type="item"]:not([data-item-parked="true"])';

type Row = {
  element: HTMLElement;
  rect: DOMRect;
  expanded: string | null;
  picture: HTMLElement;
};

/** Animate the mounted window, never the virtualizer's fixed-height geometry.
 * Pierre reuses DOM slots for different paths. Both FLIP and exiting pictures
 * must be keyed by path; animating the reused element's previous content would
 * move the wrong file. Only expansion changes initiate motion, not filtering.
 */
export function attachProjectTreeMotion(scroller: HTMLElement) {
  if (typeof scroller.animate !== "function") return () => {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new Map<Element, Animation>();
  const pictures = new Set<HTMLElement>();
  let scrollTop = scroller.scrollTop;
  let scrollLeft = scroller.scrollLeft;
  const snapshot = () => new Map(Array.from(scroller.querySelectorAll<HTMLElement>(rowsSelector), (element) => [
    element.dataset.itemPath!,
    {
      element,
      rect: element.getBoundingClientRect(),
      expanded: element.getAttribute("aria-expanded"),
      picture: element.cloneNode(true) as HTMLElement,
    },
  ]));
  let previous: Map<string, Row> = snapshot();

  const cancel = () => {
    animations.forEach((animation) => animation.cancel());
    animations.clear();
    pictures.forEach((picture) => picture.remove());
    pictures.clear();
  };
  const reset = () => {
    cancel();
    scrollTop = scroller.scrollTop;
    scrollLeft = scroller.scrollLeft;
    previous = snapshot();
  };
  const onScroll = () => {
    cancel();
    // Do not measure/clone a window on every wheel tick. A subsequent DOM
    // update or input gesture establishes the next stationary baseline.
    previous.clear();
    scrollTop = scroller.scrollTop;
    scrollLeft = scroller.scrollLeft;
  };
  const animate = (element: Element, frames: Keyframe[]) => {
    const animation = element.animate(frames, {
      duration: spring.moderate.duration * 1000,
      easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
    });
    animations.set(element, animation);
    animation.onfinish = () => {
      animations.delete(element);
      if (element instanceof HTMLElement && pictures.delete(element)) element.remove();
    };
  };

  const observer = new MutationObserver(() => {
    const elements = [...scroller.querySelectorAll<HTMLElement>(rowsSelector)];
    const toggled = elements.some((element) => {
      const old = previous.get(element.dataset.itemPath!);
      const expanded = element.getAttribute("aria-expanded");
      return old?.expanded != null && expanded != null && old.expanded !== expanded;
    });
    const pathsChanged = elements.length !== previous.size || elements.some((element) => !previous.has(element.dataset.itemPath!));
    // Ignore our own exit pictures and the hover overlay's child mutations.
    if (!toggled && !pathsChanged) return;
    cancel();
    const next = snapshot();
    if (!toggled || reduced.matches || scrollTop !== scroller.scrollTop || scrollLeft !== scroller.scrollLeft) {
      previous = next;
      scrollTop = scroller.scrollTop;
      scrollLeft = scroller.scrollLeft;
      return;
    }
    const parent = next.values().next().value?.element.parentElement;
    parent?.dispatchEvent(new PointerEvent("pointerleave"));
    const opening = [...next].filter(([path, row]) => row.expanded === "true" && previous.get(path)?.expanded === "false");

    for (const [path, row] of next) {
      const old = previous.get(path);
      if (old?.expanded != null && old.expanded !== row.expanded) {
        const chevron = row.element.querySelector('[data-icon-name="file-tree-icon-chevron"]');
        if (chevron) animate(chevron, [{ rotate: old.expanded === "false" ? "-90deg" : "90deg" }, { rotate: "0deg" }]);
      }
      // Newly mounted overscan rows are not necessarily new descendants.
      const entering = !old && opening.find(([folder]) => path.startsWith(folder));
      const dy = old ? old.rect.top - row.rect.top : 0;
      if (old && Math.abs(dy) > 0.5) {
        animate(row.element, [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }]);
      } else if (entering) {
        // The reveal boundary must follow the displaced sibling exactly.
        // Fading every child at once exposes text beneath that moving sibling.
        const descendants = [...next].filter(([child]) => !previous.has(child) && child.startsWith(entering[0]));
        const top = descendants[0][1].rect.top;
        const height = descendants[descendants.length - 1][1].rect.bottom - top;
        const start = (row.rect.top - top) / height;
        const end = (row.rect.bottom - top) / height;
        animate(row.element, [
          { offset: 0, clipPath: "inset(0 0 100% 0)" },
          { offset: start, clipPath: "inset(0 0 100% 0)" },
          { offset: end, clipPath: "inset(0 0 0% 0)" },
          { offset: 1, clipPath: "inset(0 0 0% 0)" },
        ]);
      }
    }

    // Collapsed descendants are immediately unmounted by Pierre. A clipped,
    // inert picture lets their visible section close in step with the rows
    // moving up below it, without keeping real tree items alive or focusable.
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      let group: Row[] = [];
      const closeGroup = () => {
        if (!group.length) return;
        const first = group[0].rect;
        const last = group[group.length - 1].rect;
        const picture = document.createElement("div");
        picture.inert = true;
        picture.setAttribute("aria-hidden", "true");
        picture.dataset.treeExit = "";
        Object.assign(picture.style, {
          position: "absolute", pointerEvents: "none", overflow: "hidden",
          top: `${first.top - parentRect.top}px`, left: "0", width: "100%", height: `${last.bottom - first.top}px`,
        });
        for (const row of group) {
          const clone = row.picture;
          for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("[id], [tabindex]")]) {
            node.removeAttribute("id");
            node.removeAttribute("tabindex");
          }
          Object.assign(clone.style, {
            position: "absolute", margin: "0", top: `${row.rect.top - first.top}px`,
            left: `${row.rect.left - parentRect.left}px`, width: `${row.rect.width}px`, height: `${row.rect.height}px`,
          });
          picture.append(clone);
        }
        parent.append(picture);
        pictures.add(picture);
        animate(picture, [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 100% 0)" }]);
        group = [];
      };
      for (const [path, row] of previous) {
        const exiting = !next.has(path) && [...next].some(([folder, candidate]) =>
          candidate.expanded === "false" && previous.get(folder)?.expanded === "true" && path.startsWith(folder),
        );
        if (exiting) group.push(row);
        else closeGroup();
      }
      closeGroup();
    }
    previous = next;
  });
  observer.observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-expanded", "data-item-path"] });
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("pointerdown", reset, true);
  scroller.addEventListener("keydown", reset, true);
  scroller.addEventListener("dragstart", reset, true);
  reduced.addEventListener("change", reset);
  return () => {
    observer.disconnect();
    cancel();
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("pointerdown", reset, true);
    scroller.removeEventListener("keydown", reset, true);
    scroller.removeEventListener("dragstart", reset, true);
    reduced.removeEventListener("change", reset);
  };
}
