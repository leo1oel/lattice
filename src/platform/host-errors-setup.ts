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
  // A missing package (tex_setup/package_providers.rs, tex_setup/macos.rs). The
  // first line is the summary the install sheet shows; what follows it is
  // tlmgr's or kpsewhich's own output, kept as written.
  ["tex_setup/package_providers.rs", "No TeX Live package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.", ([file]) => t`No TeX Live package provides ${file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.`],
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
  ["tex_setup/stub.rs", "One-click TeX package update is not available on Linux yet.", () => t`One-click TeX package update is not available on Linux yet.`],
  ["tex_setup/macos.rs", "Lattice only updates the BasicTeX it installs. In Terminal: {UPDATE_COMMAND}", ([command]) => t`Lattice only updates the BasicTeX it installs. In Terminal: ${command}`],
  ["tex_setup/macos.rs", "Could not request permission to install {name}: {error}", ([what, error]) => t`Could not request permission to install ${what}: ${error}`],
  ["tex_setup/macos.rs", "Could not locate your macOS Application Support folder.", () => t`Could not locate your macOS Application Support folder.`],
  ["tex_setup/macos.rs", "Automatic uv installation is not available for this Mac architecture ({}).", ([arch]) => t`Automatic uv installation is not available for this Mac architecture (${arch}).`],
  ["tex_setup/macos.rs", "Refusing to install uv into an invalid managed tools folder: {}", ([path]) => t`Refusing to install uv into an invalid managed tools folder: ${path}`],
  ["tex_setup/installer.rs", "The uv archive contained an invalid root entry.", () => t`The uv archive contained an invalid root entry.`],
  ["tex_setup/installer.rs", "The uv archive contained an unexpected entry: {}", ([entry]) => t`The uv archive contained an unexpected entry: ${entry}`],
  ["tex_setup/installer.rs", "The uv archive contained an invalid {name} entry.", ([name]) => t`The uv archive contained an invalid ${name} entry.`],
  ["tex_setup/installer.rs", "The uv archive did not contain the expected executables.", () => t`The uv archive did not contain the expected executables.`],

  // Installing TeX Live and the paper tools on Windows (tex_setup/windows.rs,
  // tex_setup/tex_live.rs, tex_setup/run.rs): per user, no administrator, and
  // stoppable.
  ["tex_setup/windows.rs", "The TeX installation was cancelled.", () => t`The TeX installation was cancelled.`],
  ["tex_setup/windows.rs", "This Lattice version includes TeX Live {}. Update Lattice to install the current TeX Live release.", ([year]) => t`This Lattice version includes TeX Live ${year}. Update Lattice to install the current TeX Live release.`],
  ["tex_setup/windows.rs", "TeX Live installed, but its package manager is missing.", () => t`TeX Live installed, but its package manager is missing.`],
  ["tex_setup/windows.rs", "No supported LaTeX engine could be run as your Windows user.", () => t`No supported LaTeX engine could be run as your Windows user.`],
  ["tex_setup/windows.rs", "TeX Live was installed, but required file {required_file} could not be found.\n{}", ([file, detail]) => t`TeX Live was installed, but required file ${file} could not be found.\n${detail}`],
  ["tex_setup/windows.rs", "TeX Live was installed, but Lattice could not look up required file {required_file}.\n{error}", ([file, error]) => t`TeX Live was installed, but Lattice could not look up required file ${file}.\n${error}`],
  ["tex_setup/windows.rs", "TeX Live was installed, but Lattice could not read required file {required_file}.\nResolved file: {resolved}\n{error}", ([file, resolved, error]) => t`TeX Live was installed, but Lattice could not read required file ${file}.\nResolved file: ${resolved}\n${error}`],
  ["tex_setup/windows.rs", "Could not search the MiKTeX packages: {error}", ([error]) => t`Could not search the MiKTeX packages: ${error}`],
  ["tex_setup/windows.rs", "The MiKTeX packages could not be searched.\n{}", ([detail]) => t`The MiKTeX packages could not be searched.\n${detail}`],
  ["tex_setup/miktex.rs", "No MiKTeX package provides {missing_file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.", ([file]) => t`No MiKTeX package provides ${file}. It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder.`],
  ["tex_setup/miktex.rs", "More than one MiKTeX package provides {missing_file}: {}. Nothing was installed automatically.", ([file, packages]) => t`More than one MiKTeX package provides ${file}: ${packages}. Nothing was installed automatically.`],
  ["tex_setup/tex_live.rs", "TeX Live installation failed. Please try again.", () => t`TeX Live installation failed. Please try again.`],
  ["tex_setup/tex_live.rs", "TeX Live installation failed.\n{detail}", ([detail]) => t`TeX Live installation failed.\n${detail}`],
  ["tex_setup/tex_live.rs", "TeX Live is installed, but Lattice could not finish installing the required LaTeX packages.\n{detail}", ([detail]) => t`TeX Live is installed, but Lattice could not finish installing the required LaTeX packages.\n${detail}`],
  ["tex_setup/tex_live.rs", "Could not read the TeX Live installer archive: {error}", ([error]) => t`Could not read the TeX Live installer archive: ${error}`],
  ["tex_setup/tex_live.rs", "Could not inspect the TeX Live installer archive: {error}", ([error]) => t`Could not inspect the TeX Live installer archive: ${error}`],
  ["tex_setup/tex_live.rs", "Could not unpack the TeX Live installer: {error}", ([error]) => t`Could not unpack the TeX Live installer: ${error}`],
  ["tex_setup/tex_live.rs", "The TeX Live installer archive contained an unsafe path: {name}", ([name]) => t`The TeX Live installer archive contained an unsafe path: ${name}`],
  ["tex_setup/tex_live.rs", "The TeX Live installer archive contained an unexpected entry: {name}", ([name]) => t`The TeX Live installer archive contained an unexpected entry: ${name}`],
  ["tex_setup/tex_live.rs", "The TeX Live installer archive contained a link at {name}", ([name]) => t`The TeX Live installer archive contained a link at ${name}`],
  ["tex_setup/tex_live.rs", "The TeX Live installer archive did not contain its installer.", () => t`The TeX Live installer archive did not contain its installer.`],
  ["tex_setup/run.rs", "Could not start {}: {error}", ([program, error]) => t`Could not start ${program}: ${error}`],
  ["tex_setup/run.rs", "Could not wait for {}: {error}", ([program, error]) => t`Could not wait for ${program}: ${error}`],
  ["tex_setup/windows.rs", "TeX Live was installed, but Lattice's templates need files it could not find: {}. Click Install TeX Live again, or install their packages with tlmgr.", ([files]) => t`TeX Live was installed, but Lattice's templates need files it could not find: ${files}. Click Install TeX Live again, or install their packages with tlmgr.`],
  ["tex_setup/tex_live.rs", "TeX Live cannot be installed automatically: your user folder's path has characters its installer cannot read, and Windows has no short name for it. Install TeX Live yourself (tug.org/texlive/windows.html), then recheck setup.", () => t`TeX Live cannot be installed automatically: your user folder's path has characters its installer cannot read, and Windows has no short name for it. Install TeX Live yourself (tug.org/texlive/windows.html), then recheck setup.`],
  ["tex_setup/fetch.rs", "The downloaded {} is larger than expected, so it was refused.", ([what]) => t`The downloaded ${what} is larger than expected, so it was refused.`],
  ["tex_setup/fetch.rs", "The download was cancelled.", () => t`The download was cancelled.`],

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
  ["synara/task_relay.rs", "The agent service returned {status}.", ([status]) => t`The agent service returned ${status}.`],
  // What an agent task (compile repair, proofreading) answers where the agent never starts.
  ["synara/bibliography_guard.rs", "The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.", () => t`The built-in agent is off on this platform until Lattice can keep it from editing bibliography (.bib) files directly.`],
  // On Linux the guard needs bubblewrap and FUSE, and does not reach every folder; the Agent panel's notice shows these too.
  ["synara/bibliography_guard/linux.rs", "The built-in agent is off because bubblewrap (bwrap) is not installed. Lattice runs the agent inside it to keep it from editing bibliography (.bib) files directly.", () => t`The built-in agent is off because bubblewrap (bwrap) is not installed. Lattice runs the agent inside it to keep it from editing bibliography (.bib) files directly.`],
  ["synara/bibliography_guard/linux.rs", "The built-in agent is off because FUSE (fusermount3 and /dev/fuse) is not available. Lattice needs it to keep the agent from editing bibliography (.bib) files directly.", () => t`The built-in agent is off because FUSE (fusermount3 and /dev/fuse) is not available. Lattice needs it to keep the agent from editing bibliography (.bib) files directly.`],
  ["synara/bibliography_guard/linux.rs", "The built-in agent is off because this system does not let bubblewrap start a sandbox (unprivileged user namespaces are restricted). Lattice runs the agent inside one to keep it from editing bibliography (.bib) files directly.", () => t`The built-in agent is off because this system does not let bubblewrap start a sandbox (unprivileged user namespaces are restricted). Lattice runs the agent inside one to keep it from editing bibliography (.bib) files directly.`],
  ["synara/bibliography_guard/linux.rs", "The built-in agent is off for this project: Lattice cannot keep it from editing bibliography (.bib) files here. That goes for temporary folders, the home folder itself and its hidden folders. Move the project to an ordinary folder to use the agent.", () => t`The built-in agent is off for this project: Lattice cannot keep it from editing bibliography (.bib) files here. That goes for temporary folders, the home folder itself and its hidden folders. Move the project to an ordinary folder to use the agent.`],

  // The terminal (terminal.rs, terminal/caller.rs, ipc/terminal.rs)
  ["terminal/windows.rs", "Could not supervise the Windows terminal process tree.", () => t`Could not supervise the Windows terminal process tree.`],
  ["terminal.rs", "This terminal has closed.", () => t`This terminal has closed.`],
  ["ipc/terminal/caller.rs", "The terminal is only available in a Lattice window.", () => t`The terminal is only available in a Lattice window.`],

  // Open Slide, the presentation editor (presentation.rs). What was being
  // refreshed is Rust's English (" for slides/deck.tsx"), so the
  // translation says only that the refresh failed.
  ["presentation.rs", "Open Slide refresh failed{subject} ({status}): {}", ([, status, reply]) => t`Open Slide refresh failed (${status}): ${reply}`],
  ["presentation.rs", "Open Slide did not expose readiness output", () => t`Open Slide did not expose readiness output`],
  ["presentation.rs", "Open Slide did not become ready within 30 seconds.", () => t`Open Slide did not become ready within 30 seconds.`],
  ["presentation.rs", "Open Slide returned invalid readiness data.", () => t`Open Slide returned invalid readiness data.`],
  ["presentation.rs", "The presentation project must be a directory.", () => t`The presentation project must be a directory.`],

  // Settings › Agent › Model endpoint (model_endpoint.rs, model_endpoint/keychain.rs)
  ["model_endpoint.rs", "Give between 1 and {MAX_MODELS} models.", ([count]) => t`Give between 1 and ${count} models.`],
  ["model_endpoint.rs", "A model name is empty or has spaces in it.", () => t`A model name is empty or has spaces in it.`],
  ["model_endpoint.rs", "The model {} is listed twice.", ([model]) => t`The model ${model} is listed twice.`],
  ["model_endpoint.rs", "The token limits of {} are out of range.", ([model]) => t`The token limits of ${model} are out of range.`],
  ["model_endpoint.rs", "Enter the endpoint’s address, starting with https:// or http://.", () => t`Enter the endpoint’s address, starting with https:// or http://.`],
  ["model_endpoint.rs", "The endpoint settings file is not valid JSON.", () => t`The endpoint settings file is not valid JSON.`],
  ["model_endpoint.rs", "Could not read the endpoint settings: {error}", ([error]) => t`Could not read the endpoint settings: ${error}`],
  ["model_endpoint.rs", "Could not create the endpoint settings folder: {error}", ([error]) => t`Could not create the endpoint settings folder: ${error}`],
  ["model_endpoint.rs", "That API key is not valid.", () => t`That API key is not valid.`],
  ["model_endpoint.rs", "The endpoint settings worker stopped.", () => t`The endpoint settings worker stopped.`],
  ["model_endpoint/keychain.rs", "Lattice could not use the system keychain.", () => t`Lattice could not use the system keychain.`],
];
