import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Moon, Play, RotateCcw, Settings, Sun } from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "../App.css";
import "./icon-lab.css";
import { AnimatedIcon, type AnimatedIconKind } from "./settings-icon";
import { BakaiAnimatedIcon, type BakaiIconKind } from "./bakai-icons";

type IconStudy = { id: string; kind: AnimatedIconKind; label: string; rationale: string; reference?: boolean };
type ProductIconStudy = { id: string; kind: BakaiIconKind; label: string; rationale: string };

const settingsIcons: IconStudy[] = [
  { id: "appearance", kind: "appearance", label: "Appearance", rationale: "The sun brightens once; only its rays turn, then align exactly." },
  { id: "editor", kind: "editor", label: "Editor & builds", rationale: "Code brackets draw in the document—the smallest honest editing gesture." },
  { id: "agent", kind: "agent", label: "Agent", rationale: "The bot checks in with one antenna nod and a single blink." },
  { id: "mcp", kind: "mcp", label: "MCP", rationale: "The connector seats once and the bolt acknowledges a live tool link." },
  { id: "subscriptions", kind: "subscriptions", label: "Subscriptions", rationale: "One restrained card swipe suggests billing without inventing activity." },
  { id: "overleaf", kind: "overleaf", label: "Overleaf", rationale: "The leaf flexes once while its central vein traces collaboration growth." },
  { id: "api", kind: "api", label: "API keys", rationale: "The key turns once as if authorizing, then returns to its exact angle.", reference: true },
  { id: "doctor", kind: "doctor", label: "TeX doctor", rationale: "The stethoscope chestpiece gives one diagnostic pulse; the tubing stays still." },
];

const productIcons: ProductIconStudy[] = [
  { id: "faders", kind: "faders", label: "Faders", rationale: "The three knobs cycle through settings." },
  { id: "users", kind: "users", label: "Users three", rationale: "The three people rotate one place." },
  { id: "list-checks", kind: "list-checks", label: "List checks", rationale: "The done row exits, the list closes, and a new row writes and ticks." },
  { id: "kanban", kind: "kanban", label: "Kanban", rationale: "Two cards swap and hold their swapped places during the gesture, then the lab replay contract restores the original." },
  { id: "folder", kind: "folder", label: "Folder", rationale: "The folder opens and shuts." },
  { id: "gear", kind: "gear", label: "Gear", rationale: "The gear ticks three times." },
  { id: "chat", kind: "chat", label: "Chat", rationale: "The bubble pops while the dots type." },
  { id: "trash", kind: "trash", label: "Trash", rationale: "The lid opens and trash tumbles in." },
  { id: "cloud-upload", kind: "cloud-upload", label: "Cloud upload", rationale: "The arrow uploads through the cloud." },
  { id: "product-api", kind: "api-key", label: "API key", rationale: "The key levels, tumbles, and is caught." },
  { id: "git-branch", kind: "git-branch", label: "Git branch", rationale: "The branch erases into its head and rewrites." },
  { id: "plugs", kind: "plugs", label: "Plugs", rationale: "The plug halves separate, reconnect, and make contact arcs." },
  { id: "logs", kind: "logs", label: "Logs", rationale: "The log lines step up three times." },
  { id: "robot", kind: "robot", label: "Robot", rationale: "The robot’s eyes scan and blink." },
  { id: "sparkle", kind: "sparkle", label: "Sparkle", rationale: "The sparkle gathers and blooms through a half turn." },
];

const allIcons = [...settingsIcons, ...productIcons];

export function IconCard(props: {
  item: IconStudy;
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
        <div><AnimatedIcon kind={item.kind} size={18} /><h2>{item.label}</h2>{item.reference && <span className="reference-badge" title="Gesture described in Bakai’s “Animating icons” article">Bakai gesture</span>}</div>
        <button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button>
      </div>
      <div className="comparison">
        <div><span>Original</span><div className="size-row">{[16, 20, 24].map((size) => <AnimatedIcon key={size} kind={item.kind} size={size} />)}</div></div>
        <div><span>Animated</span><div className="size-row">{[16, 20, 24].map((size) => <AnimatedIcon key={`${props.playId}-${size}`} kind={item.kind} size={size} playing reducedMotion={props.reducedMotion} speed={props.speed} playId={props.playId} />)}</div></div>
      </div>
      <p>{item.rationale}</p>
    </article>
  );
}

