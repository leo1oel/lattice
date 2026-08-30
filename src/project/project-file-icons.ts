import type { FileTreeIconConfig, RemappedIcon } from "@pierre/trees";

// Adapted from Material Icon Theme's MIT-licensed PDF, TeX, bibliography,
// and BibTeX style icons. See THIRD_PARTY_NOTICES.md.
const MATERIAL_ICON_SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">
  <symbol id="lattice-material-pdf" viewBox="0 0 24 24">
    <path fill="#ef5350" d="M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z"/>
  </symbol>
  <symbol id="lattice-material-tex" viewBox="0 0 1024 1024">
    <path fill="#2196f3" d="M80 192 64 320h32c16-80 16-96 63.242-96H176c8.837 0 16 7.163 16 16v352c0 8.837 0 16-32 16h-32v32h192v-32h-32c-32 0-32-7.163-32-16V240c0-8.837 7.163-16 16-16h16c48 0 48 16 64 96h32l-16-128zm560 0v32c16 0 45.713 0 52.57 16L776 434.666 708.57 592c-6.857 16-52.57 16-68.57 16v32h128v-32s-34.285 0-27.428-16L792 472l51.428 120c3.103 7.24-1.52 16-11.428 16v32h128v-32c-16 0-45.713 0-52.57-16L824 397.334 891.43 240c6.857-16 52.57-16 68.57-16v-32H832v32s34.285 0 27.428 16L808 360l-51.428-120c-3.103-7.24 1.52-16 11.428-16v-32zM320 384v32h32c32 0 32 7.163 32 16v352c0 8.837 0 16-32 16h-32v32h304l16-128h-32c-16 80-16 96-64 96h-64c-32 0-32-7.163-32-16V624h80c8.837 0 16 0 16 32v16h32V544h-32v16c0 32-7.163 32-16 32h-80V432c0-8.837 0-16 32-16h64c48 0 48 16 64 96h32l-16-128z"/>
  </symbol>
  <symbol id="lattice-material-tex-style" viewBox="0 0 1024 1024">
    <path fill="#b388ff" d="M80 192 64 320h32c16-80 16-96 63.242-96H176c8.837 0 16 7.163 16 16v352c0 8.837 0 16-32 16h-32v32h192v-32h-32c-32 0-32-7.163-32-16V240c0-8.837 7.163-16 16-16h16c48 0 48 16 64 96h32l-16-128zm560 0v32c16 0 45.713 0 52.57 16L776 434.666 708.57 592c-6.857 16-52.57 16-68.57 16v32h128v-32s-34.285 0-27.428-16L792 472l51.428 120c3.103 7.24-1.52 16-11.428 16v32h128v-32c-16 0-45.713 0-52.57-16L824 397.334 891.43 240c6.857-16 52.57-16 68.57-16v-32H832v32s34.285 0 27.428 16L808 360l-51.428-120c-3.103-7.24 1.52-16 11.428-16v-32zM320 384v32h32c32 0 32 7.163 32 16v352c0 8.837 0 16-32 16h-32v32h304l16-128h-32c-16 80-16 96-64 96h-64c-32 0-32-7.163-32-16V624h80c8.837 0 16 0 16 32v16h32V544h-32v16c0 32-7.163 32-16 32h-80V432c0-8.837 0-16 32-16h64c48 0 48 16 64 96h32l-16-128z"/>
  </symbol>
  <symbol id="lattice-material-bibliography" viewBox="0 0 1024 1024">
    <path fill="#795548" d="M96 832h832c17.728 0 32 14.272 32 32v64c0 17.728-14.272 32-32 32H96c-17.728 0-32-14.272-32-32v-64c0-17.728 14.272-32 32-32"/>
    <path fill="#4caf50" d="M160 192h64c17.728 0 32 14.272 32 32v512c0 17.728-14.272 32-32 32h-64c-17.728 0-32-14.272-32-32V224c0-17.728 14.272-32 32-32"/>
    <path fill="#f44336" d="M512 96c0-17.728-14.272-32-32-32H352c-17.728 0-32 14.272-32 32v640c0 17.728 14.272 32 32 32h128c17.728 0 32-14.272 32-32z"/>
    <path fill="#2196f3" d="m530.161 158.902 57.333-27.693a31.804 31.804 0 0 1 42.634 14.936l262.693 548.17c7.66 15.984.977 35.057-14.982 42.766l-57.333 27.693a31.804 31.804 0 0 1-42.634-14.936L515.18 201.668c-7.66-15.983-.977-35.057 14.982-42.766z"/>
    <path fill="#ffeb3b" d="M320 192v64h192v-64zm0 384v64h192v-64z"/>
  </symbol>
  <symbol id="lattice-material-bibtex-style" viewBox="0 0 1024 1024">
    <path fill="#795548" d="M96 832h832c17.728 0 32 14.272 32 32v64c0 17.728-14.272 32-32 32H96c-17.728 0-32-14.272-32-32v-64c0-17.728 14.272-32 32-32"/>
    <path fill="#4caf50" d="M160 192h64c17.728 0 32 14.272 32 32v512c0 17.728-14.272 32-32 32h-64c-17.728 0-32-14.272-32-32V224c0-17.728 14.272-32 32-32"/>
    <path fill="#f44336" d="M512 96c0-17.728-14.272-32-32-32H352c-17.728 0-32 14.272-32 32v640c0 17.728 14.272 32 32 32h128c17.728 0 32-14.272 32-32z"/>
    <path fill="#ffeb3b" d="M320 192v64h192v-64zm0 384v64h192v-64z"/>
    <path fill="#bbdefb" d="M608 320h256c17.728 0 32 14.272 32 32v384c0 17.728-14.272 32-32 32H608c-17.728 0-32-14.272-32-32V352c0-17.728 14.272-32 32-32"/>
    <path fill="#2196f3" d="M608 320c-17.673 0-32 14.327-32 32v352c35.346 0 64-28.654 64-64v-32a32 32 0 0 1 32-32c17.673 0 32-14.327 32-32v-64a32 32 0 0 1 32-32c17.673 0 32-14.327 32-32v-96z"/>
    <path d="M745.606 339.205 924.74 473.693a15.965 15.965 0 0 1 3.19 22.401 15.965 15.965 0 0 1-22.403 3.19l-179.133-134.49a15.965 15.965 0 0 1-3.19-22.401 15.965 15.965 0 0 1 22.402-3.19z"/>
  </symbol>
  <symbol id="lattice-material-board" viewBox="0 0 24 24">
    <path fill="#26a69a" d="M20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.37-.39-1.02-.39-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>
  </symbol>
  <symbol id="lattice-material-spreadsheet" viewBox="0 0 24 24">
    <path fill="#43a047" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m0 4v3h4V7zm6 0v3h8V7zm-6 5v3h4v-3zm6 0v3h8v-3zm-6 5v2h4v-2zm6 0v2h8v-2z"/>
  </symbol>
  <symbol id="lattice-material-presentation" viewBox="0 0 24 24">
    <path fill="#7e57c2" d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-6l3 3h-2.8L12 18.8 9.8 21H7l3-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2"/>
    <path fill="#fff" d="M6 7h7v2H6zm0 4h12v2H6z" opacity=".9"/>
  </symbol>
