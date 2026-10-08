/**
 * The titlebar's layout switch: the writer's named workspaces, a "+" that
 * makes one from the arrangement on screen, then the Writing and Reading
 * presets, which lay themselves over whichever workspace is active. One plate
 * slides between them all. A workspace is renamed in place (double-click, F2
 * or its context menu, which also duplicates, moves and deletes it) and moved
 * by dragging too. While the project's layout differs from its workspace's saved
 * arrangement, that workspace shows a dot, and its menus offer to save the
 * layout to it or revert to it. Short of room (`compact`), the workspaces fold into a menu and the
 * presets keep only their icons.
 *
 * Eager but light: it drives the workspace only through the controller.
 */
import { useId, useLayoutEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, LayoutDashboard, Pencil, Plus, Save, Trash2, Undo2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SlidingTabPill } from "../components/ui/motion";
import { notifyInfo } from "../telemetry/app-notify";
import { useCurrentWorkspace, useTrellisUi, useWorkspaces, type TrellisController } from "./trellis-controller";
import { PRESETS } from "./trellis-icons";
import { spaceMixedScript } from "./trellis-titles";
import { WORKSPACE_NAME_MAX, workspaceShortcut, type WorkspaceSummary } from "./trellis-workspaces";

/** The toast that offers to bring a deleted workspace back; a later deletion's replaces it. */
const DELETE_UNDO_TOAST = "trellis-workspace-deleted";
/** How far a press must travel before it drags a workspace rather than clicking it. */
const DRAG_THRESHOLD = 4;

