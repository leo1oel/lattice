//! Save a local template (`SaveTemplateDialog` in
//! `src/project/local-templates.tsx`): over New project, a 520px dialog that
//! reads a source, From folder, From ZIP or (with a project open) Current
//! project, through lattice-core's `templates::inspect`, then asks the
//! template's name and version (each at most 300 characters, as the Tauri
//! fields' `maxLength`) and source URL, its compile root (a `.tex` file of
//! the source), engine and preview image (one of the files chosen), and
//! which of the source's reusable files to copy, none ticked at first. Save
//! template is offered once it has a name and the compile root is ticked;
//! lattice-core copies the files into the store (`templates::save`).
//!
//! While a read or a save runs the dialog is busy (Working…), keeps its
//! Escape and Cancel, and drops a reply that lands after it closed.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Context, Entity, EntityInputHandler as _, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, ParentElement as _,
    PathPromptOptions, Render, StatefulInteractiveElement as _, Styled as _, Subscription,
    Window, div, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::project::templates::{self, LocalTemplate};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, Field, Select, rise_in},
    tokens::{CONTAINER_DIALOG_CONFIRM_WIDE, FONT_WEIGHT_MEDIUM},
};

/// The fields' `maxLength`.
const MAX_CHARS: usize = 300;

/// The engines a template may name, as the Tauri select lists them.
const ENGINES: [(&str, &str); 3] = [("pdf", "pdfLaTeX"), ("xelatex", "XeLaTeX"), ("lualatex", "LuaLaTeX")];

pub enum SaveTemplateEvent {
    Close,
    Saved(LocalTemplate),
}

/// Where the template's files come from.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Folder,
    Zip,
    Current,
}

/// What `inspect` found in the source.
struct Review {
    files: Vec<String>,
}

pub struct SaveTemplateDialog {
    /// The project open in the window, for Current project.
    current: Option<PathBuf>,
    store: PathBuf,
    /// The source read, once one is.
    source: Option<PathBuf>,
    review: Option<Review>,
    name: Entity<InputState>,
    url: Entity<InputState>,
    version: Entity<InputState>,
    root: String,
    engine: String,
    preview: Option<String>,
    /// The files to copy, in the order ticked.
    files: Vec<String>,
    busy: bool,
    error: Option<String>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SaveTemplateEvent> for SaveTemplateDialog {}

/// `value` held to its first `MAX_CHARS` characters with the caret inside
/// it, or `None` when it fits.
fn fit(value: &str, caret: usize) -> Option<(String, usize)> {
    let end = value.char_indices().nth(MAX_CHARS).map(|(at, _)| at)?;
    Some((value[..end].to_string(), caret.min(end)))
}

/// Whether `file` can be a template's preview image.
fn is_preview(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".pdf", ".svg"].iter().any(|extension| lower.ends_with(extension))
}

