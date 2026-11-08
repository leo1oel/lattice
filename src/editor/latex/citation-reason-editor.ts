/**
 * Citation reasons in the source editor: where each of the file's reasons
 * sits as the writer types (mapped through every edit, re-found by context
 * when its cite was cut and pasted, written back once the text around it
 * settles), and the "Why cited" popover that files one on a `\cite` key,
 * opened from the citation card or by right-clicking the key.
 */
import { MapMode, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { closeHoverTooltips, EditorView, showTooltip, ViewPlugin, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { buttonClassName } from "../../components/ui/button-styles";
import { i18n } from "../../i18n";
import { CITATION_ROLES, type CitationRole, type EditorComment } from "../comments/editor-comment-data";
import { element } from "../dom-utils";
import {
  anchorCitationReasons, createCitationReason, reanchoredReason, type CitationSite,
} from "./citation-reasons";
import { citationRoleLabel } from "./citation-roles";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationHoverTarget } from "./latex-symbols";
import { visibleLatexSource } from "./latex-visible-source";

type Placed = {
  reasons: readonly EditorComment[];
  /** Each anchored reason's occurrence, by id; a reason missing here is orphaned. */
  sites: ReadonlyMap<string, CitationSite>;
};

const EMPTY: Placed = { reasons: [], sites: new Map() };

/** The reasons on `path` among the live data's. */
function reasonsOn(data: LatexEditorLiveData, path: string): readonly EditorComment[] {
  const all = data.citationReasons ?? [];
  return all.some((reason) => reason.path === path && !reason.resolved)
    ? all.filter((reason) => reason.path === path && !reason.resolved)
    : [];
}

function sameReasons(a: readonly EditorComment[], b: readonly EditorComment[]): boolean {
  return a.length === b.length && a.every((reason, index) => reason === b[index]);
}

/**
 * The file's reasons and where they sit. An edit first carries each
 * occurrence's span through the change (a span the edit deleted is
 * dropped), so a reason keeps its cite however much text around it
 * changes; only a reason whose span was lost is found again by context.
 */
function placedField(live: () => LatexEditorLiveData, path: string) {
  return StateField.define<Placed>({
    create(state) {
      const reasons = reasonsOn(live(), path);
      return reasons.length ? { reasons, sites: anchorCitationReasons(state.doc.toString(), path, reasons) } : EMPTY;
    },
    update(value, transaction) {
      const reasons = reasonsOn(live(), path);
      if (!transaction.docChanged && sameReasons(reasons, value.reasons)) return value;
      if (!reasons.length) return value.reasons.length ? EMPTY : value;
      const hints = new Map<string, { from: number; to: number }>();
      for (const [id, site] of value.sites) {
        if (!transaction.docChanged) {
          hints.set(id, site);
          continue;
        }
        const from = transaction.changes.mapPos(site.from, 1, MapMode.TrackDel);
        const to = transaction.changes.mapPos(site.to, -1, MapMode.TrackDel);
        if (from !== null && to !== null && to > from) hints.set(id, { from, to });
      }
      return { reasons, sites: anchorCitationReasons(transaction.state.doc.toString(), path, reasons, hints) };
    },
  });
}

/** Text around a reason's cite must sit this long unchanged before the new anchor is saved. */
const SETTLE_MS = 1200;

/**
 * Saves a reason's anchor again once the text right around its key has
 * changed and settled, so the context it is re-found by tracks the
 * writer's edits. A shift in offsets alone is not saved: the context
 * still finds the cite.
 */
function writeBack(field: StateField<Placed>, live: () => LatexEditorLiveData) {
  return ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | null = null;
    /** The state of the last update this plugin saw. */
    state: EditorState;
    constructor(view: EditorView) {
      this.state = view.state;
    }
    update(update: ViewUpdate) {
      this.state = update.state;
      if (!update.docChanged || !update.state.field(field).sites.size) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), SETTLE_MS);
    }
    flush() {
      this.timer = null;
      const save = live().onReanchorCitationReasons;
      const { reasons, sites } = this.state.field(field);
      if (!save) return;
      const source = this.state.doc.toString();
      const moves = new Map<string, NonNullable<ReturnType<typeof reanchoredReason>>>();
      for (const reason of reasons) {
        const site = sites.get(reason.id);
        const next = site && reanchoredReason(source, reason, site);
        if (next && (next.prefix !== reason.prefix || next.suffix !== reason.suffix || next.quote !== reason.quote)) moves.set(reason.id, next);
      }
      if (moves.size) save(moves);
    }
    destroy() {
      if (!this.timer) return;
      clearTimeout(this.timer);
      this.flush();
    }
  });
}

