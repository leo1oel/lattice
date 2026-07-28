import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Moon, Play, RotateCcw, Settings, Sun } from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "../App.css";
import "./icon-lab.css";
import { BakaiAnimatedIcon, type BakaiIconKind } from "./bakai-icons";
import { LatticeAnimatedIcon, type LatticeIconKind } from "./lattice-icons";

type IconStudy = {
  id: string;
  kind: BakaiIconKind | LatticeIconKind;
  source?: "lattice";
  label: string;
  rationale: string;
};

const settingsIcons: IconStudy[] = [
  { id: "appearance", kind: "faders", label: "Appearance", rationale: "Faders cycle through the interface settings." },
  { id: "editor", kind: "list-checks", label: "Editor & builds", rationale: "A completed row exits and a newly built row writes and ticks." },
  { id: "agent", kind: "robot", label: "Agent", rationale: "The robot’s eyes scan and blink." },
  { id: "mcp", kind: "plugs", label: "MCP", rationale: "The plug halves separate, reconnect, and make contact arcs." },
  { id: "subscriptions", kind: "users", label: "Subscriptions", rationale: "The three linked accounts rotate one place." },
  { id: "overleaf", kind: "cloud-upload", label: "Overleaf", rationale: "The arrow uploads through the cloud." },
  { id: "api", kind: "api-key", label: "API keys", rationale: "The key levels, tumbles, and is caught." },
  { id: "doctor", kind: "sparkle", label: "TeX doctor", rationale: "The diagnostic result gathers and blooms cleanly." },
];

const productIcons: IconStudy[] = [
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

const toolbarIcons: IconStudy[] = [
  { id: "toolbar-comments", kind: "editor-comments", source: "lattice", label: "Editor comments", rationale: "The current MessageSquareText shell stays still while three comment rows advance through one complete feed cycle." },
  { id: "toolbar-collaboration", kind: "live-collaboration", source: "lattice", label: "Live collaboration", rationale: "A center presence ping reaches the inner and outer radio signals once; opposing micro-tilts keep the broadcast alive without becoming a shake loop." },
  { id: "toolbar-overleaf-live", kind: "cloud-upload", label: "Editing live with Overleaf", rationale: "Bakai’s upload arrow exits through the cloud, re-enters from below, and settles exactly in its starting cutout." },
  { id: "toolbar-overleaf-chat", kind: "overleaf-messages", source: "lattice", label: "Overleaf comments & chat", rationale: "The existing MessagesSquare pair parts slightly to make room for one staggered typing reply, then closes back to the untouched glyph." },
  { id: "toolbar-git", kind: "git-branch", label: "Git status", rationale: "Bakai’s branch retracts into its head, then redraws trunk, ring, branch, and commit in a truthful graph-writing order." },
  { id: "toolbar-history", kind: "clock-back", label: "Project history", rationale: "Bakai’s Clock Back winds one hour into the past with true 12:1 hand gearing, pauses, then releases precisely back to now." },
];

const allIcons = [...settingsIcons, ...toolbarIcons, ...productIcons];

function LabIcon({ item, ...props }: { item: IconStudy; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; playId?: number }) {
  return item.source === "lattice"
    ? <LatticeAnimatedIcon kind={item.kind as LatticeIconKind} {...props} />
    : <BakaiAnimatedIcon kind={item.kind as BakaiIconKind} {...props} />;
}

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
        <div><LabIcon item={item} size={18} /><h2>{item.label}</h2><span className={`reference-badge ${item.source === "lattice" ? "lattice" : ""}`}>{item.source === "lattice" ? "Lattice study" : "Bakai original"}</span></div>
        <button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button>
      </div>
      <div className="comparison">
        <div><span>Original</span><div className="size-row">{[16, 20, 24].map((size) => <LabIcon key={size} item={item} size={size} />)}</div></div>
        <div><span>Animated</span><div className="size-row">{[16, 20, 24].map((size) => <LabIcon key={`${props.playId}-${size}`} item={item} size={size} playing reducedMotion={props.reducedMotion} speed={props.speed} playId={props.playId} />)}</div></div>
      </div>
      <p>{item.rationale}</p>
    </article>
  );
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

    <div className="collection-heading toolbar-heading"><div className="eyebrow">Lattice toolbar · real semantics</div><h2>Six action studies</h2><p>Three exact Bakai originals and three Lattice-specific gestures built on the Lucide glyphs already used by the product.</p></div>
    <section className="lab-grid" aria-label="Toolbar icon comparisons">
      {toolbarIcons.map((item) => <IconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <section className="toolbar-context-section">
      <div className="section-copy"><div className="eyebrow">In context</div><h2>Actual toolbar density</h2><p>14px icons inside the product’s real 28px action target. Hover or focus any tool to replay only that gesture.</p></div>
      <div className="toolbar-preview">
        <div className="toolbar-preview-tab"><span>paper.tex</span><i /></div>
        <div className="toolbar-preview-switcher"><b>source</b><span>split</span><span>pdf</span></div>
        <div className="toolbar-preview-actions">
          {toolbarIcons.map((item, index) => (
            <button key={item.id} type="button" className={index === 1 || index === 2 ? "active" : ""} title={item.label} aria-label={item.label} onPointerEnter={() => replay(item.id)} onFocus={() => replay(item.id)} onClick={() => replay(item.id)}>
              <LabIcon key={plays[item.id]} item={item} size={14} playing playId={plays[item.id]} speed={speed} reducedMotion={reducedMotion} />
              {index === 0 || index === 3 ? <em>{index === 0 ? 3 : 2}</em> : null}
              {index === 2 ? <i /> : null}
            </button>
          ))}
        </div>
      </div>
    </section>

    <div className="collection-heading product-heading"><div className="eyebrow">Existing product language</div><h2>Next fifteen</h2><p>Author-source originals directly ported from Bakai Tolondu uulu’s copy-code gallery.</p></div>
    <section className="lab-grid" aria-label="Product icon comparisons">
      {productIcons.map((item) => <IconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <section className="context-section">
      <div className="section-copy"><div className="eyebrow">In context</div><h2>Settings sidebar density</h2><p>20px review icons shown at the proposed 160px navigation width. This mock is isolated from the product Settings implementation.</p></div>
      <div className="settings-preview">
        <div className="preview-title"><div><Settings size={16} /><b>Settings</b></div><span>×</span></div>
        <div className="preview-body">
          <nav>{settingsIcons.map((item, index) => <button key={item.id} className={index === 0 ? "active" : ""} onPointerEnter={() => replay(item.id)} onFocus={() => replay(item.id)}><LabIcon key={plays[item.id]} item={item} size={16} playing playId={plays[item.id]} speed={speed} reducedMotion={reducedMotion} /><span>{item.label}</span></button>)}</nav>
          <div className="preview-content"><h3>Appearance</h3><p>These preferences apply across every project on this Mac.</p><div className="fake-field"><span>Color theme</span><i>System</i></div><div className="fake-field"><span>Interface font</span><i>DM Sans</i></div></div>
        </div>
      </div>
    </section>

    <footer>Bakai-original cards: <a href="https://www.bakai.me/lab/animating-icons" target="_blank" rel="noreferrer">Bakai Tolondu uulu, “Animating icons”</a>, used under the author’s express copy/use permission · Lattice-study cards: Lucide static glyphs under ISC, original animation work · No infinite loops</footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<IconLab />);