impl SaveTemplateDialog {
    pub fn new(current: Option<PathBuf>, store: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut field = |cx: &mut Context<Self>| cx.new(|cx| InputState::new(window, cx));
        let (name, url, version) = (field(cx), field(cx), field(cx));
        let mut subscriptions = Vec::new();
        for input in [&name, &version] {
            // At most 300 characters (`maxLength`), once a composition is
            // committed (`set_value` clears the field's undo history, as the
            // workspace rename's does).
            subscriptions.push(cx.subscribe_in(input, window, |_, input, event, window, cx| {
                if let InputEvent::Change = event {
                    let composing =
                        input.update(cx, |input, cx| input.marked_text_range(window, cx).is_some());
                    let (value, caret) = {
                        let input = input.read(cx);
                        (input.value().to_string(), input.cursor())
                    };
                    if !composing && let Some((value, caret)) = fit(&value, caret) {
                        input.update(cx, |input, cx| {
                            input.set_value(value, window, cx);
                            input.set_selected_range(caret..caret, cx);
                        });
                    }
                }
                cx.notify();
            }));
        }
        subscriptions.push(cx.subscribe(&url, |_, _, _: &InputEvent, cx| cx.notify()));
        Self {
            current,
            store,
            source: None,
            review: None,
            name,
            url,
            version,
            root: String::new(),
            engine: "pdf".into(),
            preview: None,
            files: Vec::new(),
            busy: false,
            error: None,
            focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    /// Read a source of `kind`, asking which for a folder or a ZIP.
    fn choose(&mut self, kind: Kind, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        cx.notify();
        let current = self.current.clone();
        let picked = (kind != Kind::Current).then(|| {
            cx.prompt_for_paths(PathPromptOptions {
                files: kind == Kind::Zip,
                directories: kind == Kind::Folder,
                multiple: false,
                prompt: Some(t!("Choose template source").into()),
            })
        });
        cx.spawn_in(window, async move |this, cx| {
            let path = match picked {
                None => current,
                Some(picked) => match picked.await {
                    Ok(Ok(Some(paths))) => paths.into_iter().next(),
                    _ => None,
                },
            };
            let Some(path) = path else {
                this.update(cx, |this, cx| {
                    this.busy = false;
                    cx.notify();
                })
                .ok();
                return;
            };
            let read = {
                let path = path.clone();
                cx.background_spawn(async move { templates::inspect(&path) }).await
            };
            this.update(cx, |this, cx| {
                this.busy = false;
                match read {
                    Ok(found) => {
                        this.source = Some(path);
                        this.root = found.root;
                        this.engine = found.engine;
                        this.preview = None;
                        this.files.clear();
                        this.review = Some(Review { files: found.files });
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn draft(&self, cx: &App) -> LocalTemplate {
        LocalTemplate {
            id: String::new(),
            name: self.name.read(cx).value().to_string(),
            source_url: self.url.read(cx).value().to_string(),
            version: self.version.read(cx).value().to_string(),
            files: self.files.clone(),
            root: self.root.clone(),
            engine: self.engine.clone(),
            preview: self.preview.clone(),
        }
    }

    fn can_save(&self, cx: &App) -> bool {
        !self.busy
            && self.review.is_some()
            && !self.name.read(cx).value().trim().is_empty()
            && self.files.contains(&self.root)
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if !self.can_save(cx) {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        let store = self.store.clone();
        let draft = self.draft(cx);
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let saved = cx
                .background_spawn(async move { templates::save(&store, &source, draft) })
                .await;
            this.update(cx, |this, cx| {
                this.busy = false;
                match saved {
                    Ok(item) => cx.emit(SaveTemplateEvent::Saved(item)),
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        // `closeDisabled={busy}`.
        if !self.busy {
            cx.emit(SaveTemplateEvent::Close);
        }
    }

    fn toggle(&mut self, file: &str, checked: bool, cx: &mut Context<Self>) {
        if checked {
            if !self.files.iter().any(|ticked| ticked == file) {
                self.files.push(file.to_string());
            }
        } else {
            self.files.retain(|ticked| ticked != file);
            if self.preview.as_deref() == Some(file) {
                self.preview = None;
            }
        }
        cx.notify();
    }

    pub fn focus_dialog(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }
}

/// What a scenario reads and drives.
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SaveTemplateDialog {
    /// Read `path` as the source, as From folder does once it is chosen.
    pub fn read_source(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.current = Some(path);
        self.choose(Kind::Current, window, cx);
    }

    /// The source's files as read, if one is.
    pub fn source_files(&self) -> Option<Vec<String>> {
        self.review.as_ref().map(|review| review.files.clone())
    }

    pub fn tick(&mut self, file: &str, cx: &mut Context<Self>) {
        self.toggle(file, true, cx);
    }

    pub fn set_name(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.name.update(cx, |input, cx| input.set_value(name.to_string(), window, cx));
    }

    pub fn saveable(&self, cx: &App) -> bool {
        self.can_save(cx)
    }

    pub fn press_save(&mut self, cx: &mut Context<Self>) {
        self.save(cx);
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

impl Focusable for SaveTemplateDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SaveTemplateDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = CONTAINER_DIALOG_CONFIRM_WIDE
            .to_pixels(window.rem_size())
            .min(viewport.width - px(40.));
        let busy = self.busy;
        let label = |text: &'static str, control: gpui::AnyElement, cx: &App| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .font_weight(FONT_WEIGHT_MEDIUM)
                .text_color(palette.text)
                .child(text)
                .child(control)
                .into_any_element()
        };
        let mut sources = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .pt(px(12.))
            .child(
                Button::new("template-from-folder", t!("From folder"))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, window, cx| this.choose(Kind::Folder, window, cx))),
            )
            .child(
                Button::new("template-from-zip", t!("From ZIP"))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, window, cx| this.choose(Kind::Zip, window, cx))),
            );
        if self.current.is_some() {
            sources = sources.child(
                Button::new("template-from-current", t!("Current project"))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, window, cx| this.choose(Kind::Current, window, cx))),
            );
        }
        let mut card = div()
            .id("save-template")
            .w(width)
            .max_h(viewport.height - px(40.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .child(t!("Save a local template")),
            )
            .child(
                div()
                    .pt(px(8.))
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("Hidden files, project history, comments, sessions and credentials are excluded. Only saved files are copied")),
            )
            .child(sources);
        if let Some(review) = &self.review {
            let tex: Vec<String> = review.files.iter().filter(|file| file.ends_with(".tex")).cloned().collect();
            let root = Select::new("template-root", tex.clone(), tex.iter().position(|file| *file == self.root))
                .disabled(busy)
                .on_change(cx.listener(move |this, ix: &usize, _, cx| {
                    if let Some(file) = tex.get(*ix) {
                        this.root = file.clone();
                        cx.notify();
                    }
                }));
            let engine = Select::new(
                "template-engine",
                ENGINES.iter().map(|(_, name)| *name),
                ENGINES.iter().position(|(id, _)| *id == self.engine),
            )
            .disabled(busy)
            .on_change(cx.listener(|this, ix: &usize, _, cx| {
                this.engine = ENGINES[*ix].0.to_string();
                cx.notify();
            }));
            let images: Vec<String> = self.files.iter().filter(|file| is_preview(file)).cloned().collect();
            let mut previews = vec![t!("None").to_string()];
            previews.extend(images.iter().cloned());
            let chosen = match &self.preview {
                None => Some(0),
                Some(preview) => images.iter().position(|file| file == preview).map(|at| at + 1),
            };
            let preview = Select::new("template-preview", previews, chosen)
                .disabled(busy)
                .on_change(cx.listener(move |this, ix: &usize, _, cx| {
                    this.preview = ix.checked_sub(1).and_then(|at| images.get(at).cloned());
                    cx.notify();
                }));
            let list = div()
                .id("template-file-list")
                .flex()
                .flex_col()
                .gap(px(6.))
                .max_h(px(180.))
                .overflow_y_scroll()
                .children(review.files.iter().enumerate().map(|(ix, file)| {
                    let ticked = self.files.contains(file);
                    let entity = cx.entity().downgrade();
                    let name = file.clone();
                    Checkbox::new(("template-file", ix), if ticked { CheckState::On } else { CheckState::Off })
                        .label(file.clone())
                        .disabled(busy)
                        .on_toggle(move |checked, _, cx| {
                            entity.update(cx, |this, cx| this.toggle(&name, *checked, cx)).ok();
                        })
                }));
            let mut fields = div()
                .pt(px(12.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .min_w_0()
                .child(label(t!("Template name"), Field::new(&self.name).disabled(busy).into_any_element(), cx))
                .child(label(t!("Source URL"), Field::new(&self.url).disabled(busy).into_any_element(), cx))
                .child(label(t!("Version or year"), Field::new(&self.version).disabled(busy).into_any_element(), cx))
                .child(label(t!("Compile root"), root.into_any_element(), cx))
                .child(label(t!("LaTeX engine"), engine.into_any_element(), cx))
                .child(label(t!("Preview image"), preview.into_any_element(), cx))
                .child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text)
                        .child(t!("Select files to copy")),
                )
                .child(list);
            if !self.files.contains(&self.root) {
                fields = fields.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(t!("Select the compile root in the file list to continue.")),
                );
            }
            card = card.child(fields);
        }
        if let Some(error) = &self.error {
            card = card.child(
                div()
                    .pt(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(crate::host_errors::text(error)),
            );
        }
        let can_save = self.can_save(cx);
        card = card.child(
            div()
                .flex()
                .flex_wrap()
                .justify_end()
                .gap(px(8.))
                .pt(px(if self.error.is_some() { 16. } else { 24. }))
                .child(
                    Button::new("save-template-cancel", t!("Cancel"))
                        .ghost()
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                )
                .child(
                    Button::new(
                        "save-template-save",
                        if busy { t!("Working…") } else { t!("Save template") },
                    )
                    .primary()
                    .disabled(!can_save)
                    .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                ),
        );
        // `keepOnOutsideClick`: a press on the scrim does not close it.
        div()
            .id("save-template-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .items_center()
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.close(cx);
                }
            }))
            .child(rise_in("save-template-in", card))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_keeps_its_first_300_characters() {
        let long = "é".repeat(310);
        let (kept, caret) = fit(&long, long.len()).unwrap();
        assert_eq!(kept.chars().count(), 300);
        assert_eq!(caret, kept.len());
        assert!(fit(&"a".repeat(300), 300).is_none());
    }

    #[test]
    fn previews_are_the_image_and_pdf_files() {
        // /\.(png|jpe?g|pdf|svg)$/i
        for file in ["a.PNG", "b.jpeg", "c.jpg", "d.pdf", "e.svg"] {
            assert!(is_preview(file), "{file}");
        }
        for file in ["main.tex", "x.eps", "y.bib"] {
            assert!(!is_preview(file), "{file}");
        }
    }
}