/** The popover's cite: the key's span (mapped through edits while it is open) and the reason it edits, if any. */
type Target = { from: number; to: number; key: string; reasonId?: string };

const openReasonEditor = StateEffect.define<Target | null>();

type ReasonEditorState = { target: Target; tooltip: Tooltip } | null;

export type CitationReasonsApi = {
  /** The reason anchored on the occurrence at `from`..`to` of this editor, if any. */
  reasonAt: (state: EditorState, from: number, to: number) => EditorComment | undefined;
  /** Every anchored reason of this file, with its occurrence. */
  placed: (state: EditorState) => Placed;
  /** Open the popover on the citation key spanning `from`..`to`. */
  edit: (view: EditorView, target: { from: number; to: number; key: string }) => void;
  /** Whether the popover is open: the key's hover card stays away meanwhile. */
  editing: (state: EditorState) => boolean;
};

/**
 * Reasons for the file at `path`, and the popover that edits them; the
 * returned api is how the citation card reads and opens them.
 */
export function citationReasons(live: () => LatexEditorLiveData, path: string): { extension: Extension; api: CitationReasonsApi } {
  const field = placedField(live, path);
  /**
   * The field as of the last transaction, brought up to the live reasons: a
   * reason saved since then reaches the field only with the next edit or
   * caret move, and the card must already show it.
   */
  const placed = (state: EditorState): Placed => {
    const value = state.field(field, false) ?? EMPTY;
    const reasons = reasonsOn(live(), path);
    if (sameReasons(reasons, value.reasons)) return value;
    return { reasons, sites: anchorCitationReasons(state.doc.toString(), path, reasons, value.sites) };
  };
  const reasonAt = (state: EditorState, from: number, to: number) => {
    const { reasons, sites } = placed(state);
    return reasons.find((reason) => {
      const site = sites.get(reason.id);
      return site?.from === from && site.to === to;
    });
  };

  const editorField = StateField.define<ReasonEditorState>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (!effect.is(openReasonEditor)) continue;
        const target = effect.value;
        if (!target) return null;
        const reason = reasonAt(transaction.state, target.from, target.to);
        const opened = { ...target, reasonId: reason?.id };
        return { target: opened, tooltip: { pos: target.from, end: target.to, above: true, create: (view) => popover(view, opened) } };
      }
      if (!value || !transaction.docChanged) return value;
      // The draft survives a collaborator's edit: the popover follows its key.
      const from = transaction.changes.mapPos(value.target.from, 1, MapMode.TrackDel);
      const to = transaction.changes.mapPos(value.target.to, -1, MapMode.TrackDel);
      if (from === null || to === null || to <= from) return null;
      value.target.from = from;
      value.target.to = to;
      (value.tooltip as { pos: number; end?: number }).pos = from;
      (value.tooltip as { pos: number; end?: number }).end = to;
      return value;
    },
    provide: (state) => showTooltip.from(state, (value) => value?.tooltip ?? null),
  });

  const close = (view: EditorView) => {
    if (view.state.field(editorField)) view.dispatch({ effects: openReasonEditor.of(null) });
  };

  function popover(view: EditorView, target: Target) {
    const data = live();
    const existing = target.reasonId ? data.citationReasons?.find((reason) => reason.id === target.reasonId) : undefined;
    let role: CitationRole | null = existing?.citation?.role ?? null;
    const dom = element("div", "citation-reason-popover");
    // No wider than the editor, as the citation card: in a narrow editor a
    // wider popover would push the editor's text sideways when its note takes focus.
    dom.style.maxWidth = `${Math.max(200, view.dom.clientWidth - 16)}px`;
    dom.setAttribute("role", "dialog");
    const title = i18n._(msg`Why cited`);
    dom.setAttribute("aria-label", title);
    const head = element("div", "citation-reason-head");
    head.append(element("strong", "citation-reason-title", title), element("span", "citation-card-key", target.key));
    const roles = element("div", "citation-reason-roles");
    roles.setAttribute("role", "radiogroup");
    roles.setAttribute("aria-label", i18n._(msg`Role`));
    const input = element("input", ["ui-input", "citation-reason-note"].join(" "));
    input.dataset.controlSize = "compact";
    input.type = "text";
    input.value = existing?.body ?? "";
    input.placeholder = i18n._(msg`Add a note`);
    input.setAttribute("aria-label", i18n._(msg`Note`));
    const save = element("button", buttonClassName({ variant: "tinted", size: "compact" }), i18n._(msg`Save`));
    save.type = "button";
    const chips = CITATION_ROLES.map((value) => {
      const chip = element("button", "citation-role-chip", citationRoleLabel(value));
      chip.type = "button";
      chip.dataset.role = value;
      chip.setAttribute("role", "radio");
      chip.addEventListener("click", () => {
        role = value;
        sync();
        input.focus({ preventScroll: true });
      });
      return chip;
    });
    const sync = () => {
      for (const chip of chips) {
        const checked = chip.dataset.role === role;
        chip.setAttribute("aria-checked", String(checked));
        // One stop in the tab order, on the chosen role or else the first.
        chip.tabIndex = checked || (!role && chip === chips[0]) ? 0 : -1;
      }
      save.disabled = !role;
    };
    roles.append(...chips);
    roles.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const at = chips.indexOf(document.activeElement as HTMLButtonElement);
      const next = chips[(Math.max(0, at) + step + chips.length) % chips.length]!;
      role = next.dataset.role as CitationRole;
      sync();
      next.focus({ preventScroll: true });
    });

    const commit = () => {
      const current = live();
      if (!role || !current.onSaveCitationReason) return;
      const doc = view.state.doc.toString();
      if (doc.slice(target.from, target.to).toLocaleLowerCase() !== target.key.toLocaleLowerCase()) return close(view);
      const body = input.value.trim();
      const reason = existing
        ? { ...existing, body, citation: { key: target.key, role } }
        : createCitationReason({
          path,
          source: doc,
          site: target,
          role,
          body,
          authorId: current.citationReasonAuthor?.id ?? "",
          authorName: current.citationReasonAuthor?.name ?? "",
        });
      if (reason) current.onSaveCitationReason(reason);
      close(view);
      view.focus();
    };
    save.addEventListener("click", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        commit();
      }
    });

    const cancel = element("button", buttonClassName({ variant: "ghost", size: "compact" }), i18n._(msg`Cancel`));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      close(view);
      view.focus();
    });
    const actions = element("div", "citation-reason-actions");
    if (existing && data.onDeleteCitationReason) {
      const remove = element("button", buttonClassName({ variant: "ghost", size: "compact", className: "citation-reason-remove" }), i18n._(msg`Remove`));
      remove.type = "button";
      const { onDeleteCitationReason } = data;
      remove.addEventListener("click", () => {
        onDeleteCitationReason(existing.id);
        close(view);
        view.focus();
      });
      actions.append(remove);
    }
    actions.append(element("span", "citation-reason-spacer"), cancel, save);
    dom.append(head, roles, input, actions);
    sync();

    dom.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(view);
      view.focus();
    });
    dom.addEventListener("mousedown", (event) => {
      // The editor must not take the press; and WebKit, which does not focus
      // a pressed button, would otherwise blur the note and close the popover.
      event.stopPropagation();
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });
    // Focus leaving for anywhere but the popover itself (the editor, another panel) puts it away.
    dom.addEventListener("focusout", (event) => {
      if (!(event.relatedTarget instanceof Node && dom.contains(event.relatedTarget))) close(view);
    });
    return {
      dom,
      mount: () => (role ? input : chips[0]!).focus({ preventScroll: true }),
    };
  }

  // The pointer that right-clicked a key still rests on it, so its hover card
  // opens too, and stacked above the popover it pushes the popover off the
  // top of the editor (under the titlebar). The card closes here, and stays
  // closed while the popover is open (`editing`, latex-hover-cards.ts).
  const edit = (view: EditorView, target: { from: number; to: number; key: string }) => {
    view.dispatch({ effects: [openReasonEditor.of(target), closeHoverTooltips] });
  };
  const editing = (state: EditorState) => Boolean(state.field(editorField, false));

  // Right-click on a citation key files its reason; anywhere else keeps the system menu.
  const contextMenu = EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (!live().onSaveCitationReason) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const target = position === null ? null : citationHoverTarget(visibleLatexSource(view.state.doc.toString()), position);
      if (!target) return false;
      event.preventDefault();
      edit(view, target);
      return true;
    },
  });

  return {
    extension: [field, editorField, writeBack(field, live), contextMenu],
    api: { reasonAt, placed, edit, editing },
  };
}
