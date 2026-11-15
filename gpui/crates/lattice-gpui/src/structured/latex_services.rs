//! The Tauri backend commands a `.tex` file's Visual page invokes beside its
//! text (`latex_visual.rs`), answered as the Tauri app answers them, from
//! the same `lattice-core` functions, each off the main thread:
//!
//! - Harper's check (`harper_lint`) and a dictionary's for a document in
//!   another language (`spelling_lint`), which the source editor's spell
//!   check runs (`src/editor/harper-spellcheck.ts`);
//! - TexLab's completion, hover and definition (`texlab_completion`,
//!   `texlab_hover`, `texlab_definition`, `src/build/texlab-language.ts`), on
//!   the project's TexLab pool, the one the source editor's diagnostics use;
//! - the PDF page of each heading the outline rail lists
//!   (`synctex_heading_pages`);
//! - every citation's uses, for a citation card's count
//!   (`list_citation_usages`).
//!
//! TexLab's requests carry the document's text only when the page thinks
//! TexLab lacks that revision of it, and the page sends the text again only
//! when the refusal it gets is exactly TexLab's `NEEDS_TEXT`. The island
//! bridge hands the page an `Error`, not that bare string, so here the last
//! text the page sent for each path is kept by revision and goes with a
//! request that names that revision: TexLab is never asked without it.

use std::{collections::HashMap, path::PathBuf};

use gpui::{Context, Entity};
use lattice_core::{
    harper::{self, HarperOptions},
    latex::SourceLine,
    texlab::DocumentAt,
};
use lattice_editor::texlab::TexlabService;
use serde::Deserialize;
use serde_json::Value;

use super::StructuredDocument;

/// What the services need beyond the document: the project's TexLab, the
/// language dictionaries' folder, and the text the page last sent TexLab
/// for each path, by revision.
pub(super) struct LatexServices {
    pub texlab: Entity<TexlabService>,
    pub dictionaries: Option<PathBuf>,
    texts: SentTexts,
}

impl LatexServices {
    pub fn new(texlab: Entity<TexlabService>, dictionaries: Option<PathBuf>) -> Self {
        Self {
            texlab,
            dictionaries,
            texts: SentTexts::default(),
        }
    }
}

/// The text the page last sent TexLab for each path, by revision.
#[derive(Default)]
struct SentTexts(HashMap<String, (u64, String)>);

impl SentTexts {
    /// The text to send TexLab for a request: the request's own, which is
    /// kept for its revision, or the one kept for the revision it names.
    fn text_for(&mut self, request: &TexlabRequest) -> Option<String> {
        match (&request.text, request.revision) {
            (Some(text), Some(revision)) => {
                self.0
                    .insert(request.path.clone(), (revision, text.clone()));
                Some(text.clone())
            }
            (Some(text), None) => Some(text.clone()),
            (None, Some(revision)) => self
                .0
                .get(&request.path)
                .filter(|(kept, _)| *kept == revision)
                .map(|(_, text)| text.clone()),
            (None, None) => None,
        }
    }
}

/// A TexLab request as `texlab-language.ts` sends it.
#[derive(Deserialize)]
struct TexlabRequest {
    path: String,
    text: Option<String>,
    revision: Option<u64>,
    line: u32,
    character: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarperRequest {
    text: String,
    #[serde(default)]
    project_words: Vec<String>,
    #[serde(default)]
    options: HarperOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpellingRequest {
    code: String,
    text: String,
    #[serde(default)]
    project_words: Vec<String>,
}

#[derive(Deserialize)]
struct HeadingsRequest {
    headings: Vec<SourceLine>,
}

fn parse<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|error| error.to_string())
}

fn json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

impl StructuredDocument {
    /// One of the backend commands above; false when `command` is not one.
    pub(super) fn invoke_latex_service(
        &mut self,
        id: u64,
        command: &str,
        args: &Value,
        cx: &mut Context<Self>,
    ) -> bool {
        match command {
            "harper_lint" => {
                let request = parse::<HarperRequest>(args);
                self.answer_off_thread(id, cx, move || {
                    let request = request?;
                    json(harper::lint(
                        &request.text,
                        &request.project_words,
                        &request.options,
                    ))
                });
            }
            "spelling_lint" => {
                let request = parse::<SpellingRequest>(args);
                let store = self
                    .latex_services
                    .as_ref()
                    .and_then(|services| services.dictionaries.clone());
                self.answer_off_thread(id, cx, move || {
                    let request = request?;
                    let store =
                        store.ok_or_else(|| "No folder for spelling dictionaries.".to_string())?;
                    json(lattice_core::spelling::lint(
                        &store,
                        &request.code,
                        &request.text,
                        &request.project_words,
                    )?)
                });
            }
            "texlab_completion" | "texlab_hover" | "texlab_definition" => {
                self.ask_texlab(id, command, args, cx)
            }
            "synctex_heading_pages" => {
                let request = parse::<HeadingsRequest>(args);
                let root = self.root.clone();
                self.answer_off_thread(id, cx, move || {
                    json(lattice_core::latex::heading_pages(
                        &root,
                        &request?.headings,
                    )?)
                });
            }
            "list_citation_usages" => {
                let root = self.root.clone();
                self.answer_off_thread(id, cx, move || {
                    json(lattice_core::project::citation_usages(&root)?)
                });
            }
            _ => return false,
        }
        true
    }

    /// A TexLab request at a position, on the project's pool.
    fn ask_texlab(&mut self, id: u64, command: &str, args: &Value, cx: &mut Context<Self>) {
        let request = match parse::<TexlabRequest>(args) {
            Ok(request) => request,
            Err(error) => return self.respond(id, Err(error), cx),
        };
        let Some(services) = &mut self.latex_services else {
            return self.respond(id, Err("TexLab is unavailable.".into()), cx);
        };
        let text = services.texts.text_for(&request);
        let (root, pool) = services.texlab.read(cx).pool();
        let command = command.to_string();
        self.answer_off_thread(id, cx, move || {
            let mut pool = pool
                .lock()
                .map_err(|_| "TexLab state is unavailable.".to_string())?;
            let at = DocumentAt {
                path: &request.path,
                text: text.as_deref(),
                revision: request.revision,
                line: request.line,
                character: request.character,
            };
            match command.as_str() {
                "texlab_completion" => json(pool.completion(&root, &at)?),
                "texlab_hover" => json(pool.hover(&root, &at)?),
                _ => json(pool.definition(&root, &at)?),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, text: Option<&str>, revision: Option<u64>) -> TexlabRequest {
        TexlabRequest {
            path: path.into(),
            text: text.map(str::to_string),
            revision,
            line: 1,
            character: 1,
        }
    }

    /// `texlab-language.ts` sends a revision's text once, then asks without
    /// it: the text it sent is what goes with those requests, and a newer
    /// revision it has not sent goes without, as TexLab would refuse it.
    #[test]
    fn a_request_without_text_takes_the_text_sent_for_its_revision() {
        let mut texts = SentTexts::default();
        assert_eq!(
            texts
                .text_for(&request("main.tex", Some("v1"), Some(1)))
                .as_deref(),
            Some("v1")
        );
        assert_eq!(
            texts
                .text_for(&request("main.tex", None, Some(1)))
                .as_deref(),
            Some("v1")
        );
        assert_eq!(texts.text_for(&request("main.tex", None, Some(2))), None);
        assert_eq!(texts.text_for(&request("other.tex", None, Some(1))), None);
    }
}
