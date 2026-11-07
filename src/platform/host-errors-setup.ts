/**
 * Setup and tool errors — installing TeX and its missing packages, the
 * built-in agent's startup, the root document a build needs, the terminal and
 * Open Slide — in the interface language. See `host-error-text.ts` for how an
 * entry is matched and pinned.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

/** The parts of the built-in agent `SynaraRuntime::spawn` in synara.rs checks for. */
function bundledPart(what: string): string {
  switch (what) {
    case "JavaScript runtime": return t`JavaScript runtime`;
    case "Synara service": return t`Synara service`;
    default: return what;
  }
}

export const SETUP_HOST_ERRORS: readonly HostErrorEntry[] = [
  // A missing package (tex_setup/installer.rs, tex_setup/macos.rs). The
  // first line is the summary the install sheet shows; what follows it is
  // tlmgr's or kpsewhich's own output, kept as written.
  ["tex_setup/installer.rs", "No TeX Live package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.", ([file]) => t`No TeX Live package provides ${file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.`],
  ["tex_setup/installer.rs", "More than one TeX Live package provides {missing_file}: {}. Nothing was installed automatically.", ([file, packages]) => t`More than one TeX Live package provides ${file}: ${packages}. Nothing was installed automatically.`],
  ["tex_setup/macos.rs", "Invalid missing TeX dependency name.", () => t`Invalid missing TeX dependency name.`],
  ["tex_setup/macos.rs", "TeX Live's package manager is not installed.", () => t`TeX Live's package manager is not installed.`],
  ["tex_setup/macos.rs", "The TeX Live repository could not be searched.\n{}", ([detail]) => t`The TeX Live repository could not be searched.\n${detail}`],
  ["tex_setup/macos.rs", "Could not search the TeX Live repository: {error}", ([error]) => t`Could not search the TeX Live repository: ${error}`],
  ["tex_setup/macos.rs", "The package installation finished, but {missing_file} is still unavailable.\n{}", ([file, detail]) => t`The package installation finished, but ${file} is still unavailable.\n${detail}`],
  ["tex_setup/macos.rs", "Could not verify {missing_file}: {error}", ([file, error]) => t`Could not verify ${file}: ${error}`],
  ["tex_setup/macos.rs", "Required setup is already running in another Lattice window.", () => t`Required setup is already running in another Lattice window.`],

  // Installing BasicTeX and the paper tools (tex_setup/macos.rs, tex_setup/installer.rs,
  // and tex_setup/fetch.rs for the pinned downloads)
  ["tex_setup/macos.rs", "This Lattice version includes BasicTeX {BASIC_TEX_YEAR}. Update Lattice to install the current BasicTeX release.", ([year]) => t`This Lattice version includes BasicTeX ${year}. Update Lattice to install the current BasicTeX release.`],
  ["tex_setup/installer.rs", "BasicTeX installation failed. Please try again.", () => t`BasicTeX installation failed. Please try again.`],
  ["tex_setup/installer.rs", "BasicTeX installation failed.\n{detail}", ([detail]) => t`BasicTeX installation failed.\n${detail}`],
  ["tex_setup/installer.rs", "BasicTeX is installed, but Lattice could not finish installing the required LaTeX packages.\n{detail}", ([detail]) => t`BasicTeX is installed, but Lattice could not finish installing the required LaTeX packages.\n${detail}`],
  ["tex_setup/macos.rs", "BasicTeX was installed, but required file {required_file} could not be found.\n{}", ([file, detail]) => t`BasicTeX was installed, but required file ${file} could not be found.\n${detail}`],
  ["tex_setup/macos.rs", "BasicTeX was installed, but Lattice could not look up required file {required_file}.\n{error}", ([file, error]) => t`BasicTeX was installed, but Lattice could not look up required file ${file}.\n${error}`],
  ["tex_setup/macos.rs", "No supported LaTeX engine could be run as your macOS user.", () => t`No supported LaTeX engine could be run as your macOS user.`],
  ["tex_setup/macos.rs", "Lattice's managed {tool} failed user-level verification.\n{error}", ([tool, error]) => t`Lattice's managed ${tool} failed user-level verification.\n${error}`],
  ["tex_setup/fetch.rs", "Could not download {}: {error}", ([what, error]) => t`Could not download ${what}: ${error}`],
  ["tex_setup/fetch.rs", "The {name} download was interrupted: {error}", ([what, error]) => t`The ${what} download was interrupted: ${error}`],
  ["tex_setup/fetch.rs", "The downloaded {} failed its security check.", ([what]) => t`The downloaded ${what} failed its security check.`],
  // Elsewhere one-click install is not built yet (tex_setup/stub.rs).
  ["tex_setup/stub.rs", "One-click TeX install is not available on Linux yet.", () => t`One-click TeX install is not available on Linux yet.`],
  ["tex_setup/stub.rs", "One-click TeX package install is not available on Linux yet.", () => t`One-click TeX package install is not available on Linux yet.`],
  ["tex_setup/macos.rs", "Could not request permission to install {name}: {error}", ([what, error]) => t`Could not request permission to install ${what}: ${error}`],
  ["tex_setup/macos.rs", "Could not locate your macOS Application Support folder.", () => t`Could not locate your macOS Application Support folder.`],
  ["tex_setup/macos.rs", "Automatic uv installation is not available for this Mac architecture ({}).", ([arch]) => t`Automatic uv installation is not available for this Mac architecture (${arch}).`],
  ["tex_setup/macos.rs", "Refusing to install uv into an invalid managed tools folder: {}", ([path]) => t`Refusing to install uv into an invalid managed tools folder: ${path}`],
  ["tex_setup/installer.rs", "The uv archive contained an invalid root entry.", () => t`The uv archive contained an invalid root entry.`],
  ["tex_setup/installer.rs", "The uv archive contained an unexpected entry: {}", ([entry]) => t`The uv archive contained an unexpected entry: ${entry}`],
  ["tex_setup/installer.rs", "The uv archive contained an invalid {name} entry.", ([name]) => t`The uv archive contained an invalid ${name} entry.`],
  ["tex_setup/installer.rs", "The uv archive did not contain the expected executables.", () => t`The uv archive did not contain the expected executables.`],

  // The document a build compiles (latex/build.rs names its argument;
  // latex/pinned.rs and texcount.rs write the positional form)
  ["latex/build.rs", "{document}, the main document, is missing. Right-click another .tex file in the Project panel and choose Set as main document.", ([path]) => t`${path}, the main document, is missing. Right-click another .tex file in the Project panel and choose Set as main document.`],
  ["latex/pinned.rs", "Root document not found: {}", ([path]) => t`Root document not found: ${path}`],

  // The built-in agent's startup (synara.rs). The startup log is the
  // sidecar's own output and stays as written.
  ["synara.rs", "The built-in agent did not become ready within {} seconds.", ([seconds]) => t`The built-in agent did not become ready within ${seconds} seconds.`],
  ["synara.rs", "The built-in agent stopped during startup with status {status}.{detail}", ([status, detail]) => (
    detail ? t`The built-in agent stopped during startup with status ${status}.${detail}` : t`The built-in agent stopped during startup with status ${status}.`
  )],
  ["synara.rs", " Startup log: {excerpt}", ([excerpt]) => t` Startup log: ${excerpt}`],
  ["synara.rs", "The bundled {what} is missing at {}.", ([what, path]) => t`The bundled ${bundledPart(what)} is missing at ${path}.`],
  ["synara.rs", "The agent service returned {status}.", ([status]) => t`The agent service returned ${status}.`],
  // What an agent task (compile repair, proofreading) answers where the agent never starts.
  ["synara/bibliography_guard.rs", "The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.", () => t`The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.`],

  // The terminal (terminal.rs, terminal/caller.rs, ipc/terminal.rs)
  ["terminal.rs", "This terminal has closed.", () => t`This terminal has closed.`],
  ["terminal/caller.rs", "The terminal is only available in a Lattice window.", () => t`The terminal is only available in a Lattice window.`],

  // Open Slide, the presentation editor (presentation.rs). What was being
  // refreshed is Rust's English (" for slides/deck.tsx"), so the
  // translation says only that the refresh failed.
  ["presentation.rs", "Open Slide refresh failed{subject} ({status}): {}", ([, status, reply]) => t`Open Slide refresh failed (${status}): ${reply}`],
  ["presentation.rs", "Open Slide did not expose readiness output", () => t`Open Slide did not expose readiness output`],
  ["presentation.rs", "Open Slide did not become ready within 30 seconds.", () => t`Open Slide did not become ready within 30 seconds.`],
  ["presentation.rs", "Open Slide returned invalid readiness data.", () => t`Open Slide returned invalid readiness data.`],
  ["presentation.rs", "The presentation project must be a directory.", () => t`The presentation project must be a directory.`],
];
