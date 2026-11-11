/**
 * A .tex file's Source / Visual switch in its panel header: how its editor
 * draws it (latex-view-choice.ts). Only the active document's is live;
 * another tab's keeps its room, inert, as the view modes do (see
 * trellis-header-tools.tsx).
 *
 * Memoized: the header beside it renders again with each step of a build,
 * and the switch has nothing to draw for those.
 */
import { memo, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CodeXml, Type } from "lucide-react";
import { SegmentedControl } from "../components/ui/segmented-control";
import { chooseLatexView, useLatexView, type LatexView } from "../editor/latex/latex-view-choice";

export const LatexViewSwitch = memo(function LatexViewSwitch({ active, reserve }: {
  active: boolean;
  /** Wraps the switch when it only holds its place (the header's inert reserve). */
  reserve: (children: ReactNode) => ReactNode;
}) {
  const { t } = useLingui();
  const view = useLatexView();
  const sourceName = t({ context: "LaTeX editor view", message: "Source" });
  const visualName = t({ context: "LaTeX editor view", message: "Visual" });
  const items = [
    { value: "source" as const, label: <><CodeXml size={14} /><span className="trellis-mode-name">{sourceName}</span></>, title: sourceName },
    { value: "visual" as const, label: <><Type size={14} /><span className="trellis-mode-name">{visualName}</span></>, title: visualName },
  ];
  if (!active) return reserve(<SegmentedControl<LatexView> value="source" onChange={() => {}} ariaLabel="" className="trellis-view-switcher" items={items} />);
  return <SegmentedControl<LatexView> value={view} onChange={chooseLatexView} ariaLabel={t`LaTeX editor view`} className="trellis-view-switcher" items={items} />;
});
