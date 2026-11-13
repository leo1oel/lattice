//! An Open Slide deck's side of its island: the commands its page invokes
//! (the runtime's lease and refresh, the reads it makes), and the saves Open
//! Slide makes, applied to the project as the Tauri app applies them
//! (`src/app/open-slide-writes.ts`, `use-apply-open-slide-mutation.ts`).
//!
//! The runtime is lattice-core's own supervisor ([`super::Presentation`]).
//! Each deck's island is one page to it, under a lease owner of its own
//! (`window`: the deck session's label, `page`: one per build of the page),
//! so a page torn down by hibernation or a closed tab is a page gone, whose
//! leases the supervisor drops, as it drops those of a Tauri page that was
//! closed without running its cleanup.
//!
//! A save is scoped twice: lattice-core refuses a path that leaves the
//! project, and this refuses one outside what Open Slide mirrors of it
//! (`NATIVE_ROOTS` in lattice-core: `slides/`, `assets/`, `themes/` and
//! `open-slide.config.ts`), so a deck cannot write the manuscript.
//! lattice-core writes each file atomically and records it in the project's
//! history, a text file merged against the bytes Open Slide replaced.

use std::path::{Path, PathBuf};

use gpui::{App, AppContext as _, Task};
use lattice_core::presentation::LeaseOwner;
use serde_json::{Value, json};

use super::presentation::Presentation;

/// What Open Slide mirrors of a project, and so what a deck may write.
const NATIVE_ROOTS: [&str; 4] = ["slides/", "assets/", "themes/", "open-slide.config.ts"];

/// The deck id of `slides/<id>/index.tsx` (`deckIdFromOpenSlidePath`).
pub fn deck_id(relative: &str) -> Option<&str> {
    let rest = relative.strip_prefix("slides/").or_else(|| {
        relative
            .get(..7)
            .filter(|prefix| prefix.eq_ignore_ascii_case("slides/"))
            .map(|_| &relative[7..])
    })?;
    let (id, file) = rest.split_once('/')?;
    if !file.eq_ignore_ascii_case("index.tsx") {
        return None;
    }
    let valid = !id.is_empty()
        && id
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()));
    valid.then_some(id)
}

/// The commands a deck's page invokes that its owner answers.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "presentation_ensure_ready"
            | "presentation_release"
            | "presentation_refresh_native_workspace"
            | "read_project_file"
            | "stat_project_file"
            | "watch_project"
    )
}

/// One deck island's standing with the runtime.
pub struct DeckSession {
    root: PathBuf,
    /// The lease owner's window: this session.
    label: String,
    /// The lease owner's page: this build of the island's page.
    page: String,
    presentation: Option<Presentation>,
}

impl DeckSession {
    pub fn new(root: &Path, cx: &mut App) -> Self {
        let label = format!("gpui-deck-{}", uuid::Uuid::new_v4().simple());
        let presentation = Presentation::get(cx);
        if let Some(presentation) = &presentation {
            presentation.shows(&label, root);
        }
        Self {
            root: root.to_path_buf(),
            label,
            page: uuid::Uuid::new_v4().to_string(),
            presentation,
        }
    }

    /// The page is gone (hibernated): its leases go with it, and the next
    /// build of it is a new page.
    pub fn release_all(&mut self, _: &mut App) {
        if let Some(presentation) = &self.presentation {
            presentation.runtime().forget_page(&self.label);
        }
        self.page = uuid::Uuid::new_v4().to_string();
    }

