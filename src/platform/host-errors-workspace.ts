/**
 * Workspace errors — history, archives, templates, SyncTeX, the window's
 * project, and the operating system's own — in the interface language. See
 * `host-error-text.ts` for how an entry is matched and pinned.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

/**
 * The `io::Error` text Rust appends to a failed file operation ("Permission
 * denied (os error 13)"), by macOS errno. Other numbers keep their English.
 */
function osErrorText(code: string): string | null {
  switch (code) {
    case "1": return t`The operation is not permitted.`;
    case "2": return t`No such file or folder.`;
    case "13": return t`Permission denied.`;
    case "17": return t`A file with that name already exists.`;
    case "18": return t`Files cannot be moved across disks this way.`;
    case "20": return t`A part of the path is not a folder.`;
    case "21": return t`That is a folder.`;
    case "28": return t`The disk is full.`;
    case "30": return t`The disk is read-only.`;
    case "63": return t`The file name is too long.`;
    case "66": return t`The folder is not empty.`;
    default: return null;
  }
}

/** Entries for text the Rust standard library writes, not Lattice; the catalog test checks them by example instead of by source file. */
export const STD_ERRORS_FILE = "(std::io)";

export const WORKSPACE_HOST_ERRORS: readonly HostErrorEntry[] = [
  [STD_ERRORS_FILE, "{} (os error {})", ([message, code]) => osErrorText(code) ?? `${message} (os error ${code})`],
  // The shapes every module wraps an I/O error in; the path stays as written.
  ["project/index_sources.rs", "Could not read {}: {message}", ([path, error]) => t`Could not read ${path}: ${error}`],
  ["overleaf/files.rs", "Could not write {rel}: {error}", ([path, error]) => t`Could not write ${path}: ${error}`],
  ["overleaf/sync.rs", "Could not delete {path}: {e}", ([path, error]) => t`Could not delete ${path}: ${error}`],

  // The window's project (ipc.rs)
  ["ipc.rs", "Open a project first.", () => t`Open a project first.`],
  // What was about to happen is Rust's English ("the build could start"), so
  // the translation says only that it did not.
  ["ipc.rs", "The project changed before {action}.", () => t`The project changed before the action could start.`],

  // History (project/history.rs)
  ["project/history.rs", "The transaction contains no edits.", () => t`The transaction contains no edits.`],
  ["project/history.rs", "Cannot remove the reference because {relative} changed. Try again.", ([path]) => t`Cannot remove the reference because ${path} changed. Try again.`],
  ["project/history.rs", "Cannot save {path} because it was deleted outside the editor.", ([path]) => t`Cannot save ${path} because it was deleted outside the editor.`],
  ["project/history.rs", "Cannot apply the live update because {path} changed outside live editing.", ([path]) => t`Cannot apply the live update because ${path} changed outside live editing.`],
  ["project/history.rs", "Cannot apply the change because {} changed. Try again.", ([path]) => t`Cannot apply the change because ${path} changed. Try again.`],
  ["project/history.rs", "That file is not part of this history entry.", () => t`That file is not part of this history entry.`],
  ["project/history.rs", "Cannot restore {} because it changed after this history entry. Review the newer changes first.", ([path]) => t`Cannot restore ${path} because it changed after this history entry. Review the newer changes first.`],
  ["project/history.rs", "The selected files are already at the requested state.", () => t`The selected files are already at the requested state.`],
  ["project/history.rs", "That history entry no longer exists.", () => t`That history entry no longer exists.`],
  ["project/history.rs", "Invalid transaction id.", () => t`Invalid transaction id.`],

  // ZIP export and import (project/archive.rs)
  ["project/archive.rs", "Open a project before exporting.", () => t`Open a project before exporting.`],
  ["project/archive.rs", "Could not create the ZIP archive: {error}", ([error]) => t`Could not create the ZIP archive: ${error}`],
  ["project/archive.rs", "Choose a ZIP file to import.", () => t`Choose a ZIP file to import.`],
  ["project/archive.rs", "Choose a folder to extract the project into.", () => t`Choose a folder to extract the project into.`],
  ["project/archive.rs", "Could not extract the ZIP archive: {error}", ([error]) => t`Could not extract the ZIP archive: ${error}`],
  ["project/archive.rs", "{} is not a UTF-8 path.", ([path]) => t`${path} is not a UTF-8 path.`],

  // Saved templates (project/templates.rs)
  ["project/templates.rs", "Templates are limited to 2,000 files and 100 MB.", () => t`Templates are limited to 2,000 files and 100 MB.`],
  ["project/templates.rs", "The template contains duplicate file paths.", () => t`The template contains duplicate file paths.`],
  ["project/templates.rs", "Template paths must be UTF-8.", () => t`Template paths must be UTF-8.`],
  ["project/templates.rs", "The ZIP has too many entries.", () => t`The ZIP has too many entries.`],
  ["project/templates.rs", "Unsafe ZIP entry path.", () => t`Unsafe ZIP entry path.`],
  ["project/templates.rs", "Choose a folder or ZIP containing LaTeX source files.", () => t`Choose a folder or ZIP containing LaTeX source files.`],
  ["project/templates.rs", "Template identity does not match its folder.", () => t`Template identity does not match its folder.`],
  ["project/templates.rs", "Enter a template name and a short version.", () => t`Enter a template name and a short version.`],
  ["project/templates.rs", "Use an HTTP(S) source URL without credentials.", () => t`Use an HTTP(S) source URL without credentials.`],
  ["project/templates.rs", "Select the compile root, preview and reusable files, and a supported engine.", () => t`Select the compile root, preview and reusable files, and a supported engine.`],
  ["project/templates.rs", "A selected source file has disappeared. Review the source again.", () => t`A selected source file has disappeared. Review the source again.`],
  ["project/templates.rs", "Template files are missing.", () => t`Template files are missing.`],

  // The linked reference library (project/linked_bibliography.rs)
  ["project/linked_bibliography.rs", "Choose the library's .bib file by its full path.", () => t`Choose the library's .bib file by its full path.`],
  ["project/linked_bibliography.rs", "A linked library must be a .bib file.", () => t`A linked library must be a .bib file.`],
  ["project/linked_bibliography.rs", "The linked library is not a file.", () => t`The linked library is not a file.`],
  ["project/linked_bibliography.rs", "The linked library is larger than 16 MB.", () => t`The linked library is larger than 16 MB.`],
  ["project/linked_bibliography.rs", "The linked library is not UTF-8 text.", () => t`The linked library is not UTF-8 text.`],

  // Search, annotations and citation lookup
  ["project/search.rs", "Enter text to find.", () => t`Enter text to find.`],
  ["project/search.rs", "Invalid regular expression: {error}", ([error]) => t`Invalid regular expression: ${error}`],
  ["project/annotations.rs", "A revision round is numbered from 1.", () => t`A revision round is numbered from 1.`],
  ["project/citation_lookup.rs", "Enter a DOI, arXiv id, or paper title.", () => t`Enter a DOI, arXiv id, or paper title.`],
  ["project/citation_lookup.rs", "Could not check for same-title records: {error}. Retry or supply a DOI.", ([error]) => t`Could not check for same-title records: ${error}. Retry or supply a DOI.`],

  // SyncTeX between the PDF and its sources (latex/synctex.rs)
  ["latex/synctex.rs", "This PDF has no SyncTeX data, so Lattice cannot match it to the source. A PDF compiled outside Lattice leaves it out, and latexmk then reports nothing to do — press Build once to write it.", () => t`This PDF has no SyncTeX data, so Lattice cannot match it to the source. A PDF compiled outside Lattice leaves it out, and latexmk then reports nothing to do — press Build once to write it.`],
  ["latex/synctex.rs", "Invalid PDF source position.", () => t`Invalid PDF source position.`],
  ["latex/synctex.rs", "Build the project before locating PDF source.", () => t`Build the project before locating PDF source.`],
  ["latex/synctex.rs", "SyncTeX could not locate this PDF position.", () => t`SyncTeX could not locate this PDF position.`],
  ["latex/synctex.rs", "No LaTeX source was found for this PDF position.", () => t`No LaTeX source was found for this PDF position.`],
  ["latex/synctex.rs", "SyncTeX returned a source file outside this project.", () => t`SyncTeX returned a source file outside this project.`],
  ["latex/synctex.rs", "Choose a source line before locating it in the PDF.", () => t`Choose a source line before locating it in the PDF.`],
  ["latex/synctex.rs", "Source path is outside this project.", () => t`Source path is outside this project.`],
  ["latex/synctex.rs", "Build the project before locating source in the PDF.", () => t`Build the project before locating source in the PDF.`],
  ["latex/synctex.rs", "This bibliography entry is not included in the compiled PDF.", () => t`This bibliography entry is not included in the compiled PDF.`],
  ["latex/synctex.rs", "SyncTeX could not locate this source line.", () => t`SyncTeX could not locate this source line.`],
  ["latex/synctex.rs", "Build the project before counting its pages.", () => t`Build the project before counting its pages.`],
  ["latex/synctex.rs", "Build the project before locating its sections.", () => t`Build the project before locating its sections.`],
  ["latex/synctex.rs", "Could not start SyncTeX: {error}", ([error]) => t`Could not start SyncTeX: ${error}`],

  // Windows and the terminal (ipc/)
  ["ipc/workspace.rs", "This project is already open in another Lattice window. Open it in the browser from that window instead.", () => t`This project is already open in another Lattice window. Open it in the browser from that window instead.`],
  ["ipc/windows.rs", "This workspace is already open in the Lattice app.", () => t`This workspace is already open in the Lattice app.`],
  ["ipc/windows.rs", "Could not open a new Lattice window: {error}", ([error]) => t`Could not open a new Lattice window: ${error}`],
  ["ipc/windows.rs", "Could not open the log folder: {error}", ([error]) => t`Could not open the log folder: ${error}`],
  ["save_before_close.rs", "A window could not save its edits, so Lattice did not restart.", () => t`A window could not save its edits, so Lattice did not restart.`],
  ["ipc/terminal.rs", "Too much to type into the terminal at once.", () => t`Too much to type into the terminal at once.`],
  ["ipc/build.rs", "Choose where to save the PDF.", () => t`Choose where to save the PDF.`],

  // Saving copies and exports (export.rs)
  ["export.rs", "The exported paper must use the .pdf extension.", () => t`The exported paper must use the .pdf extension.`],
  ["export.rs", "Choose where to export the Excel workbook.", () => t`Choose where to export the Excel workbook.`],
  ["export.rs", "The exported workbook must use the .xlsx extension.", () => t`The exported workbook must use the .xlsx extension.`],
  ["export.rs", "Choose where to save the visual.", () => t`Choose where to save the visual.`],
  ["export.rs", "The saved visual must use the .html extension.", () => t`The saved visual must use the .html extension.`],
  ["export.rs", "The compiled output is not a valid PDF.", () => t`The compiled output is not a valid PDF.`],
  ["export.rs", "The visual is too large to save.", () => t`The visual is too large to save.`],
  ["export.rs", "The visual is not UTF-8 text.", () => t`The visual is not UTF-8 text.`],
  ["export.rs", "The Excel workbook is too large to export.", () => t`The Excel workbook is too large to export.`],
  ["export.rs", "The exported data is not a valid Excel workbook.", () => t`The exported data is not a valid Excel workbook.`],
  ["export.rs", "Choose where to save the copy.", () => t`Choose where to save the copy.`],
  ["export.rs", "A copy must keep a text file's extension, such as .tex or .txt.", () => t`A copy must keep a text file's extension, such as .tex or .txt.`],
  ["export.rs", "The text is too large to save as a copy.", () => t`The text is too large to save as a copy.`],
  ["export.rs", "The copy is not UTF-8 text.", () => t`The copy is not UTF-8 text.`],

  // Git and the marked-changes PDF (git.rs, latex/changes.rs)
  ["git.rs", "Commit message cannot be empty.", () => t`Commit message cannot be empty.`],
  ["git.rs", "Could not run git: {error}", ([error]) => t`Could not run git: ${error}`],
  ["git.rs", "This project is not inside a Git repository.", () => t`This project is not inside a Git repository.`],
  ["latex/changes.rs", "Only a LaTeX document can be exported with its changes marked.", () => t`Only a LaTeX document can be exported with its changes marked.`],
  ["latex/changes.rs", "Could not run latexdiff: {error}", ([error]) => t`Could not run latexdiff: ${error}`],
  ["latex/changes.rs", "The PDF with changes marked did not build: {}", ([detail]) => t`The PDF with changes marked did not build: ${detail}`],
  ["latex/changes.rs", "The PDF with changes marked did not build.", () => t`The PDF with changes marked did not build.`],

  // Live preview (ipc/live_preview.rs, live_preview/)
  ["ipc/live_preview.rs", "The live preview has stopped.", () => t`The live preview has stopped.`],
  ["live_preview/install.rs", "Live preview needs a Mac with Apple silicon.", () => t`Live preview needs a Mac with Apple silicon.`],
  ["live_preview/install.rs", "Live preview needs LuaLaTeX, and Lattice could not run it.", () => t`Live preview needs LuaLaTeX, and Lattice could not run it.`],
  ["live_preview/install.rs", "Could not install rtex: {error}", ([error]) => t`Could not install rtex: ${error}`],
  ["live_preview/install.rs", "Could not remove rtex: {error}", ([error]) => t`Could not remove rtex: ${error}`],
  ["live_preview/install.rs", "Could not unpack the rtex archive: {error}", ([error]) => t`Could not unpack the rtex archive: ${error}`],
  ["live_preview/session.rs", "The live preview engine is not installed. Turn live preview on again.", () => t`The live preview engine is not installed. Turn live preview on again.`],
  ["live_preview/session.rs", "Could not start the live preview engine: {error}", ([error]) => t`Could not start the live preview engine: ${error}`],
  ["live_preview/session.rs", "The live preview engine has stopped.", () => t`The live preview engine has stopped.`],
];
