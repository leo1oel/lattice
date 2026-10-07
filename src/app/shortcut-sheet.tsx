import { Fragment, useMemo, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Keyboard } from "lucide-react";
import { EmptyState } from "../components/ui/empty-state";
import { Keycaps } from "../components/ui/keycaps";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { filterShortcutGroups, shortcutGroups, type ShortcutRow } from "./shortcut-groups";
import type { AppCommand } from "./use-app-commands";

/**
 * Every keyboard shortcut, grouped by where it works (⌘?, or Keyboard
 * shortcuts in the palette). Built from the keymaps when it opens (see
 * shortcut-groups), so it lists what the keys do in this build; the field
 * filters it by name or by key.
 */
export default function ShortcutSheet({ commands, onClose }: { commands: readonly AppCommand[]; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => shortcutGroups(commands, i18n), [commands, i18n]);
  const shown = filterShortcutGroups(groups, query);
  const title = t`Keyboard shortcuts`;
  return (
    <SheetDialog className="shortcut-sheet" label={title} onClose={onClose}>
      <PanelHeader className="drawer-header" icon={<Keyboard size={16} />} title={title} onClose={onClose} />
      <SearchField
        autoFocus
        aria-label={t`Filter shortcuts`}
        placeholder={t`Filter by name or key`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery("")}
      />
      <ScrollArea className="shortcut-sheet-scroll">
        {shown.length ? (
          <div className="shortcut-sheet-groups">
            {shown.map((group) => (
              <section key={group.id} className="shortcut-group" aria-label={group.title}>
                <h3 className="shortcut-group-title">{group.title}</h3>
                <dl className="shortcut-rows">
                  {group.rows.map((row) => (
                    <div key={row.label} className="shortcut-row">
                      <dt>{row.label}</dt>
                      <dd><ShortcutCombos row={row} /></dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState density="compact" title={t`No shortcut matches “${query.trim()}”`} />
        )}
      </ScrollArea>
    </SheetDialog>
  );
}

/** A row's combinations: alternatives side by side, or the ends of a range (⌘1 – ⌘9). */
function ShortcutCombos({ row }: { row: ShortcutRow }) {
  const { t } = useLingui();
  const combos = row.range ? [row.combos[0], row.combos[row.combos.length - 1]] : row.combos;
  return (
    <span className="shortcut-combos">
      {combos.map((keys, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              <span className="shortcut-combo-separator" aria-hidden="true">{row.range ? "–" : "/"}</span>
              <span className="sr-only">{row.range ? t`to` : t`or`}</span>
            </>
          )}
          <Keycaps keys={keys} />
        </Fragment>
      ))}
    </span>
  );
}
