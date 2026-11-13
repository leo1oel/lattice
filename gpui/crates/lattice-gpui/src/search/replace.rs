//! Replace in project (⌘⇧H), as the Tauri app has it
//! (`src/project/project-replace-dialog.tsx`, the replace half of
//! `src/app/use-project-search.ts`).
//!
//! Preview lists what the query (literal or a regular expression, matching
//! case by default) would replace, at most 200 matches with the counts of
//! all of them; Replace N rewrites every match on disk through lattice-core,
//! which records the replacement in project history. Editing the query or an
//! option after a preview disarms Replace until the new query is previewed:
//! it would replace matches nobody has seen. Each step first saves the open
//! editors' unsaved edits, and runs only while it is the dialog's newest; a
//! replace is bound to the project it was approved in.

use std::path::PathBuf;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::project::{ReplacePreview, ReplaceResult};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, CheckState, Checkbox, Field},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{field::search_field, sheet::SheetFrame};

/// What the dialog asks the window for.
pub enum ProjectReplaceEvent {
    Dismiss,
    OpenMatch {
        path: String,
        line: u32,
    },
    /// Save the open editors' unsaved edits; the answer says whether all
    /// were saved.
    Save(SaveAnswer),
    /// Files were rewritten: bring the open ones and the tree up to date,
    /// and say what changed.
    Replaced(ReplaceResult),
}

/// Where the window answers a [`ProjectReplaceEvent::Save`]; taken once.
pub type SaveAnswer =
    std::rc::Rc<std::cell::RefCell<Option<futures::channel::oneshot::Sender<bool>>>>;

/// The search a shown preview was asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SearchKey {
    query: String,
    match_case: bool,
    use_regex: bool,
}