</svg>`;

const PDF_ICON: RemappedIcon = { name: "lattice-material-pdf", viewBox: "0 0 24 24" };
const TEX_ICON: RemappedIcon = { name: "lattice-material-tex", viewBox: "0 0 1024 1024" };
const TEX_STYLE_ICON: RemappedIcon = { name: "lattice-material-tex-style", viewBox: "0 0 1024 1024" };
const BIBLIOGRAPHY_ICON: RemappedIcon = { name: "lattice-material-bibliography", viewBox: "0 0 1024 1024" };
const BIBTEX_STYLE_ICON: RemappedIcon = { name: "lattice-material-bibtex-style", viewBox: "0 0 1024 1024" };
// Material Icons (Apache-2.0) edit/pencil glyph, recolored.
const BOARD_ICON: RemappedIcon = { name: "lattice-material-board", viewBox: "0 0 24 24" };
const SPREADSHEET_ICON: RemappedIcon = { name: "lattice-material-spreadsheet", viewBox: "0 0 24 24" };
const PRESENTATION_ICON: RemappedIcon = { name: "lattice-material-presentation", viewBox: "0 0 24 24" };

export const PROJECT_FILE_TREE_ICONS: FileTreeIconConfig = {
  set: "complete",
  spriteSheet: MATERIAL_ICON_SPRITE,
  byFileName: {
    "index.tsx": PRESENTATION_ICON,
  },
  byFileExtension: {
    pdf: PDF_ICON,
    tex: TEX_ICON,
    ltx: TEX_ICON,
    cls: TEX_ICON,
    clo: TEX_ICON,
    latex: TEX_ICON,
    aux: TEX_ICON,
    tikz: TEX_ICON,
    synctex: TEX_ICON,
    "synctex.gz": TEX_ICON,
    dtx: TEX_ICON,
    ins: TEX_ICON,
    sty: TEX_STYLE_ICON,
    "sty.txt": TEX_STYLE_ICON,
    bib: BIBLIOGRAPHY_ICON,
    bbl: BIBLIOGRAPHY_ICON,
    bcf: BIBLIOGRAPHY_ICON,
    blg: BIBLIOGRAPHY_ICON,
    bst: BIBTEX_STYLE_ICON,
    bbx: BIBTEX_STYLE_ICON,
    cbx: BIBTEX_STYLE_ICON,
    lbx: BIBTEX_STYLE_ICON,
    eps: "file-tree-builtin-image",
    tldr: BOARD_ICON,
    "lattice-sheet": SPREADSHEET_ICON,
  },
};