    /// Answer `command` off the main thread: starting the runtime takes up to
    /// lattice-core's startup timeout.
    pub fn invoke(
        &mut self,
        command: &str,
        args: &Value,
        cx: &mut App,
    ) -> Task<Result<Value, String>> {
        let root = self.root.clone();
        let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_string);
        match command {
            "watch_project" => Task::ready(Ok(Value::Null)),
            "read_project_file" => {
                let Some(path) = text("path") else {
                    return Task::ready(Err("No path".into()));
                };
                cx.background_spawn(async move {
                    lattice_core::project::read_file(&root, &path).map(Value::String)
                })
            }
            "stat_project_file" => {
                let Some(path) = text("path") else {
                    return Task::ready(Err("No path".into()));
                };
                cx.background_spawn(async move {
                    lattice_core::project::stat_file(&root, &path)
                        .map(|stat| json!({ "exists": stat.exists }))
                })
            }
            _ => {
                let Some(presentation) = self.presentation.clone() else {
                    return Task::ready(Err(
                        "Open Slide is not part of this build of the GPUI preview.".into(),
                    ));
                };
                // The page names the project; only this deck's may be asked for.
                if text("projectRoot").is_some_and(|asked| !same_root(Path::new(&asked), &root)) {
                    return Task::ready(Err("Another project's deck".into()));
                }
                let project_root = root.to_string_lossy().into_owned();
                let owner = LeaseOwner {
                    window: self.label.clone(),
                    page: self.page.clone(),
                };
                let lease_id = text("leaseId");
                let command = command.to_string();
                cx.background_spawn(async move {
                    let runtime = presentation.runtime();
                    match command.as_str() {
                        "presentation_ensure_ready" => {
                            let shows = presentation.shown_roots();
                            runtime
                                .ensure(&project_root, owner, &|window| shows.get(window).cloned())
                                .and_then(|info| {
                                    serde_json::to_value(info).map_err(|error| error.to_string())
                                })
                        }
                        "presentation_release" => runtime
                            .release(&project_root, &lease_id.unwrap_or_default())
                            .map(|()| Value::Null),
                        "presentation_refresh_native_workspace" => {
                            runtime.refresh(&project_root).map(|()| Value::Null)
                        }
                        _ => Err(format!("{command} is not a deck command")),
                    }
                })
            }
        }
    }
}

impl Drop for DeckSession {
    /// The tab closed or the project changed: its page is gone.
    fn drop(&mut self) {
        if let Some(presentation) = &self.presentation {
            presentation.runtime().forget_page(&self.label);
            presentation.forget(&self.label);
        }
    }
}

