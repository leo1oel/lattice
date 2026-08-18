import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Moon, Play, RotateCcw, Settings, Sun } from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "../../src/App.css";
import "./icon-lab.css";
import { BakaiAnimatedIcon, type BakaiIconKind } from "../../src/animated-icons/bakai-icons";
import { ProvidedAnimatedIcon, type ProvidedIconKind } from "../../src/animated-icons/provided-icons";

type IconStudy = {
  id: string;
  kind: BakaiIconKind | ProvidedIconKind;
  source?: "bakai" | "provided";
  converted?: boolean;
  label: string;
  rationale: string;
};

const settingsIcons: IconStudy[] = [
  { id: "appearance", kind: "faders", label: "Appearance", rationale: "Faders cycle through the interface settings." },
  { id: "editor", kind: "logs", label: "Editor & builds", rationale: "Bakai’s original Logs advances the build tail three times." },
  { id: "agent", kind: "robot", label: "Agent", rationale: "Bakai’s original Robot scans and blinks." },
  { id: "mcp", kind: "plugs", label: "MCP", rationale: "The plug halves separate, reconnect, and make contact arcs." },
  { id: "subscriptions", kind: "users", label: "Subscriptions", rationale: "The three linked accounts rotate one place." },
  { id: "overleaf", kind: "cloud-upload", label: "Overleaf", rationale: "Bakai’s original Cloud Upload completes the upload stream." },
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

const conversionIcons: IconStudy[] = [
  { id: "conversion-users", kind: "users", label: "Subscriptions", rationale: "Solid people become transparent figures with a uniform dark graphite contour; Bakai’s original one-place rotation is unchanged." },
  { id: "conversion-checks", kind: "list-checks", label: "Checklist", rationale: "The solid card becomes a transparent field with a dark contour, while the former knockouts become dark checks and rules; Bakai’s list progression is unchanged." },
  { id: "conversion-logs", kind: "logs", label: "Logs", rationale: "The clipboard, tab, and scrolling rows become a transparent 16-unit outline system without changing Bakai’s tail animation." },
  { id: "conversion-robot", kind: "robot", label: "Robot", rationale: "The robot shell becomes transparent; its former eye and grille knockouts become dark foreground details." },
  { id: "conversion-cloud", kind: "cloud-upload", label: "Cloud upload", rationale: "The cloud becomes a transparent contour and the knockout arrow becomes a clipped dark upload arrow." },
  { id: "conversion-chat", kind: "chat", label: "Chat", rationale: "The bubble becomes a transparent contour and its typing knockouts become dark dots, preserving Bakai’s pop sequence." },
];

const toolbarIcons: IconStudy[] = [
  { id: "toolbar-comments", kind: "chat", converted: true, label: "Editor comments", rationale: "Converted Bakai Chat: the transparent bubble pops back while three dark typing dots arrive left to right." },
  { id: "toolbar-collaboration", source: "provided", kind: "radio", label: "Live collaboration", rationale: "The selected Radio implementation fades both signal bands out, then restores inner and outer bands with staggered springs." },
  { id: "toolbar-overleaf", source: "provided", kind: "cloud-upload-outline", label: "Editing live with Overleaf", rationale: "The selected Cloud Upload implementation lifts the arrow two pixels, then returns it to the static cloud." },
  { id: "toolbar-git", kind: "git-branch", label: "Git status", rationale: "Bakai Git Branch retracts into its head and rewrites the graph." },
  { id: "toolbar-history", kind: "clock-back", label: "Project history", rationale: "Bakai Clock Back winds one hour into the past and releases back to now." },
];

const allIcons = [...conversionIcons, ...settingsIcons, ...toolbarIcons, ...productIcons];

function LabIcon({ item, ...props }: { item: IconStudy; size?: number; playing?: boolean; reducedMotion?: boolean; speed?: "normal" | "slow"; playId?: number; converted?: boolean }) {
  if (item.source === "provided") return <ProvidedAnimatedIcon kind={item.kind as ProvidedIconKind} {...props} />;
  const converted = props.converted ?? item.converted;
  return <BakaiAnimatedIcon kind={item.kind as BakaiIconKind} {...props} converted={converted} />;
}

function ConversionCard(props: { item: IconStudy; playId: number; replay: () => void; reducedMotion: boolean; speed: "normal" | "slow" }) {
  return (
    <article className="conversion-card" tabIndex={0} onPointerEnter={props.replay} onFocus={(event) => { if (event.currentTarget === event.target) props.replay(); }}>
      <div className="card-heading">
        <div><h2>{props.item.label}</h2><span className="reference-badge converted">Converted study</span></div>
        <button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button>
      </div>
      <div className="conversion-comparison">
        <div><span className="conversion-label">Bakai original</span><LabIcon item={props.item} size={52} converted={false} /></div>
        <div className="converted-surface"><span className="conversion-label">Converted still · transparent</span><LabIcon item={props.item} size={52} converted /></div>
        <div className="converted-surface"><span className="conversion-label">Converted animation · transparent</span><LabIcon key={props.playId} item={props.item} size={52} converted playing playId={props.playId} speed={props.speed} reducedMotion={props.reducedMotion} /></div>
      </div>
      <p>{props.item.rationale}</p>
    </article>
  );
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
        <div><LabIcon item={item} size={18} /><h2>{item.label}</h2><span className={`reference-badge ${item.converted ? "converted" : ""}`}>{item.source === "provided" ? "Selected implementation" : item.converted ? "Converted Bakai" : "Bakai original"}</span></div>
        <button type="button" onClick={props.replay}><RotateCcw size={13} /> Replay</button>
      </div>
      <div className="comparison">
        <div><span>Static</span><div className="size-row">{[16, 20, 24].map((size) => <LabIcon key={size} item={item} size={size} />)}</div></div>
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

    <div className="collection-heading conversion-heading"><div className="eyebrow">Conversion proofs</div><h2>Uniform outline + transparent interior</h2><p>The original Bakai component and animation remain the source of truth. Only fill, contour, and knockout rendering are translated.</p></div>
    <section className="conversion-grid" aria-label="Converted icon proofs">
      {conversionIcons.map((item) => <ConversionCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <div className="collection-heading"><div className="eyebrow">Settings navigation</div><h2>First eight</h2></div>
    <section className="lab-grid" aria-label="Settings icon comparisons">
      {settingsIcons.map((item) => <IconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <div className="collection-heading toolbar-heading"><div className="eyebrow">Selected product actions</div><h2>Toolbar replacements</h2><p>Only the five explicitly selected toolbar tools are in scope; all other product icons remain unchanged.</p></div>
    <section className="lab-grid" aria-label="Selected toolbar icon comparisons">
      {toolbarIcons.map((item) => <IconCard key={item.id} item={item} playId={plays[item.id]} replay={() => replay(item.id)} reducedMotion={reducedMotion} speed={speed} />)}
    </section>

    <section className="toolbar-context-section">
      <div className="section-copy"><div className="eyebrow">In context</div><h2>Selected toolbar density</h2><p>Five selected tools at the product’s real 14px icon / 28px target density.</p></div>
      <div className="toolbar-preview">
        <div className="toolbar-preview-tab"><span>paper.tex</span><i /></div>
        <div className="toolbar-preview-switcher"><b>source</b><span>split</span><span>pdf</span></div>
        <div className="toolbar-preview-actions">
          {toolbarIcons.map((item) => <button key={item.id} type="button" title={item.label} aria-label={item.label} onPointerEnter={() => replay(item.id)} onFocus={() => replay(item.id)} onClick={() => replay(item.id)}><LabIcon key={plays[item.id]} item={item} size={14} playing playId={plays[item.id]} speed={speed} reducedMotion={reducedMotion} /></button>)}
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

    <footer>Bakai cards: <a href="https://www.bakai.me/lab/animating-icons" target="_blank" rel="noreferrer">Bakai Tolondu uulu, “Animating icons”</a>, used under the author’s express copy/use permission · Radio and outline Cloud Upload: user-selected supplied implementations · Converted studies change rendering only · No infinite loops</footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<IconLab />);