export function LayoutSwitch({ controller, compact }: { controller: TrellisController; compact: boolean }) {
  const { t } = useLingui();
  const library = controller.workspaces;
  const workspaces = useWorkspaces(controller);
  const current = useCurrentWorkspace(controller);
  const preset = useTrellisUi(controller, (state) => state.preset);
  const renaming = useTrellisUi(controller, (state) => state.renaming);
  const dirty = useTrellisUi(controller, (state) => state.dirty);
  const dirtyDot = <span className="trellis-workspace-dirty" role="img" aria-label={t`Unsaved changes`} />;
  const stripId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A press that became a drag must not also click the workspace it dropped.
  const draggedRef = useRef(false);
  const pill = <SlidingTabPill stripId={stripId} />;
  const currentEntry = workspaces.find((entry) => entry.id === current) ?? workspaces[0];
  const currentName = currentEntry.name;
  const renamingEntry = workspaces.find((entry) => entry.id === renaming);
  // What a move from a menu says, there being no drag to see.
  const [announcement, setAnnouncement] = useState("");

  const presetLabels = { writing: t`Writing`, reading: t`Reading` };
  const presetTitles = { writing: t`Source beside the compiled PDF`, reading: t`A paper beside your notes` };
  const rename = (id: string) => controller.ui.set({ renaming: id });
  const create = () => controller.createWorkspace(t`Workspace`);
  const duplicate = (entry: WorkspaceSummary) => {
    const { name } = entry;
    const id = library.duplicate(entry.id, t`${name} copy`);
    if (id) rename(id);
  };
  // No confirmation: the toast that reports it brings it back.
  const remove = (entry: WorkspaceSummary) => {
    const list = library.list();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index < 0 || list.length < 2) return;
    const wasCurrent = controller.ui.get().workspace === entry.id;
    const fallback = (list[index + 1] ?? list[index - 1]).id;
    if (wasCurrent) controller.switchWorkspace(fallback);
    const removed = library.remove(entry.id);
    if (!removed) return;
    const { name } = entry;
    notifyInfo(t`Layout`, spaceMixedScript(t`Deleted “${name}”`), {
      dedupeKey: DELETE_UNDO_TOAST,
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          library.restore(removed);
          if (wasCurrent && controller.ui.get().workspace === fallback) controller.switchWorkspace(entry.id);
        },
      },
    });
  };
  const move = (entry: WorkspaceSummary, to: number) => {
    library.move(entry.id, to);
    const { name } = entry;
    const position = to + 1;
    const count = workspaces.length;
    setAnnouncement(spaceMixedScript(t`Moved “${name}” to position ${position} of ${count}`));
  };
  // Where the keyboard stands in the switch, as the workspace it stands for:
  // a tab's, or the one a menu opened for (portaled out of the track, a menu
  // names it in `data-workspace-origin`; React's focus events still bubble
  // from it to the track), or "" for the folded button, its menu and the
  // switch's other controls: whichever workspace is current when focus
  // comes back, which a shortcut can change while it stays put. Folding or
  // unfolding replaces the workspaces' controls, menus included, and a
  // closing menu removes itself, so focus then goes to that workspace's
  // control on screen. It is kept until focus leaves the switch: for another
  // element, or for none from a control still there (React drops the blur of
  // one its commit removes; WebKit reports none).
  const originRef = useRef<string | null>(null);
  const currentId = currentEntry.id;
  const onTrackFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    originRef.current = target.closest<HTMLElement>("[data-workspace]")?.dataset.workspace
      ?? target.closest<HTMLElement>("[data-workspace-origin]")?.dataset.workspaceOrigin
      ?? "";
  };
  const onTrackBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const left = event.target as HTMLElement;
    // Within the switch, the focus that follows sets it again.
    if (event.relatedTarget) originRef.current = null;
    else queueMicrotask(() => { if (left.isConnected) originRef.current = null; });
  };
  /**
   * Focus, lost while the keyboard was in the switch, back to the control on
   * screen for its workspace: that one's tab, else the folded button, else
   * (the workspace is gone) the current workspace's tab.
   */
  const recoverFocus = () => {
    const origin = originRef.current;
    const track = trackRef.current;
    if (origin === null || !track || (document.activeElement && document.activeElement !== document.body)) return;
    const id = origin || currentId;
    (track.querySelector<HTMLElement>(`[data-workspace="${id}"]`)
      ?? track.querySelector<HTMLElement>("[data-workspace-menu]")
      ?? track.querySelector<HTMLElement>(`[data-workspace="${currentId}"]`))?.focus();
  };
  useLayoutEffect(recoverFocus, [compact, currentId]);
  // A menu closing hands focus back the same way (Rename hands it to the
  // name field instead), but not after a click or focus outside it.
  const menuFocus = {
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (!controller.ui.get().renaming) recoverFocus();
    },
    onInteractOutside: () => { originRef.current = null; },
  };
  // Keyed by the workspace it names wherever it stands, so folding or
  // unfolding the switch mid-edit keeps the field, its draft and its caret.
  const nameField = (entry: WorkspaceSummary) => <NameField key={`name-${entry.id}`} controller={controller} entry={entry} />;

  // The workspace a right-click (or the keyboard's menu key) landed on, and
  // where. Its menu mounts only then: menus are many components, and the
  // strip renders at startup.
  const [menuAt, setMenuAt] = useState<{ entry: WorkspaceSummary; x: number; y: number } | null>(null);
  /** The menu of the workspace `tab`, at `at` or (from the keyboard, with no pointer) below the tab. */
  const openMenuAt = (tab: HTMLElement, at?: { x: number; y: number }) => {
    const entry = workspaces.find((item) => item.id === tab.dataset.workspace);
    if (!entry) return false;
    const box = tab.getBoundingClientRect();
    setMenuAt({ entry, x: at?.x ?? box.left, y: at?.y ?? box.bottom });
    return true;
  };
  const openMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-workspace]");
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    if (tab && openMenuAt(tab, fromKeyboard ? undefined : { x: event.clientX, y: event.clientY })) event.preventDefault();
  };

  // Arrow keys move along the track, workspaces and presets alike, and choose
  // what they reach (as SlidingTabs does). Folded, the workspaces' menu button
  // stands in their place: reaching it chooses the workspace (leaving any
  // preset), and its own keys (Enter, Space, ArrowDown) open the menu.
  const onTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"], [data-workspace-menu]');
    if (!item || !trackRef.current) return;
    if (event.key === "F2" && item.dataset.workspace) {
      event.preventDefault();
      rename(item.dataset.workspace);
      return;
    }
    // Shift+F10 opens a workspace's menu, Move left and right included:
    // macOS has no context-menu key of its own.
    if (event.key === "F10" && event.shiftKey && item.dataset.workspace) {
      event.preventDefault();
      openMenuAt(item);
      return;
    }
    const items = [...trackRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"], [data-workspace-menu]')];
    const index = items.indexOf(item);
    const count = items.length;
    const next = ({ ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
    if (items[next].hasAttribute("data-workspace-menu")) controller.switchWorkspace(currentEntry.id);
    else items[next].click();
  };

  // Dragging a workspace along the strip moves it to where the pointer passes
  // the middle of a neighbour. Window listeners rather than pointer capture:
  // moving the tab in the DOM would release a capture mid-drag.
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || workspaces.length < 2) return;
    const start = { pointerId: event.pointerId, x: event.clientX, moved: false };
    const listening = new AbortController();
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== start.pointerId) return;
      if (!start.moved) {
        if (Math.abs(moved.clientX - start.x) < DRAG_THRESHOLD) return;
        start.moved = true;
        setDragging(id);
      }
      const others = [...trackRef.current?.querySelectorAll<HTMLElement>("[data-workspace]") ?? []].filter((tab) => tab.dataset.workspace !== id);
      const index = others.filter((tab) => {
        const box = tab.getBoundingClientRect();
        return box.left + box.width / 2 < moved.clientX;
      }).length;
      library.move(id, index);
    };
    const end = (ended: PointerEvent) => {
      if (ended.pointerId !== start.pointerId) return;
      listening.abort();
      if (!start.moved) return;
      setDragging(null);
      draggedRef.current = true;
      // The click (if any) follows this release in the same task.
      window.setTimeout(() => { draggedRef.current = false; }, 0);
    };
    window.addEventListener("pointermove", move, { signal: listening.signal });
    window.addEventListener("pointerup", end, { signal: listening.signal });
    window.addEventListener("pointercancel", end, { signal: listening.signal });
  };

  const tabTitle = (entry: WorkspaceSummary, index: number) => {
    const { name } = entry;
    const label = preset && entry.id === current ? t`Return to ${name}` : name;
    const shortcut = workspaceShortcut(index);
    return spaceMixedScript(shortcut ? `${label} · ${shortcut}` : label);
  };

  const workspaceTabs = workspaces.map((entry, index) => {
    if (entry.id === renaming) return nameField(entry);
    const selected = !preset && entry.id === current;
    return (
      <button
        key={entry.id}
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        title={tabTitle(entry, index)}
        data-workspace={entry.id}
        data-underlying={(preset && entry.id === current) || undefined}
        data-dragging={dragging === entry.id || undefined}
        className={`sliding-tab ui-segmented-tab trellis-preset trellis-workspace-tab${selected ? " active" : ""}`}
        onPointerDown={(event) => onPointerDown(event, entry.id)}
        onClick={() => {
          if (!draggedRef.current) controller.switchWorkspace(entry.id);
        }}
        onDoubleClick={() => rename(entry.id)}
      >
        {selected && pill}
        <span className="sliding-tab-label">
          <span className="trellis-preset-label">{entry.name}</span>
          {dirty && entry.id === current && dirtyDot}
        </span>
      </button>
    );
  });
  const workspaceMenuAt = menuAt && (
    <DropdownMenu open modal={false} onOpenChange={(open) => { if (!open) setMenuAt(null); }}>
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" className="trellis-workspace-menu-anchor" style={{ left: menuAt.x, top: menuAt.y }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="min-w-[9rem]"
        // Back to the tab wherever a move put it, or to the folded button.
        data-workspace-origin={menuAt.entry.id}
        {...menuFocus}
      >
        <WorkspaceActions
          controller={controller} entry={menuAt.entry} dirty={dirty && menuAt.entry.id === current} workspaces={workspaces}
          onRename={rename} onDuplicate={duplicate} onMove={move} onDelete={remove}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Folded: one menu button naming the workspace, its plate when no preset is over it.
  const workspaceMenu = (
    <DropdownMenu key="menu" modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`sliding-tab ui-segmented-tab trellis-preset trellis-workspace-menu${preset ? "" : " active"}`}
          aria-label={spaceMixedScript(t`Workspace: ${currentName}`)}
          data-workspace-menu=""
          data-underlying={preset ? "" : undefined}
        >
          {!preset && pill}
          <span className="sliding-tab-label">
            <LayoutDashboard size={13} aria-hidden="true" />
            <span className="trellis-workspace-menu-name">{currentEntry.name}</span>
            {dirty && dirtyDot}
            <ChevronDown size={12} aria-hidden="true" />
          </span>
        </button>
      </DropdownMenuTrigger>
      {/* Unfolding unmounts it, open or not: focus in it goes to the current workspace's tab. */}
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-[12rem]" data-workspace-origin="" {...menuFocus}>
        {workspaces.map((entry, index) => (
          <DropdownMenuItem key={entry.id} role="menuitemradio" aria-checked={entry.id === current} onSelect={() => controller.switchWorkspace(entry.id)}>
            <span className="trellis-menu-check">{entry.id === current && <Check size={14} />}</span>
            <span className="flex-1 truncate">{entry.name}</span>
            {workspaceShortcut(index) && <span className="trellis-menu-shortcut">{workspaceShortcut(index)}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={create}><Plus size={14} />{t`New workspace`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <WorkspaceActions
          controller={controller} entry={currentEntry} dirty={dirty} workspaces={workspaces}
          onRename={rename} onDuplicate={duplicate} onMove={move} onDelete={remove}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div
      ref={trackRef}
      className="ui-segmented ui-segmented--compact trellis-presets"
      onKeyDown={onTrackKeyDown}
      onFocus={onTrackFocus}
      onBlur={onTrackBlur}
    >
      {/* One host for both presentations, so the name field (any workspace's,
          a folded duplicate's too) is the same element through a fold. */}
      <div
        role={compact ? undefined : "tablist"}
        aria-label={compact ? undefined : t`Workspaces`}
        className="trellis-workspace-tabs"
        onContextMenu={openMenu}
      >
        {compact ? [renamingEntry ? nameField(renamingEntry) : workspaceMenu] : workspaceTabs}
      </div>
      {workspaceMenuAt}
      {!compact && (
        // A title like its neighbours', not a Tip: a tooltip's tree is a cost every startup pays.
        <button type="button" className="trellis-workspace-add" aria-label={t`New workspace`} title={t`New workspace`} onClick={create}>
          <Plus size={13} />
        </button>
      )}
      <span className="trellis-presets-divider" aria-hidden="true" />
      <div role="tablist" aria-label={t`Presets`} className="trellis-preset-tabs">
        {PRESETS.map(({ value, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={preset === value}
            tabIndex={preset === value ? 0 : -1}
            title={presetTitles[value]}
            className={`sliding-tab ui-segmented-tab trellis-preset${preset === value ? " active" : ""}`}
            onClick={() => controller.setPreset(value)}
          >
            {preset === value && pill}
            <span className="sliding-tab-label">
              <Icon size={13} aria-hidden="true" />
              <span className="trellis-preset-label">{presetLabels[value]}</span>
            </span>
          </button>
        ))}
      </div>
      {/* Says where a menu's move put a workspace: a live region, not role="status", which the app keeps for loading states. */}
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-workspace-announcement="">{announcement}</span>
    </div>
  );
}

/**
 * Save to workspace and Revert (while the project's layout differs from the
 * workspace it is in), then Rename, Duplicate, Move left or right (the drag's
 * equivalent, for the keyboard and for a pointer that cannot drag) and Delete
 * for one workspace, in its context menu or the folded switch's menu.
 */
function WorkspaceActions({ controller, entry, dirty, workspaces, onRename, onDuplicate, onMove, onDelete }: {
  controller: TrellisController;
  entry: WorkspaceSummary;
  dirty: boolean;
  workspaces: readonly WorkspaceSummary[];
  onRename: (id: string) => void;
  onDuplicate: (entry: WorkspaceSummary) => void;
  onMove: (entry: WorkspaceSummary, to: number) => void;
  onDelete: (entry: WorkspaceSummary) => void;
}) {
  const { t } = useLingui();
  const index = workspaces.findIndex((item) => item.id === entry.id);
  const count = workspaces.length;
  return (
    <>
      {dirty && (
        <>
          <DropdownMenuItem onSelect={() => controller.saveWorkspace()}><Save size={14} />{t`Save to workspace`}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => controller.revertWorkspace()}><Undo2 size={14} />{t`Revert to saved`}</DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={() => onRename(entry.id)}><Pencil size={14} />{t`Rename`}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onDuplicate(entry)}><Copy size={14} />{t`Duplicate`}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={index <= 0} onSelect={() => onMove(entry, index - 1)}><ArrowLeft size={14} />{t`Move left`}</DropdownMenuItem>
      <DropdownMenuItem disabled={index < 0 || index >= count - 1} onSelect={() => onMove(entry, index + 1)}><ArrowRight size={14} />{t`Move right`}</DropdownMenuItem>
      <DropdownMenuSeparator />
      {/* The last workspace stays: a project is always in one. */}
      <DropdownMenuItem data-variant="destructive" disabled={count < 2} onSelect={() => onDelete(entry)}>
        <Trash2 size={14} />{t`Delete`}
      </DropdownMenuItem>
    </>
  );
}

/**
 * A workspace's name, edited in place of its tab. Enter keeps a free name
 * (one already taken is marked and stays in editing), Escape keeps the old
 * one, and leaving the field keeps a free name or else the old one. Enter
 * and Escape hand the keyboard back to the workspace's tab (or menu).
 *
 * The field is as wide as its draft: a hidden copy of the text sizes the box
 * the input fills. `size` counts characters, and a CJK one is about two of
 * the average Latin width it assumes, so a name like "工作区 副本" overflowed a
 * `size`d field and scrolled its first character out of view.
 */
function NameField({ controller, entry }: { controller: TrellisController; entry: WorkspaceSummary }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(entry.name);
  const [taken, setTaken] = useState(false);
  const doneRef = useRef(false);
  const finish = (field: HTMLInputElement, refocus: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const track = field.closest(".trellis-presets");
    controller.ui.set({ renaming: null });
    if (refocus) requestAnimationFrame(() => track?.querySelector<HTMLElement>(`[data-workspace="${entry.id}"], [data-workspace-menu]`)?.focus());
  };
  return (
    <span className="trellis-workspace-name" data-value={draft}>
      <input
        ref={(input) => {
          if (input && !input.dataset.focused) {
            input.dataset.focused = "";
            input.focus();
            input.select();
          }
        }}
        className="trellis-workspace-name-input"
        value={draft}
        maxLength={WORKSPACE_NAME_MAX}
        size={1}
        aria-label={t`Workspace name`}
        aria-invalid={taken || undefined}
        title={taken ? t`Name already used` : undefined}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          setTaken(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            finish(event.currentTarget, true);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (controller.workspaces.rename(entry.id, draft) === "taken") setTaken(true);
            else finish(event.currentTarget, true);
          }
          // The strip's arrow keys move between tabs; here they move the caret.
          event.stopPropagation();
        }}
        onBlur={(event) => {
          if (doneRef.current) return;
          controller.workspaces.rename(entry.id, draft);
          finish(event.currentTarget, false);
        }}
      />
    </span>
  );
}
