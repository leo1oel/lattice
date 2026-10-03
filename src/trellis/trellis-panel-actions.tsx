/**
 * The action buttons in the Project, Papers and Agent panels' headers (their
 * ⋯ menus carry the same actions). Eager but light: rendered by App into the
 * panels' accessory hosts.
 */
import { Fragment, lazy, Suspense, useRef, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookMarked, BookOpen, ClipboardCheck, Plus, Search } from "lucide-react";
import { Tip } from "../components/icon-tip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { NEW_ENTRIES, type NewEntryType } from "../project/project-new-entries";
import type { SynaraHost } from "../app/use-synara-host";
import { MENU_ICONS } from "./trellis-icons";

// The installed RadioGroup's Base UI dependency stays outside startup chunks.
const SynaraPermissionPicker = lazy(() => import("../agent/synara-permission-picker"));

export type PanelActionsProps = {
  mode: "project" | "papers" | "agent";
  synara: Pick<SynaraHost, "origin" | "permissionMode" | "autoModeAvailable" | "changePermissionMode">;
  openBibEntryDialog: (resolveSeed?: string) => void;
  onCheckReferences: () => void;
  onDiscoverLiterature: () => void;
  openProjectFind: () => void;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  requestNewEntry: (type: NewEntryType) => void;
};

export function PanelActions({ mode, synara, ...props }: PanelActionsProps) {
  const { t, i18n } = useLingui();
  const chosenRef = useRef<NewEntryType | null>(null);
  // Icon-only buttons: Tip names each one after its label.
  const paperActions = [
    { icon: <BookOpen size={14} />, label: t`Discover literature`, run: props.onDiscoverLiterature },
    { icon: <BookMarked size={14} />, label: t`Add bibliography entry`, run: () => props.openBibEntryDialog() },
    { icon: <ClipboardCheck size={14} aria-hidden="true" />, label: t`Check references`, run: props.onCheckReferences },
  ];
  return (
    <>
      {mode === "project" && (
        <>
          <DropdownMenu modal={false}>
            <Tip label={t`New…`}>
              <DropdownMenuTrigger asChild>
                <button type="button"><Plus size={14} /></button>
              </DropdownMenuTrigger>
            </Tip>
            {/* The new entry's name field takes focus, so the draft starts only once the
                menu has let focus go: started on select, a keyboard-chosen draft lost its
                field to the closing menu and was canceled. */}
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const type = chosenRef.current;
                chosenRef.current = null;
                if (type) props.requestNewEntry(type);
              }}
            >
              {NEW_ENTRIES.map((entry) => (
                <Fragment key={entry.type}>
                  {entry.separated && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => { chosenRef.current = entry.type; }}>
                    {MENU_ICONS[`new-${entry.type}`]}
                    {i18n._(entry.label)}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip label={t`Find in project`}>
            <button
              onClick={() => {
                props.setProjectSearchOpen(false);
                props.openProjectFind();
              }}
            >
              <Search size={13} />
            </button>
          </Tip>
        </>
      )}
      {mode === "papers" && paperActions.map((action) => (
        <Tip key={action.label} label={action.label}>
          <button type="button" onClick={action.run}>{action.icon}</button>
        </Tip>
      ))}
      {mode === "agent" && synara.origin && (
        <Suspense fallback={null}>
          <SynaraPermissionPicker
            value={synara.permissionMode}
            autoModeAvailable={synara.autoModeAvailable}
            onChange={synara.changePermissionMode}
          />
        </Suspense>
      )}
    </>
  );
}