pub struct ProjectReplace {
    root: PathBuf,
    query: Entity<InputState>,
    replacement: Entity<InputState>,
    focus: FocusHandle,
    match_case: bool,
    use_regex: bool,
    busy: bool,
    error: Option<String>,
    preview: Option<(SearchKey, ReplacePreview)>,
    generation: u64,
    task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<ProjectReplaceEvent> for ProjectReplace {}

impl ProjectReplace {
    pub fn new(root: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Text to find"));
        let replacement = cx.new(|cx| InputState::new(window, cx).placeholder("Replacement text"));
        let subscriptions = vec![
            cx.subscribe_in(&query, window, |this, _, event, _, cx| match event {
                InputEvent::PressEnter { .. } => this.run_preview(cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }),
            cx.observe(&replacement, |_, _, cx| cx.notify()),
        ];
        Self {
            root,
            query,
            replacement,
            focus: cx.focus_handle(),
            match_case: true,
            use_regex: false,
            busy: false,
            error: None,
            preview: None,
            generation: 0,
            task: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn focus_input(&self, window: &mut Window, cx: &mut App) {
        self.query.update(cx, |input, cx| input.focus(window, cx));
    }

    fn key(&self, cx: &App) -> SearchKey {
        SearchKey {
            query: self.query.read(cx).value().to_string(),
            match_case: self.match_case,
            use_regex: self.use_regex,
        }
    }

    /// The preview, while it answers the query and options on screen.
    fn current_preview(&self, cx: &App) -> Option<&ReplacePreview> {
        let key = self.key(cx);
        self.preview
            .as_ref()
            .filter(|(shown, _)| *shown == key)
            .map(|(_, preview)| preview)
    }

    /// Whether the dialog holds input a stray press must not lose.
    fn dirty(&self, cx: &App) -> bool {
        !self.query.read(cx).value().is_empty() || !self.replacement.read(cx).value().is_empty()
    }

    /// Save first, then run `step` on the background executor while this
    /// is still the dialog's newest operation.
    fn run_step<T: Send + 'static>(
        &mut self,
        step: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
        landed: impl FnOnce(&mut Self, Result<T, String>, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.generation += 1;
        let generation = self.generation;
        self.busy = true;
        self.error = None;
        let root = self.root.clone();
        let (saved_tx, saved_rx) = futures::channel::oneshot::channel();
        cx.emit(ProjectReplaceEvent::Save(std::rc::Rc::new(
            std::cell::RefCell::new(Some(saved_tx)),
        )));
        self.task = Some(cx.spawn(async move |this, cx| {
            if !saved_rx.await.unwrap_or(false) {
                this.update(cx, |this, cx| {
                    if this.generation == generation {
                        this.busy = false;
                        cx.notify();
                    }
                })
                .ok();
                return;
            }
            let result = cx
                .background_executor()
                .spawn(async move { step(root) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.busy = false;
                landed(this, result, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn run_preview(&mut self, cx: &mut Context<Self>) {
        let key = self.key(cx);
        if key.query.trim().is_empty() || self.busy {
            return;
        }
        let search = key.clone();
        self.run_step(
            move |root| {
                lattice_core::project::preview_replace_in_project(
                    &root,
                    &search.query,
                    search.match_case,
                    search.use_regex,
                )
            },
            move |this, result, _| match result {
                Ok(preview) => this.preview = Some((key, preview)),
                Err(error) => {
                    this.preview = None;
                    this.error = Some(error);
                }
            },
            cx,
        );
    }

    fn run_replace(&mut self, cx: &mut Context<Self>) {
        let key = self.key(cx);
        let replacement = self.replacement.read(cx).value().to_string();
        self.run_step(
            move |root| {
                lattice_core::project::replace_in_project(
                    &root,
                    &key.query,
                    &replacement,
                    key.match_case,
                    key.use_regex,
                )
            },
            |this, result, cx| match result {
                Ok(result) => {
                    this.preview = None;
                    cx.emit(ProjectReplaceEvent::Replaced(result));
                }
                Err(error) => this.error = Some(error),
            },
            cx,
        );
    }

    /// Type into the fields and preview, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn fill(
        &mut self,
        query: &str,
        replacement: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.query.update(cx, |input, cx| {
            input.set_value(query.to_string(), window, cx)
        });
        self.replacement.update(cx, |input, cx| {
            input.set_value(replacement.to_string(), window, cx)
        });
        self.run_preview(cx);
    }

    /// The previewed count, once the preview answered, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn previewed(&self, cx: &App) -> Option<u32> {
        if self.busy {
            return None;
        }
        self.current_preview(cx).map(|preview| preview.replacements)
    }

    /// Press Replace, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn replace(&mut self, cx: &mut Context<Self>) {
        self.run_replace(cx);
    }
}

fn label(text: &'static str, control: impl IntoElement, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .text_role(TextRole::Caption, cx)
        .font_weight(FONT_WEIGHT_MEDIUM)
        .text_color(palette.text_secondary)
        .child(text)
        .child(control)
        .into_any_element()
}

fn plural(count: u32, one: &str, many: &str) -> String {
    if count == 1 {
        format!("{count} {one}")
    } else {
        format!("{count} {many}")
    }
}

impl Focusable for ProjectReplace {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.query.focus_handle(cx)
    }
}

impl Render for ProjectReplace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let view = cx.entity().downgrade();
        let editor_font = cx.lattice().fonts.editor.clone();
        let clear = view.clone();
        let find_field = search_field(
            "project-replace-find",
            &self.query,
            window,
            cx,
            move |window, cx| {
                clear
                    .update(cx, |this, cx| {
                        this.query.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                            input.focus(window, cx);
                        });
                        cx.notify();
                    })
                    .ok();
            },
        );
        let preview = self.current_preview(cx).cloned();
        let query_ready = !self.query.read(cx).value().trim().is_empty();
        let can_replace = query_ready
            && !self.busy
            && preview
                .as_ref()
                .is_some_and(|preview| preview.replacements > 0);
        let mut body: Vec<AnyElement> = vec![
            div()
                .text_role(TextRole::Micro, cx)
                .line_height(gpui::relative(1.5))
                .text_color(palette.text_secondary)
                .child("Replacements are recorded in project history")
                .into_any_element(),
            label("Find", find_field, cx),
            label("Replace with", Field::new(&self.replacement), cx),
            div()
                .flex()
                .flex_wrap()
                .gap(px(12.))
                .child(
                    Checkbox::new(
                        "replace-match-case",
                        if self.match_case {
                            CheckState::On
                        } else {
                            CheckState::Off
                        },
                    )
                    .label("Match case")
                    .on_toggle(cx.listener(|this, on: &bool, _, cx| {
                        this.match_case = *on;
                        cx.notify();
                    })),
                )
                .child(
                    Checkbox::new(
                        "replace-regex",
                        if self.use_regex {
                            CheckState::On
                        } else {
                            CheckState::Off
                        },
                    )
                    .label("Regex")
                    .on_toggle(cx.listener(|this, on: &bool, window, cx| {
                        this.use_regex = *on;
                        this.query.update(cx, |input, cx| {
                            input.set_placeholder(
                                if *on {
                                    "Regular expression"
                                } else {
                                    "Text to find"
                                },
                                window,
                                cx,
                            )
                        });
                        cx.notify();
                    })),
                )
                .into_any_element(),
        ];
        if let Some(error) = &self.error {
            body.push(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.danger)
                    .child(error.clone())
                    .into_any_element(),
            );
        }
        if let Some(preview) = &preview {
            let matches = plural(preview.replacements, "match", "matches");
            let files = plural(preview.files, "file", "files");
            let summary = if preview.replacements == 0 {
                "No matches found".to_string()
            } else if (preview.matches.len() as u32) < preview.replacements {
                format!("{matches} in {files} (showing first 200)")
            } else {
                format!("{matches} in {files}")
            };
            body.push(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(summary),
                    )
                    .when(!preview.matches.is_empty(), |this| {
                        this.child(
                            div()
                                .id("project-replace-hits")
                                .max_h(px(360.).min(window.viewport_size().height * 0.46))
                                .overflow_y_scroll()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .children(preview.matches.iter().enumerate().map(|(ix, hit)| {
                                    let (path, line) = (hit.path.clone(), hit.line);
                                    let border = palette.line_strong;
                                    div()
                                        .id(("replace-hit", ix))
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.))
                                        .px(px(10.))
                                        .py(px(8.))
                                        .rounded(px(6.))
                                        .border_1()
                                        .border_color(palette.line)
                                        .bg(palette.window)
                                        .cursor_pointer()
                                        .hover(move |style| style.border_color(border))
                                        .on_click(cx.listener(move |_, _, _, cx| {
                                            cx.emit(ProjectReplaceEvent::OpenMatch {
                                                path: path.clone(),
                                                line,
                                            })
                                        }))
                                        .child(
                                            div()
                                                .text_role(TextRole::Micro, cx)
                                                .font_weight(
                                                    lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD,
                                                )
                                                .text_color(palette.text_secondary)
                                                .child(format!("{}:{}", hit.path, hit.line)),
                                        )
                                        .child(
                                            div()
                                                .min_w_0()
                                                .truncate()
                                                .text_role(TextRole::Caption, cx)
                                                .font_family(editor_font.clone())
                                                .text_color(palette.text)
                                                .child(hit.preview.clone()),
                                        )
                                })),
                        )
                    })
                    .into_any_element(),
            );
        }
        let replace_label = if self.busy && preview.is_some() {
            "Replacing…".to_string()
        } else {
            match &preview {
                Some(preview) => format!("Replace {}", preview.replacements),
                None => "Replace all".to_string(),
            }
        };
        let actions = vec![
            Button::new("project-replace-cancel", "Cancel")
                .ghost()
                .on_click(cx.listener(|_, _, _, cx| cx.emit(ProjectReplaceEvent::Dismiss)))
                .into_any_element(),
            Button::new(
                "project-replace-preview",
                if self.busy && preview.is_none() {
                    "Searching…"
                } else {
                    "Preview"
                },
            )
            .disabled(!query_ready || self.busy)
            .on_click(cx.listener(|this, _, _, cx| this.run_preview(cx)))
            .into_any_element(),
            Button::new("project-replace-run", replace_label)
                .primary()
                .disabled(!can_replace)
                .on_click(cx.listener(|this, _, _, cx| this.run_replace(cx)))
                .into_any_element(),
        ];
        let close = view;
        let frame = SheetFrame {
            id: "project-replace",
            icon: Icon::REPLACE,
            title: "Find & replace in project",
            body,
            actions,
            scrim_closes: !self.dirty(cx),
        }
        .render(window, cx, move |_, cx| {
            close
                .update(cx, |_, cx| cx.emit(ProjectReplaceEvent::Dismiss))
                .ok();
        });
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .track_focus(&self.focus)
            .child(frame)
    }
}
