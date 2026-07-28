import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Moon, Play, RotateCcw, Settings, Sun } from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "../App.css";
import "./icon-lab.css";
import { SettingsIcon, type SettingsIconKind } from "./settings-icon";

const icons: Array<{ kind: SettingsIconKind; label: string; rationale: string }> = [
  { kind: "appearance", label: "Appearance", rationale: "The sun brightens once; only its rays turn, then align exactly." },
  { kind: "editor", label: "Editor & builds", rationale: "Code brackets draw in the document—the smallest honest editing gesture." },
  { kind: "agent", label: "Agent", rationale: "The bot checks in with one antenna nod and a single blink." },
  { kind: "mcp", label: "MCP", rationale: "The connector seats once and the bolt acknowledges a live tool link." },
  { kind: "subscriptions", label: "Subscriptions", rationale: "One restrained card swipe suggests billing without inventing activity." },
  { kind: "overleaf", label: "Overleaf", rationale: "The leaf flexes once while its central vein traces collaboration growth." },
  { kind: "api", label: "API keys", rationale: "The key turns once as if authorizing, then returns to its exact angle." },
  { kind: "doctor", label: "TeX doctor", rationale: "The stethoscope chestpiece gives one diagnostic pulse; the tubing stays still." },
];

export function IconCard(props: {
  item: (typeof icons)[number];
  playId: number;
  replay: () => void;
  reducedMotion: boolean;
  speed: "normal" | "slow";
}) {
  const { item } = props;
  return (
    <article
      className="lab-card"
      tabIndex={0}
      onPointerEnter={props.replay}
      onFocus={(event) => { if (event.currentTarget === event.target) props.replay(); }}
      aria-label={`${item.label} icon comparison`}
    >
      <div className="card-heading">
        <div><SettingsIcon kind={item.kind} size={18} /><h2>{item.label}</h2></div>
        <button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button>
      </div>
      <div className="comparison">
        <div><span>Original</span><div className="size-row">{[16, 20, 24].map((size) => <SettingsIcon key={size} kind={item.kind} size={size} />)}</div></div>
        <div><span>Animated</span><div className="size-row">{[16, 20, 24].map((size) => <SettingsIcon key={`${props.playId}-${size}`} kind={item.kind} size={size} playing reducedMotion={props.reducedMotion} speed={props.speed} playId={props.playId} />)}</div></div>
      </div>
      <p>{item.rationale}</p>
    </article>
  );
}

export function IconLab() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [speed, setSpeed] = useState<"normal" | "slow">("normal");
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [plays, setPlays] = useState<Record<SettingsIconKind, number>>(() => Object.fromEntries(icons.map(({ kind }) => [kind, 1])) as Record<SettingsIconKind, number>);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const replay = (kind: SettingsIconKind) => setPlays((current) => ({ ...current, [kind]: current[kind] + 1 }));
  const replayAll = () => setPlays((current) => Object.fromEntries(icons.map(({ kind }) => [kind, current[kind] + 1])) as Record<SettingsIconKind, number>);

  return <main className="icon-lab-page">
    <header className="lab-header">
      <div className="eyebrow">Lattice interface study · 01</div>
      <div className="header-row">
        <div><h1>Animated settings icons</h1><p>One semantic gesture. One play. The original glyph is always the final frame.</p></div>
        <button className="primary-action" type="button" onClick={replayAll}><Play size={14} fill="currentColor" /> Replay all</button>
      </div>
      <div className="review-controls" aria-label="Review controls">
        <div className="segmented" aria-label="Theme">
          <button className={theme === "light" ? "selected" : ""} onClick={() => setTheme("light")}><Sun size={13} /> Light</button>
          <button className={theme === "dark" ? "selected" : ""} onClick={() => setTheme("dark")}><Moon size={13} /> Dark</button>
        </div>
        <div className="segmented" aria-label="Animation speed">
          <button className={speed === "normal" ? "selected" : ""} onClick={() => setSpeed("normal")}>Normal</button>
          <button className={speed === "slow" ? "selected" : ""} onClick={() => setSpeed("slow")}>Slow motion</button>
        </div>
        <label className="motion-toggle"><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /><span>Reduced motion</span></label>
      </div>
    </header>

    <section className="lab-grid" aria-label="Icon comparisons">
      {icons.map((item) => <IconCard key={item.kind} item={item} playId={plays[item.kind]} replay={() => replay(item.kind)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <section className="context-section">
      <div className="section-copy"><div className="eyebrow">In context</div><h2>Settings sidebar density</h2><p>20px review icons shown at the proposed 160px navigation width. This mock is isolated from the product Settings implementation.</p></div>
      <div className="settings-preview">
        <div className="preview-title"><div><Settings size={16} /><b>Settings</b></div><span>×</span></div>
        <div className="preview-body">
          <nav>{icons.map((item, index) => <button key={item.kind} className={index === 0 ? "active" : ""} onPointerEnter={() => replay(item.kind)} onFocus={() => replay(item.kind)}><SettingsIcon key={plays[item.kind]} kind={item.kind} size={16} playing playId={plays[item.kind]} speed={speed} reducedMotion={reducedMotion} /><span>{item.label}</span></button>)}</nav>
          <div className="preview-content"><h3>Appearance</h3><p>These preferences apply across every project on this Mac.</p><div className="fake-field"><span>Color theme</span><i>System</i></div><div className="fake-field"><span>Interface font</span><i>DM Sans</i></div></div>
        </div>
      </div>
    </section>

    <footer>Static bases: Lucide icons · Animation: original Lattice SVG/CSS implementation · No infinite loops</footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<IconLab />);
