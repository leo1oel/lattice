/**
 * Project file and folder errors (`src-tauri/src/project/`), in the interface
 * language. See `host-error-text.ts` for how an entry is matched and pinned.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

/** The nouns Rust names an unnamed path by (`file_name` and `display_name` in project/paths.rs). */
function unnamedPath(what: string): string {
  switch (what) {
    case "An imported image": return t`An imported image`;
    case "A dropped file": return t`A dropped file`;
    case "An imported source": return t`An imported source`;
    case "An imported file": return t`An imported file`;
    case "That item": return t`That item`;
    default: return what;
  }
}

/** `Symbol::name` in project/symbols.rs. */
function symbolName(kind: string): string {
  switch (kind) {
    case "label": return t`label`;
    case "citation key": return t`citation key`;
    default: return kind;
  }
}

export const PROJECT_HOST_ERRORS: readonly HostErrorEntry[] = [
  // Paths (project/paths.rs, project_fs.rs)
  ["project/paths.rs", "The requested path is outside the project.", () => t`The requested path is outside the project.`],
  ["project/paths.rs", "That file or folder no longer exists.", () => t`That file or folder no longer exists.`],
  ["project/paths.rs", "Symbolic links cannot be used for project file operations.", () => t`Symbolic links cannot be used for project file operations.`],
  ["project/paths.rs", "A project path component is not a folder.", () => t`A project path component is not a folder.`],
  ["project/paths.rs", "Choose a project-relative path outside .research.", () => t`Choose a project-relative path outside .research.`],
  ["project/paths.rs", "Choose a simple name without folders or a leading dot.", () => t`Choose a simple name without folders or a leading dot.`],
  ["project/paths.rs", "History records cannot edit themselves.", () => t`History records cannot edit themselves.`],
  ["project/paths.rs", "{what} has an invalid file name.", ([what]) => {
    const item = unnamedPath(what);
    return t`${item} has an invalid file name.`;
  }],
  ["project_fs.rs", "Could not allocate a temporary project file.", () => t`Could not allocate a temporary project file.`],
  ["project_fs.rs", "Symbolic links cannot be moved or renamed.", () => t`Symbolic links cannot be moved or renamed.`],
  ["project/manifest.rs", "The selected path is not a folder.", () => t`The selected path is not a folder.`],

  // Creating, moving and deleting (project/entries.rs, project/create.rs)
  ["project/entries.rs", "Choose a source file or folder.", () => t`Choose a source file or folder.`],
  ["project/entries.rs", "A file or folder already exists at that path.", () => t`A file or folder already exists at that path.`],
  ["project/entries.rs", "New source files must use .tex, .bib, .md, .sty, .cls, .txt, .html, .tsx, .ts, .jsx, .js, .tldr, or .lattice-sheet.", () => t`New source files must use .tex, .bib, .md, .sty, .cls, .txt, .html, .tsx, .ts, .jsx, .js, .tldr, or .lattice-sheet.`],
  ["project/entries.rs", "Deck ids must use kebab-case letters and numbers.", () => t`Deck ids must use kebab-case letters and numbers.`],
  ["project/entries.rs", "A slide deck already exists with that id.", () => t`A slide deck already exists with that id.`],
  ["project/entries.rs", "Choose a file or folder to move.", () => t`Choose a file or folder to move.`],
  ["project/entries.rs", "Choose an existing project folder.", () => t`Choose an existing project folder.`],
  ["project/entries.rs", "A folder cannot be moved inside itself.", () => t`A folder cannot be moved inside itself.`],
  ["project/entries.rs", "A file or folder already exists with that name.", () => t`A file or folder already exists with that name.`],
  ["project/entries.rs", "The document being compiled and its bibliography cannot be deleted.", () => t`The document being compiled and its bibliography cannot be deleted.`],
  ["project/create.rs", "Unknown venue “{other}”. Choose neurips, icml, iclr, acl, cvpr, aaai, thuthesis, ustcthesis, blank, or chinese-article.", ([venue]) => t`Unknown venue “${venue}”. Choose neurips, icml, iclr, acl, cvpr, aaai, thuthesis, ustcthesis, blank, or chinese-article.`],
  ["project/create.rs", "Choose a simple project name without path separators.", () => t`Choose a simple project name without path separators.`],
  ["project/create.rs", "That folder already exists and is not empty.", () => t`That folder already exists and is not empty.`],
  ["project/create.rs", "A folder named “{TUTORIAL_PROJECT_NAME}” already exists in Lattice Tutorials. Move it, then try again.", ([name]) => t`A folder named “${name}” already exists in Lattice Tutorials. Move it, then try again.`],

  // Opening files (project/tree.rs, project/assets.rs)
  ["project/tree.rs", "This file is not UTF-8 text, so Lattice cannot open it. Convert it to UTF-8 (for example, re-save it as UTF-8 in another text editor) and open it again.", () => t`This file is not UTF-8 text, so Lattice cannot open it. Convert it to UTF-8 (for example, re-save it as UTF-8 in another text editor) and open it again.`],
  ["project/tree.rs", "This is a binary or unsupported file and cannot be opened in the source editor.", () => t`This is a binary or unsupported file and cannot be opened in the source editor.`],
  ["project/assets.rs", "This PDF changed on disk.", () => t`This PDF changed on disk.`],
  ["project/assets.rs", "Choose a binary project file or an HTML preview resource.", () => t`Choose a binary project file or an HTML preview resource.`],
  ["project/assets.rs", "This file is not a PDF.", () => t`This file is not a PDF.`],
  ["project/assets.rs", "This figure is too large to preview inside Lattice (50 MB maximum).", () => t`This figure is too large to preview inside Lattice (50 MB maximum).`],
  ["project/assets.rs", "This HTML file is too large to open (32 MB maximum).", () => t`This HTML file is too large to open (32 MB maximum).`],
  ["project/assets.rs", "Choose a binary project file.", () => t`Choose a binary project file.`],
  ["project/assets.rs", "Only project PDFs are read in ranges.", () => t`Only project PDFs are read in ranges.`],
  ["project/assets.rs", "This byte range cannot be read.", () => t`This byte range cannot be read.`],
  ["project/assets.rs", "This byte range is outside the file.", () => t`This byte range is outside the file.`],
  ["project/assets.rs", "Only project PDFs are saved as copies.", () => t`Only project PDFs are saved as copies.`],
  ["project/assets.rs", "Choose a file to save the PDF to.", () => t`Choose a file to save the PDF to.`],
  ["project/assets.rs", "Choose an image or PDF from the project.", () => t`Choose an image or PDF from the project.`],
  ["project/assets.rs", "SVG insertion needs rsvg-convert or ImageMagick. The figure can still be previewed in Lattice.", () => t`SVG insertion needs rsvg-convert or ImageMagick. The figure can still be previewed in Lattice.`],
  ["project/assets.rs", "Lattice could not convert this figure for LaTeX.", () => t`Lattice could not convert this figure for LaTeX.`],
  ["project/assets.rs", "Lattice could not convert this figure for LaTeX. {detail}", ([detail]) => t`Lattice could not convert this figure for LaTeX. ${detail}`],

  // Renaming labels and citation keys (project/symbols.rs)
  ["project/symbols.rs", "Enter a {kind} name.", ([kind]) => {
    const name = symbolName(kind);
    return t`Enter a ${name} name.`;
  }],
  ["project/symbols.rs", "Keep the {kind} under 120 characters.", ([kind]) => {
    const name = symbolName(kind);
    return t`Keep the ${name} under 120 characters.`;
  }],
  ["project/symbols.rs", "Use letters, numbers, and :_-.+ in the {kind}.", ([kind]) => {
    const name = symbolName(kind);
    return t`Use letters, numbers, and :_-.+ in the ${name}.`;
  }],
  ["project/symbols.rs", "Choose a different {}.", ([kind]) => {
    const name = symbolName(kind);
    return t`Choose a different ${name}.`;
  }],
  ["project/symbols.rs", "The {} “{new}” already exists.", ([kind, value]) => {
    const name = symbolName(kind);
    return t`The ${name} “${value}” already exists.`;
  }],
  ["project/symbols.rs", "No occurrences of “{old}” were found.", ([old]) => t`No occurrences of “${old}” were found.`],
  ["project/symbols.rs", "Could not rename “{old}” in {path}; the file changed.", ([old, path]) => t`Could not rename “${old}” in ${path}; the file changed.`],
  ["project/symbols.rs", "The rename did not change any files.", () => t`The rename did not change any files.`],

  // Dropping, pasting and importing (project/imports.rs)
  ["project/imports.rs", "Choose a simple image file name.", () => t`Choose a simple image file name.`],
  ["project/imports.rs", "Clipboard images must be saved as PNG, JPEG, or WebP.", () => t`Clipboard images must be saved as PNG, JPEG, or WebP.`],
  ["project/imports.rs", "Could not decode the clipboard image: {error}", ([error]) => t`Could not decode the clipboard image: ${error}`],
  ["project/imports.rs", "The clipboard image was empty.", () => t`The clipboard image was empty.`],
  ["project/imports.rs", "The clipboard data is not a valid image.", () => t`The clipboard data is not a valid image.`],
  ["project/imports.rs", "Drop one or more image files first.", () => t`Drop one or more image files first.`],
  ["project/imports.rs", "Drop images onto a project folder.", () => t`Drop images onto a project folder.`],
  ["project/imports.rs", "{} is not a supported image or PDF file.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is not a supported image or PDF file.`;
  }],
  ["project/imports.rs", "Drop one or more files first.", () => t`Drop one or more files first.`],
  ["project/imports.rs", "{name} is not an image, PDF, or text file the agent can read.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is not an image, PDF, or text file the agent can read.`;
  }],
  ["project/imports.rs", "{name} is larger than the 64 MB limit for agent attachments.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is larger than the 64 MB limit for agent attachments.`;
  }],
  ["project/imports.rs", "Drop one or more source files first.", () => t`Drop one or more source files first.`],
  ["project/imports.rs", "{name} is not a supported source file.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is not a supported source file.`;
  }],
  ["project/imports.rs", "{name} is larger than the 10 MB source-file limit.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is larger than the 10 MB source-file limit.`;
  }],
  ["project/imports.rs", "{file_name} is not a UTF-8 text file.", ([name]) => t`${name} is not a UTF-8 text file.`],
  ["project/imports.rs", "{relative} is already a folder in this project.", ([path]) => t`${path} is already a folder in this project.`],
  ["project/imports.rs", "{relative} is already a file in this project.", ([path]) => t`${path} is already a file in this project.`],
  ["project/imports.rs", "{name} is not a regular file Lattice can import.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is not a regular file Lattice can import.`;
  }],
  ["project/imports.rs", "An imported folder contains an invalid file name.", () => t`An imported folder contains an invalid file name.`],
  ["project/imports.rs", "Drop one or more files or folders first.", () => t`Drop one or more files or folders first.`],
  ["project/imports.rs", "Drop files and folders onto a project folder.", () => t`Drop files and folders onto a project folder.`],
  ["project/imports.rs", "{name} is a symbolic link and cannot be imported.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is a symbolic link and cannot be imported.`;
  }],
  ["project/imports.rs", "{name} is not a regular file or folder Lattice can import.", ([name]) => {
    const item = unnamedPath(name);
    return t`${item} is not a regular file or folder Lattice can import.`;
  }],
  ["project/imports.rs", "A folder cannot be copied inside itself.", () => t`A folder cannot be copied inside itself.`],
  ["project/imports.rs", "Choose a valid project-relative path.", () => t`Choose a valid project-relative path.`],
  ["project/imports.rs", "That path cannot be written directly.", () => t`That path cannot be written directly.`],
  ["project/imports.rs", "Hidden paths outside .research cannot be written.", () => t`Hidden paths outside .research cannot be written.`],
  ["project/imports.rs", "Only project sidecar files can be written under .research.", () => t`Only project sidecar files can be written under .research.`],
  ["project/imports.rs", "Could not decode file bytes: {error}", ([error]) => t`Could not decode file bytes: ${error}`],
  ["project/imports.rs", "Binary files written this way must be 15 MB or smaller.", () => t`Binary files written this way must be 15 MB or smaller.`],
];