fn same_root(a: &Path, b: &Path) -> bool {
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

/// One applied Open Slide save.
#[derive(Debug)]
pub struct Applied {
    pub path: String,
    /// A text file's content as it landed (a merge may differ from what
    /// Open Slide sent).
    pub text: Option<String>,
    pub had_conflicts: bool,
    /// The sync operations the runtime's copy takes (`OpenSlideSyncOperation[]`).
    pub operations: Value,
}

/// Whether Open Slide may write the project file at `path`.
fn writable(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    !normalized.is_empty()
        && !normalized.starts_with('/')
        && !normalized
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
        && NATIVE_ROOTS.iter().any(|root| {
            if root.ends_with('/') {
                normalized.starts_with(root) && normalized.len() > root.len()
            } else {
                normalized == *root
            }
        })
}

/// Apply one Open Slide save (`OpenSlideMutation`) to the project at `root`.
pub fn apply_mutation(root: &Path, mutation: &Value) -> Result<Applied, String> {
    let text = |key: &str| mutation.get(key).and_then(Value::as_str);
    let path = text("path").unwrap_or_default().to_string();
    let kind = text("kind").unwrap_or_default();
    if !writable(&path) {
        return Err(format!("Open Slide may not write {path}."));
    }
    if !matches!(kind, "create" | "write" | "delete") {
        return Err(format!("Open Slide sent an incomplete edit for {path}."));
    }
    if kind == "delete" {
        if let Err(error) = lattice_core::project::delete_entry(root, &path) {
            // The runtime's copy and the project watcher can report one
            // unlink twice: a file already gone is deleted.
            let gone = lattice_core::project::stat_file(root, &path)
                .map(|stat| !stat.exists)
                .unwrap_or(false);
            if !gone {
                return Err(error);
            }
        }
        return Ok(Applied {
            operations: json!([{ "path": path, "kind": "delete" }]),
            path,
            text: None,
            had_conflicts: false,
        });
    }
    if let Some(content) = text("text") {
        let base = (kind == "write")
            .then(|| text("previousText").map(str::to_string))
            .flatten();
        let written = lattice_core::project::apply_editor_transaction(
            root,
            path.clone(),
            content.to_string(),
            base,
            None,
        )?;
        return Ok(Applied {
            operations: json!([{ "path": path, "kind": kind, "text": written.content }]),
            text: Some(written.content),
            had_conflicts: written.had_conflicts,
            path,
        });
    }
    if let Some(base64) = text("base64") {
        lattice_core::project::write_bytes(root, &path, base64)?;
        return Ok(Applied {
            operations: json!([{ "path": path, "kind": kind, "base64": base64 }]),
            path,
            text: None,
            had_conflicts: false,
        });
    }
    Err(format!("Open Slide sent an incomplete edit for {path}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("slides/talk")).unwrap();
        std::fs::write(
            dir.path().join("slides/talk/index.tsx"),
            "one\ntwo\nthree\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("main.tex"), "\\documentclass{article}").unwrap();
        // Adopted as Lattice adopts a folder, so it has its manifest and history.
        lattice_core::project::open(dir.path()).unwrap();
        dir
    }

    #[test]
    fn deck_paths_are_the_tauri_apps() {
        assert_eq!(
            deck_id("slides/understanding-attention/index.tsx"),
            Some("understanding-attention")
        );
        assert_eq!(deck_id("Slides/Talk2/INDEX.TSX"), Some("Talk2"));
        for path in [
            "slides/index.tsx",
            "slides/a/b/index.tsx",
            "slides/a--b/index.tsx",
            "slides/-a/index.tsx",
            "slides/a_b/index.tsx",
            "slides/a/index.ts",
            "other/a/index.tsx",
        ] {
            assert_eq!(deck_id(path), None, "{path}");
        }
    }

    #[test]
    fn a_deck_writes_only_what_open_slide_mirrors() {
        for path in [
            "slides/talk/index.tsx",
            "slides/talk/slide-2.tsx",
            "assets/plot.png",
            "themes/dark.css",
            "open-slide.config.ts",
        ] {
            assert!(writable(path), "{path}");
        }
        for path in [
            "main.tex",
            "references.bib",
            "slides",
            "slides/",
            "slidesx/a.tsx",
            "slides/../main.tex",
            "slides/./a.tsx",
            "/etc/passwd",
            "../outside/slides/a.tsx",
            "open-slide.config.ts/x",
            "",
        ] {
            assert!(!writable(path), "{path}");
        }
        let dir = project();
        let refused = apply_mutation(
            dir.path(),
            &json!({ "id": 1, "path": "main.tex", "kind": "write", "text": "gone" }),
        );
        assert!(refused.is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("main.tex")).unwrap(),
            "\\documentclass{article}"
        );
    }

    #[test]
    fn a_text_save_merges_against_what_it_replaced() {
        let dir = project();
        // Someone else changed the last line since Open Slide read the file.
        std::fs::write(
            dir.path().join("slides/talk/index.tsx"),
            "one\ntwo\nTHREE\n",
        )
        .unwrap();
        let applied = apply_mutation(
            dir.path(),
            &json!({
                "id": 2,
                "path": "slides/talk/index.tsx",
                "kind": "write",
                "text": "ONE\ntwo\nthree\n",
                "previousText": "one\ntwo\nthree\n",
            }),
        )
        .unwrap();
        assert_eq!(applied.text.as_deref(), Some("ONE\ntwo\nTHREE\n"));
        assert!(!applied.had_conflicts);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("slides/talk/index.tsx")).unwrap(),
            "ONE\ntwo\nTHREE\n"
        );
        assert_eq!(
            applied.operations,
            json!([{ "path": "slides/talk/index.tsx", "kind": "write", "text": "ONE\ntwo\nTHREE\n" }])
        );
    }

    #[test]
    fn creates_writes_bytes_and_deletes() {
        let dir = project();
        let created = apply_mutation(
            dir.path(),
            &json!({ "id": 3, "path": "slides/talk/slide-2.tsx", "kind": "create", "text": "two" }),
        )
        .unwrap();
        assert_eq!(created.text.as_deref(), Some("two"));
        apply_mutation(
            dir.path(),
            &json!({ "id": 4, "path": "assets/dot.png", "kind": "create", "base64": "iVBORw0KGgo=" }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("assets/dot.png")).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        let deleted = apply_mutation(
            dir.path(),
            &json!({ "id": 5, "path": "slides/talk/slide-2.tsx", "kind": "delete" }),
        )
        .unwrap();
        assert_eq!(
            deleted.operations,
            json!([{ "path": "slides/talk/slide-2.tsx", "kind": "delete" }])
        );
        assert!(!dir.path().join("slides/talk/slide-2.tsx").exists());
        // Deleting it again (a watcher's echo) is not an error.
        apply_mutation(
            dir.path(),
            &json!({ "id": 6, "path": "slides/talk/slide-2.tsx", "kind": "delete" }),
        )
        .unwrap();
        assert!(
            apply_mutation(
                dir.path(),
                &json!({ "id": 7, "path": "slides/talk/x.tsx", "kind": "write" })
            )
            .is_err()
        );
    }
}
