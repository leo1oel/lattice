/**
 * Paper import and citation errors (`src-tauri/src/papers/`), in the
 * interface language. See `host-error-text.ts` for how an entry is matched
 * and pinned. Cache-integrity diagnostics (an unsafe asset path, a manifest
 * version) stay English: they are for a bug report, not for the writer.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

// An apostrophe beside a placeholder starts an ICU quote, so the messages
// that quote a key with them double each one.
export const PAPERS_HOST_ERRORS: readonly HostErrorEntry[] = [
  // Finding and downloading a paper (papers/import.rs, papers/bundle.rs, papers/convert.rs)
  ["papers/import.rs", "Enter an arXiv id, a DOI, a URL, or a paper title.", () => t`Enter an arXiv id, a DOI, a URL, or a paper title.`],
  ["papers/bundle.rs", "Enter a valid arXiv id or URL.", () => t`Enter a valid arXiv id or URL.`],
  ["papers/bundle.rs", "Enter an http(s) URL.", () => t`Enter an http(s) URL.`],
  ["papers/bundle.rs", "The alphaXiv paper was not found.", () => t`The alphaXiv paper was not found.`],
  ["papers/bundle.rs", "The alphaXiv PDF has no readable text.", () => t`The alphaXiv PDF has no readable text.`],
  ["papers/ids.rs", "Invalid arXiv id.", () => t`Invalid arXiv id.`],
  ["papers.rs", "Paper import cancelled.", () => t`Paper import cancelled.`],
  ["papers.rs", "Lattice's required `uv` tool is not available yet. Open Settings → TeX doctor → Install required tools, then try again.", () => t`Lattice's required \`uv\` tool is not available yet. Open Settings → TeX doctor → Install required tools, then try again.`],
  ["papers.rs", "Could not start {tool}: {error}", ([tool, error]) => t`Could not start ${tool}: ${error}`],
  ["papers/convert.rs", "Source download failed: {error}", ([error]) => t`Source download failed: ${error}`],
  ["papers/convert.rs", "The source archive is larger than the 100 MB conversion limit.", () => t`The source archive is larger than the 100 MB conversion limit.`],
  ["papers/convert.rs", "The source gzip is unreadable: {error}", ([error]) => t`The source gzip is unreadable: ${error}`],
  ["papers/convert.rs", "PDF conversion failed: {error}", ([error]) => t`PDF conversion failed: ${error}`],
  ["papers/convert.rs", "The PDF has almost no text layer; a scanned paper needs OCR, which is not available.", () => t`The PDF has almost no text layer; a scanned paper needs OCR, which is not available.`],
  ["papers/convert.rs", "Enter an http(s) PDF URL.", () => t`Enter an http(s) PDF URL.`],
  ["papers/convert.rs", "The server returned HTTP {status} for the PDF.", ([status]) => t`The server returned HTTP ${status} for the PDF.`],
  ["papers/convert.rs", "PDF download failed: {error}", ([error]) => t`PDF download failed: ${error}`],
  ["papers/convert.rs", "The PDF is larger than the 100 MB conversion limit.", () => t`The PDF is larger than the 100 MB conversion limit.`],
  ["papers/convert.rs", "The URL did not return a PDF document.", () => t`The URL did not return a PDF document.`],
  ["papers/library.rs", "Cached paper has no full-text body.", () => t`Cached paper has no full-text body.`],

  // Citing a web page (papers/web_citation.rs)
  ["papers/web_citation.rs", "The page has no readable citation metadata; it may require JavaScript.", () => t`The page has no readable citation metadata; it may require JavaScript.`],
  ["papers/web_citation.rs", "The rendered page still has no reliable citation metadata. Supply its official BibTeX or DOI instead.", () => t`The rendered page still has no reliable citation metadata. Supply its official BibTeX or DOI instead.`],
  ["papers/web_citation.rs", "The webpage HTML exceeds the 4 MB citation extraction limit.", () => t`The webpage HTML exceeds the 4 MB citation extraction limit.`],
  ["papers/web_citation.rs", "Invalid alphaXiv citation.", () => t`Invalid alphaXiv citation.`],

  // Resolving a citation (papers/citation.rs, papers/import.rs)
  ["papers/citation.rs", "Could not read the arXiv title lookup: {error}", ([error]) => t`Could not read the arXiv title lookup: ${error}`],
  ["papers/citation.rs", "Citation resolution must return exactly one complete record.", () => t`Citation resolution must return exactly one complete record.`],
  ["papers/citation.rs", "The citation contains conflicting arXiv identifiers.", () => t`The citation contains conflicting arXiv identifiers.`],
  ["papers/citation.rs", "The citation DOI conflicts with its DOI URL.", () => t`The citation DOI conflicts with its DOI URL.`],
  ["papers/citation.rs", "Citation resolution returned a different paper than arXiv:{requested}. No citation was added.", ([id]) => t`Citation resolution returned a different paper than arXiv:${id}. No citation was added.`],
  ["papers/citation.rs", "Citation resolution did not return the requested DOI {doi}.", ([doi]) => t`Citation resolution did not return the requested DOI ${doi}.`],
  ["papers/citation.rs", "No citation was returned.", () => t`No citation was returned.`],
  ["papers/citation.rs", "The resolved title differs from the requested title. Supply its DOI or arXiv URL instead.", () => t`The resolved title differs from the requested title. Supply its DOI or arXiv URL instead.`],
  ["papers/citation.rs", "Invalid arXiv identity.", () => t`Invalid arXiv identity.`],
  ["papers/citation.rs", "This title has no independently verifiable identifier. Supply its official BibTeX or URL instead.", () => t`This title has no independently verifiable identifier. Supply its official BibTeX or URL instead.`],
  ["papers/citation.rs", "The candidate's title or authors conflict with its source metadata. No citation was added.", () => t`The candidate's title or authors conflict with its source metadata. No citation was added.`],
  ["papers/import.rs", "The bibliography changed while resolving the citation. Retry the import.", () => t`The bibliography changed while resolving the citation. Retry the import.`],
  ["papers/import.rs", "Citation resolution must return exactly one entry with its reported key.", () => t`Citation resolution must return exactly one entry with its reported key.`],
  ["papers/import.rs", "The bibliography already contains duplicate citation keys. Resolve them before importing.", () => t`The bibliography already contains duplicate citation keys. Resolve them before importing.`],
  ["papers/import.rs", "Invalid existing bibliography entry.", () => t`Invalid existing bibliography entry.`],
  ["papers/import.rs", "Citation '{}' has the same identifier but conflicting metadata. Review it before importing.", ([key]) => t`Citation ''${key}'' has the same identifier but conflicting metadata. Review it before importing.`],
  ["papers/import.rs", "Multiple existing citations match this paper. Resolve the duplicates before importing.", () => t`Multiple existing citations match this paper. Resolve the duplicates before importing.`],
  ["papers/import.rs", "Invalid citation entry.", () => t`Invalid citation entry.`],
  ["papers/import.rs", "Invalid citation key.", () => t`Invalid citation key.`],

  // Editing the bibliography (papers/bibliography.rs, ipc/bibliography.rs)
  ["papers/bibliography.rs", "Enter a citation key to remove.", () => t`Enter a citation key to remove.`],
  ["papers/bibliography.rs", "Citation key `{key}` is not in the primary bibliography.", ([key]) => t`Citation key \`${key}\` is not in the primary bibliography.`],
  ["papers/bibliography.rs", "An automatic publication upgrade requires an independently verifiable DOI. Use citation review instead.", () => t`An automatic publication upgrade requires an independently verifiable DOI. Use citation review instead.`],
  ["papers/bibliography.rs", "Publication metadata for '{key}' could not be independently confirmed.", ([key]) => t`Publication metadata for ''${key}'' could not be independently confirmed.`],
  ["papers/bibliography.rs", "The bibliography changed while upgrading. Retry the operation.", () => t`The bibliography changed while upgrading. Retry the operation.`],
  ["papers/bibliography.rs", "An upgrade cannot add or remove citations.", () => t`An upgrade cannot add or remove citations.`],
  ["papers/bibliography.rs", "An upgrade must preserve the unique citation key '{key}'.", ([key]) => t`An upgrade must preserve the unique citation key ''${key}''.`],
  ["papers/bibliography.rs", "The upgrade changes the identity of '{key}'. No changes were saved.", ([key]) => t`The upgrade changes the identity of ''${key}''. No changes were saved.`],
  ["ipc/bibliography.rs", "Choose whether to keep or remove manuscript citations.", () => t`Choose whether to keep or remove manuscript citations.`],
];
