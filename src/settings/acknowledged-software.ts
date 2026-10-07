import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { nodeVersion } from "../../scripts/synara-runtime.json";
import type { ThirdPartyClosure } from "./third-party-notices";

/**
 * The work Settings › About › Acknowledgements names first, before the full
 * list of every package the app ships.
 *
 * Choosing what is prominent is the only hand-kept part. Version and license
 * come from THIRD_PARTY_NOTICES.md through `pkg`, so they move with the
 * lockfiles; `license` is written here only for work the generated notices do
 * not list as a package (adapted code, fonts and icons drawn into the app,
 * hand-staged runtimes), and each such entry matches the hand-written half of
 * that file. `acknowledged-software.test.ts` fails if a `pkg` stops appearing
 * in the notices.
 */
export type Credit = {
  name: string;
  role: MessageDescriptor;
  url?: string;
  /** Wording the work's license requires, shown verbatim after the role. */
  attribution?: string;
  /** The package whose recorded version and license this credit shows. */
  pkg?: { closure: ThirdPartyClosure; name: string };
  /** Overrides the recorded license, for terms a `license` field cannot name. */
  license?: string;
  version?: string;
};

/* eslint-disable lingui/no-unlocalized-strings -- names of works, their licenses and their sites, kept verbatim */
export const CORE_SOFTWARE: readonly Credit[] = [
  { name: "Tauri", role: msg`The desktop app shell`, url: "https://tauri.app", pkg: { closure: "crates", name: "tauri" } },
  { name: "React", role: msg`The interface framework`, url: "https://react.dev", pkg: { closure: "npm", name: "react" } },
  { name: "CodeMirror", role: msg`The source editor`, url: "https://codemirror.net", pkg: { closure: "npm", name: "@codemirror/view" } },
  { name: "Tiptap", role: msg`The rich-text editor`, url: "https://tiptap.dev", pkg: { closure: "npm", name: "@tiptap/core" } },
  { name: "PDF.js", role: msg`The PDF viewer`, url: "https://mozilla.github.io/pdf.js/", pkg: { closure: "npm", name: "pdfjs-dist" } },
  { name: "Synara", role: msg`The agent runtime behind the AI assistant, by T3 Tools Inc. and Emanuele Di Pietro`, url: "https://github.com/Emanuele-web04/synara", license: "MIT" },
  { name: "Node.js", role: msg`Runs the agent runtime`, url: "https://nodejs.org", license: "MIT", version: nodeVersion },
  { name: "Open Slide", role: msg`Powers presentations`, url: "https://github.com/open-slide/open-slide", pkg: { closure: "presentation-runtime", name: "@open-slide/core" } },
  { name: "tldraw", role: msg`The board editor`, url: "https://tldraw.dev", pkg: { closure: "npm", name: "tldraw" }, license: "tldraw license" },
  { name: "Trellis", role: msg`The dockable panel layout`, attribution: "Uses Trellis by DanFessler - github.com/DanFessler/trellis", url: "https://github.com/DanFessler/trellis", pkg: { closure: "npm", name: "@danfessler/trellis" }, license: "Trellis license" },
  { name: "Pierre Trees", role: msg`The project file tree`, url: "https://pierre.computer", pkg: { closure: "npm", name: "@pierre/trees" } },
  { name: "Pierre Diffs", role: msg`Diffs of changes and history`, url: "https://diffs.com", pkg: { closure: "npm", name: "@pierre/diffs" } },
  { name: "Univer", role: msg`The spreadsheet editor`, url: "https://univer.ai", pkg: { closure: "npm", name: "@univerjs/core" } },
  { name: "KaTeX", role: msg`Math previews`, url: "https://katex.org", pkg: { closure: "npm", name: "katex" } },
  { name: "Mermaid", role: msg`Diagrams in Markdown`, url: "https://mermaid.js.org", pkg: { closure: "npm", name: "mermaid" } },
  { name: "Shiki", role: msg`Code highlighting`, url: "https://shiki.style", pkg: { closure: "npm", name: "shiki" } },
  { name: "Harper", role: msg`Grammar checking`, url: "https://writewithharper.com", pkg: { closure: "crates", name: "harper-core" } },
];

/** Type, icons and sound. The Timeless family, when embedded, leads this group on its own row. */
export const DESIGN_CREDITS: readonly Credit[] = [
  { name: "Inter", role: msg`Interface typeface, by Rasmus Andersson`, url: "https://rsms.me/inter/", pkg: { closure: "npm", name: "@fontsource-variable/inter" } },
  { name: "Instrument Serif", role: msg`Display typeface`, url: "https://github.com/Instrument/instrument-serif", pkg: { closure: "npm", name: "@fontsource/instrument-serif" } },
  { name: "Ioskeley Mono", role: msg`Editor typeface, by Ahmed Hatem, built on Iosevka by Renzhi Li`, url: "https://github.com/ahatem/IoskeleyMono", license: "OFL-1.1", version: "2.0.0" },
  { name: "IBM Plex and Shantell Sans", role: msg`Board typefaces`, url: "https://github.com/IBM/plex", license: "OFL-1.1" },
  { name: "Lucide", role: msg`Interface icons`, url: "https://lucide.dev", pkg: { closure: "npm", name: "lucide-react" } },
  { name: "Phosphor Icons", role: msg`Animated interface icons, redrawn from Phosphor glyphs`, url: "https://phosphoricons.com", license: "MIT" },
  { name: "Material Icons", role: msg`The board icon in the file tree`, url: "https://github.com/google/material-design-icons", license: "Apache-2.0" },
  { name: "Material Icon Theme", role: msg`PDF, TeX and bibliography icons in the file tree`, url: "https://github.com/material-extensions/vscode-material-icon-theme", license: "MIT" },
  { name: "Cuelume", role: msg`Interface sounds, by Daniel Belyi`, url: "https://github.com/Danilaa1/cuelume", pkg: { closure: "npm", name: "cuelume" } },
];

/** Work Lattice adapted or began from, which no package list would show. */
export const ORIGIN_CREDITS: readonly Credit[] = [
  { name: "Open Knowledge", role: msg`By Inkeep, the original basis of Lattice's earlier visual Markdown editor. Lattice has since replaced it with its own engine, but the editor began there, and we are grateful.`, url: "https://github.com/inkeep/open-knowledge" },
  { name: "Fluid Functionalism and Lina", role: msg`By Micka Touillaud and Sameer Singh; several interface controls are adapted from them`, url: "https://github.com/mickadesign/fluid-functionalism", license: "MIT" },
  { name: "ICLR, ICML and NeurIPS style files", role: msg`From the official conference author kits, bundled unmodified with their authors' credits` },
];
/* eslint-enable lingui/no-unlocalized-strings */
