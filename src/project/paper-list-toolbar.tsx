import { useLingui } from "@lingui/react/macro";
import { ArrowDownUp, Check, ListFilter, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { ListTool } from "../components/ui/list-tool";
import { formatCount } from "../i18n";
import type { PaperFilter, PaperGroup, PaperSort } from "./paper-library-view";

/**
 * Above the Papers list: how many papers it shows, and the menus that filter,
 * sort and group them, with the active filter as a chip that clears it.
 */
export function PaperListToolbar({ shown: shownCount, total, filter: shownFilter, onFilter: setFilter, filterCounts, usesKnown, sort, onSort: setSort, group, onGroup: setGroup }: {
  /** Papers the list shows, after the search and the filter. */
  shown: number;
  total: number;
  filter: PaperFilter;
  onFilter: (filter: PaperFilter) => void;
  /** Each filter's count over the whole library. */
  filterCounts: Record<PaperFilter, number>;
  /** Whether the manuscript's citations have been scanned, which the cited filters and sort need. */
  usesKnown: boolean;
  sort: PaperSort;
  onSort: (sort: PaperSort) => void;
  group: PaperGroup;
  onGroup: (group: PaperGroup) => void;
}) {
  const { t } = useLingui();
  const sortLabels: Record<PaperSort, string> = {
    title: t`Title`, year: t`Newest first`, author: t`First author`, venue: t`Venue`, cited: t`Most cited here`,
  };
  const filterLabels: Record<PaperFilter, string> = {
    all: t`All papers`,
    cited: t`Cited in this paper`,
    uncited: t`Not cited yet`,
    fullText: t`With full text`,
    flagged: t`Flagged`,
  };
  const groupLabels: Record<PaperGroup, string> = { none: t`No grouping`, year: t`Year`, venue: t`Venue`, state: t`Reading state` };
  const sortOn = sort !== "title" || group !== "none";
  const shown = formatCount(shownCount);
  const totalText = formatCount(total);
  return (
    <>
    {/* How many papers the list holds, and how it is narrowed, ordered
        and grouped. The count stands for what is shown, so a search or a
        filter reads as "3 of 7", and "3/7" where that does not fit. A
        narrow panel keeps the two tools as icons, each with a dot once
        it is set; an active filter is also a chip that clears it. */}
    <div className="paper-list-toolbar">
        <p className="paper-list-count">
          <span className="paper-count-long">
            {shownCount !== total
              ? shownCount === 1
                ? t({ message: `1 of ${{ total: totalText }} papers` })
                : t({ message: `${{ filtered: shown }} of ${{ total: totalText }} papers` })
              : total === 1
                ? t`1 paper`
                : t({ message: `${{ count: totalText }} papers` })}
          </span>
          <span className="paper-count-short" aria-hidden="true">
            {shownCount !== total ? `${shown}/${totalText}` : totalText}
          </span>
        </p>
        {/* Not modal, as the app's other menus are: a modal menu hides the
            whole window from assistive tech and locks its scrolling as it
            opens, which in WebKit held the menu back by about 50ms. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            {/* The filter's name is the chip under the toolbar, which clears it. */}
            <ListTool
              icon={<ListFilter size={14} aria-hidden="true" />}
              label={t`Filter`}
              on={shownFilter !== "all"}
              name={shownFilter === "all" ? t`Filter papers` : t({ message: `Filter papers: ${{ filter: filterLabels[shownFilter] }}` })}
              title={t`Filter papers`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="paper-menu">
            {(Object.keys(filterLabels) as PaperFilter[]).map((value) => (
              <DropdownMenuItem
                key={value}
                role="menuitemradio"
                aria-checked={shownFilter === value}
                disabled={!usesKnown && (value === "cited" || value === "uncited")}
                onSelect={() => setFilter(value)}
              >
                <span className="paper-menu-check">{shownFilter === value && <Check size={14} />}</span>
                <span className="paper-menu-label">{filterLabels[value]}</span>
                <span className="paper-menu-count">{formatCount(filterCounts[value])}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <ListTool
              icon={<ArrowDownUp size={14} aria-hidden="true" />}
              label={group !== "none" ? t`Group` : t`Sort`}
              value={group !== "none" ? groupLabels[group] : sortLabels[sort]}
              on={sortOn}
              name={t({ message: `Sort and group: ${{ order: group !== "none" ? groupLabels[group] : sortLabels[sort] }}` })}
              title={t`Sort and group`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="paper-menu">
            <DropdownMenuLabel>{t`Group by`}</DropdownMenuLabel>
            {(Object.keys(groupLabels) as PaperGroup[]).map((value) => (
              <DropdownMenuItem key={value} role="menuitemradio" aria-checked={group === value} onSelect={() => setGroup(value)}>
                <span className="paper-menu-check">{group === value && <Check size={14} />}</span>
                <span className="paper-menu-label">{groupLabels[value]}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t`Sort by`}</DropdownMenuLabel>
            {(Object.keys(sortLabels) as PaperSort[]).map((value) => (
              <DropdownMenuItem
                key={value}
                role="menuitemradio"
                aria-checked={sort === value}
                disabled={!usesKnown && value === "cited"}
                onSelect={() => setSort(value)}
              >
                <span className="paper-menu-check">{sort === value && <Check size={14} />}</span>
                <span className="paper-menu-label">{sortLabels[value]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    {shownFilter !== "all" && (
      <div className="paper-chips">
        <button
          type="button"
          className="paper-chip"
          title={t`Clear filter`}
          aria-label={t({ message: `Clear filter: ${{ filter: filterLabels[shownFilter] }}` })}
          onClick={() => setFilter("all")}
        >
          <span>{filterLabels[shownFilter]}</span>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    )}
    </>
  );
}
