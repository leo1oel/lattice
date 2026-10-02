/**
 * The action buttons in the Project, Papers and Agent panels' headers (their
 * ⋯ menus carry the same actions). Eager but light: rendered by App into the
 * panels' accessory hosts.
 */
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { BookMarked, BookOpen, ClipboardCheck, Plus, Presentation, Search, Shapes, Table2 } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import type { SynaraHost } from "../app/use-synara-host";

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
  setBoardCreateRequest: Dispatch<SetStateAction<number>>;
  setPresentationCreateRequest: Dispatch<SetStateAction<number>>;
  setSpreadsheetCreateRequest: Dispatch<SetStateAction<number>>;
};

export function PanelActions({ mode, synara, ...props }: PanelActionsProps) {
  const { t } = useLingui();
  const newDocumentItems = [
    { icon: <Table2 />, label: t`New spreadsheet`, request: props.setSpreadsheetCreateRequest },
    { icon: <Shapes />, label: t`New board`, request: props.setBoardCreateRequest },
    { icon: <Presentation />, label: t`New presentation`, request: props.setPresentationCreateRequest },
  ];
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
            <DropdownMenuTrigger asChild>
              <button aria-label={t`New document`} title={t`New document`}>
                <Plus size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {newDocumentItems.map((item) => (
                <DropdownMenuItem key={item.label} onSelect={() => item.request((request) => request + 1)}>
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
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