function ProductIconCard(props: { item: ProductIconStudy; playId: number; replay: () => void; reducedMotion: boolean; speed: "normal" | "slow" }) {
  const { item } = props;
  return <article className="lab-card" tabIndex={0} onPointerEnter={props.replay} onFocus={(event) => { if (event.currentTarget === event.target) props.replay(); }} aria-label={`${item.label} icon comparison`}>
    <div className="card-heading"><div><BakaiAnimatedIcon kind={item.kind} size={18} /><h2>{item.label}</h2><span className="reference-badge">Bakai original</span></div><button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button></div>
    <div className="comparison"><div><span>Original</span><div className="size-row">{[16, 20, 24].map((size) => <BakaiAnimatedIcon key={size} kind={item.kind} size={size} />)}</div></div><div><span>Animated</span><div className="size-row">{[16, 20, 24].map((size) => <BakaiAnimatedIcon key={`${props.playId}-${size}`} kind={item.kind} size={size} playing reducedMotion={props.reducedMotion} speed={props.speed} playId={props.playId} />)}</div></div></div>
    <p>{item.rationale}</p>
  </article>;
}

export function IconLab() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [speed, setSpeed] = useState<"normal" | "slow">("normal");
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [plays, setPlays] = useState<Record<string, number>>(() => Object.fromEntries(allIcons.map(({ id }) => [id, 1])));

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const replay = (id: string) => setPlays((current) => ({ ...current, [id]: current[id] + 1 }));
  const replayAll = () => setPlays((current) => Object.fromEntries(allIcons.map(({ id }) => [id, current[id] + 1])));

  return <main className="icon-lab-page">
    <header className="lab-header">
      <div className="eyebrow">Lattice interface study · 02</div>
      <div className="header-row">
        <div><h1>Animated product icons</h1><p>Settings and existing product actions. One semantic gesture, one play, original glyph as the final frame.</p></div>
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

    <div className="collection-heading"><div className="eyebrow">Settings navigation</div><h2>First eight</h2></div>
    <section className="lab-grid" aria-label="Settings icon comparisons">
      {settingsIcons.map((item) => <IconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <div className="collection-heading product-heading"><div className="eyebrow">Existing product language</div><h2>Next fifteen</h2><p>Author-source originals directly ported from Bakai Tolondu uulu’s copy-code gallery.</p></div>
    <section className="lab-grid" aria-label="Product icon comparisons">
      {productIcons.map((item) => <ProductIconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <section className="context-section">
      <div className="section-copy"><div className="eyebrow">In context</div><h2>Settings sidebar density</h2><p>20px review icons shown at the proposed 160px navigation width. This mock is isolated from the product Settings implementation.</p></div>
      <div className="settings-preview">
        <div className="preview-title"><div><Settings size={16} /><b>Settings</b></div><span>×</span></div>
        <div className="preview-body">
          <nav>{settingsIcons.map((item, index) => <button key={item.id} className={index === 0 ? "active" : ""} onPointerEnter={() => replay(item.id)} onFocus={() => replay(item.id)}><AnimatedIcon key={plays[item.id]} kind={item.kind} size={16} playing playId={plays[item.id]} speed={speed} reducedMotion={reducedMotion} /><span>{item.label}</span></button>)}</nav>
          <div className="preview-content"><h3>Appearance</h3><p>These preferences apply across every project on this Mac.</p><div className="fake-field"><span>Color theme</span><i>System</i></div><div className="fake-field"><span>Interface font</span><i>DM Sans</i></div></div>
        </div>
      </div>
    </section>

    <footer>Settings bases: ISC-licensed Lucide · Product glyphs and animations: <a href="https://www.bakai.me/lab/animating-icons" target="_blank" rel="noreferrer">Bakai Tolondu uulu, “Animating icons”</a> · Used under the author’s express copy/use permission · No infinite loops</footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<IconLab />);
