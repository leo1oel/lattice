//! Linked library, the sheet (`linked-library-sheet.tsx`): the `.bib` file a
//! reference manager keeps up to date, linked to the project's
//! bibliography. Opening it reads the file and lays out what taking it in
//! would change, in four kinds (new papers, fields the library updated,
//! fields the writer changed here as well, papers the library dropped), and
//! nothing reaches the project's `.bib` until the writer applies the changes
//! they ticked. Unticked changes are not offered again: the link remembers
//! the library as it was when the writer last looked.

use std::{collections::HashSet, path::PathBuf};

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, Window, div, prelude::FluentBuilder as _,
    px,
};
use lattice_core::project::{self as core_project, LinkedBibliography};
use lattice_i18n::{format_count, join_phrases, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Button,
    icons::{ICON, ICON_SMALL},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{ChangeKind, LibraryChange, apply_library_changes, compare_library};
use crate::{notices, search::sheet::SheetFrame};

mod change_row;
use change_row::kind_label;

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

struct Loaded {
    source: String,
    library: String,
    /// The library as last taken in; none before the first update from
    /// this file.
    base: Option<String>,
    /// The project's `.bib` as compared: the changes are measured on it.
    local: String,
    changes: Vec<LibraryChange>,
}

enum Phase {
    Loading,
    Unlinked,
    Failed {
        source: Option<String>,
        error: String,
    },
    Ready(Loaded),
}

pub enum LinkedLibraryEvent {
    Dismiss,
    /// The project's `.bib` was rewritten.
    Applied,
}

pub struct LinkedLibrary {
    root: PathBuf,
    /// The project's primary bibliography, which a new link updates.
    bibliography: String,
    link: Option<LinkedBibliography>,
    phase: Phase,
    selected: HashSet<String>,
    tab: Option<ChangeKind>,
    busy: bool,
    generation: u64,
    focus: FocusHandle,
    _task: Option<Task<()>>,
}

impl EventEmitter<LinkedLibraryEvent> for LinkedLibrary {}

impl LinkedLibrary {
    /// `saved`: the editors' pending writes, which the comparison waits
    /// for, since it reads the files on disk.
    pub fn new(root: PathBuf, saved: Task<bool>, cx: &mut Context<Self>) -> Self {
        let bibliography = core_project::read_manifest(&root)
            .map(|manifest| manifest.primary_bibliography)
            .unwrap_or_default();
        let mut this = Self {
            root,
            bibliography,
            link: None,
            phase: Phase::Loading,
            selected: HashSet::new(),
            tab: None,
            busy: false,
            generation: 0,
            focus: cx.focus_handle(),
            _task: None,
        };
        let root = this.root.clone();
        this._task = Some(cx.spawn(async move |this, cx| {
            saved.await;
            let link = cx
                .background_spawn(async move { core_project::read_linked_bibliography(&root) })
                .await;
            this.update(cx, |this, cx| {
                match link {
                    Ok(Some(link)) => {
                        let source = link.source.clone();
                        this.link = Some(link);
                        this.load(source, cx);
                    }
                    Ok(None) => this.phase = Phase::Unlinked,
                    Err(error) => {
                        this.phase = Phase::Failed {
                            source: None,
                            error,
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        this
    }

    fn target(&self) -> String {
        self.link
            .as_ref()
            .map(|link| link.target.clone())
            .unwrap_or_else(|| self.bibliography.clone())
    }

    /// Read the library and the project's `.bib`, and compare them against
    /// the base.
    fn load(&mut self, source: String, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.phase = Phase::Loading;
        let into = self.target();
        let base = self
            .link
            .as_ref()
            .filter(|link| link.source == source)
            .map(|link| link.baseline.clone());
        if into.is_empty() {
            self.phase = Phase::Failed {
                source: Some(source),
                error: t!("This project has no primary bibliography.").into(),
            };
            cx.notify();
            return;
        }
        let root = self.root.clone();
        let (read_source, read_base) = (source.clone(), base.clone());
        let read = cx.background_spawn(async move {
            let library = core_project::read_bibliography_source(&read_source).map_err(|error| {
                // A cloud folder not synced yet, a drive not mounted, a file
                // renamed.
                if error.contains("(os error 2)") {
                    t!(
                        "Can't find {0}. It may have been moved or renamed, or its drive is not connected.",
                        file_name(&read_source)
                    )
                } else {
                    error
                }
            })?;
            let local = core_project::read_file(&root, &into)?;
            let cited: Option<HashSet<String>> = lattice_core::project::citation_usages(&root)
                .ok()
                .map(|usages| usages.into_iter().map(|usage| usage.symbol).collect());
            let changes = compare_library(
                read_base.as_deref(),
                &library,
                &local,
                &file_name(&read_source),
                &file_name(&into),
                cited.as_ref(),
            )?;
            Ok::<_, String>((library, local, changes))
        });
        self._task = Some(cx.spawn(async move |this, cx| {
            let read = read.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match read {
                    Ok((library, local, changes)) => {
                        // New papers come in unless unticked; a library's
                        // update does once the link has a base to tell it
                        // from the writer's own edits. Nothing is removed
                        // and no field of the writer's replaced until ticked.
                        this.selected = changes
                            .iter()
                            .filter(|change| {
                                change.kind == ChangeKind::New
                                    || (change.kind == ChangeKind::Updated && base.is_some())
                            })
                            .map(|change| change.id.clone())
                            .collect();
                        this.tab = None;
                        this.phase = Phase::Ready(Loaded {
                            source,
                            library,
                            base,
                            local,
                            changes,
                        });
                    }
                    Err(error) => {
                        this.phase = Phase::Failed {
                            source: Some(source),
                            error,
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn choose(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(t!("Choose your library's .bib file").into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                this.load(path.to_string_lossy().into_owned(), cx)
            })
            .ok();
        })
        .detach();
    }

    fn unlink(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        let root = self.root.clone();
        let target = self.target();
        let unlink = cx.background_spawn(async move { core_project::unlink_bibliography(&root) });
        cx.spawn(async move |this, cx| {
            let unlinked = unlink.await;
            this.update(cx, |this, cx| match unlinked {
                Ok(()) => {
                    notices::info(
                        t!("Linked library"),
                        t!("Unlinked. {target} stays as it is.", target = target),
                        cx,
                    );
                    cx.emit(LinkedLibraryEvent::Dismiss);
                }
                Err(error) => {
                    notices::error(t!("Linked library"), error, cx);
                    this.busy = false;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn chosen(&self) -> Vec<LibraryChange> {
        let Phase::Ready(loaded) = &self.phase else {
            return Vec::new();
        };
        loaded
            .changes
            .iter()
            .filter(|change| {
                self.selected.contains(&change.id)
                    && !(change.kind == ChangeKind::Removed && change.cited)
            })
            .cloned()
            .collect()
    }

    /// Write the chosen changes into the project's `.bib` as one undoable
    /// edit, from its text on disk now, and remember the library as seen.
    fn apply(&mut self, cx: &mut Context<Self>) {
        let Phase::Ready(loaded) = &self.phase else {
            return;
        };
        if self.busy {
            return;
        }
        self.busy = true;
        let chosen = self.chosen();
        let (root, target) = (self.root.clone(), self.target());
        let (source, library) = (loaded.source.clone(), loaded.library.clone());
        let compared = loaded.local.clone();
        let again = source.clone();
        let relinking = self.link.as_ref().is_none_or(|link| link.source != source);
        let write = cx.background_spawn(async move {
            let changed = if chosen.is_empty() {
                false
            } else {
                let current = core_project::read_file(&root, &target)?;
                // Edited since the comparison: the ticked changes may now
                // overwrite those edits. Which entries are cited was read
                // when the sheet opened, as the Tauri app reads it, and is
                // not read again here.
                if current != compared {
                    return Ok(None);
                }
                let next = apply_library_changes(&current, &library, &chosen)?;
                if next != current {
                    core_project::apply_editor_transaction(
                        &root,
                        target.clone(),
                        next,
                        Some(current),
                        None,
                    )?;
                    true
                } else {
                    false
                }
            };
            let link = core_project::save_linked_bibliography(&root, &source, &target, library)?;
            Ok::<_, String>(Some((changed, link)))
        });
        let library_name = file_name(&loaded.source);
        let target = self.target();
        cx.spawn(async move |this, cx| {
            let written = write.await;
            this.update(cx, |this, cx| match written {
                Ok(None) => {
                    notices::info(
                        t!("Linked library"),
                        t!(
                            "{target} changed while this was open. Its changes were compared again.",
                            target = target
                        ),
                        cx,
                    );
                    this.busy = false;
                    this.load(again, cx);
                }
                Ok(Some((changed, link))) => {
                    this.link = Some(link);
                    let message = if changed {
                        t!(
                            "Updated {target} from {library}. Undo it from History.",
                            target = target,
                            library = library_name
                        )
                    } else if relinking {
                        t!(
                            "Linked {library} to {target}.",
                            library = library_name,
                            target = target
                        )
                    } else {
                        t!("{library} is up to date.", library = library_name)
                    };
                    notices::info(t!("Linked library"), message, cx);
                    if changed {
                        cx.emit(LinkedLibraryEvent::Applied);
                    }
                    cx.emit(LinkedLibraryEvent::Dismiss);
                }
                Err(error) => {
                    notices::error(t!("Linked library"), error, cx);
                    this.busy = false;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Closing waits for a write under way to land.
    fn close(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        cx.emit(LinkedLibraryEvent::Dismiss);
    }
}

impl Focusable for LinkedLibrary {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for LinkedLibrary {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let target = self.target();
        let source = match &self.phase {
            Phase::Ready(loaded) => Some(loaded.source.clone()),
            Phase::Failed { source, .. } => source.clone(),
            _ => None,
        }
        .or_else(|| self.link.as_ref().map(|link| link.source.clone()));
        let updated = self
            .link
            .as_ref()
            .filter(|link| Some(&link.source) == source.as_ref())
            .map(|link| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis() as u64);
                crate::welcome::age(link.updated_at, now)
            });
        let caption = |text: String, ink: gpui::Hsla, cx: &Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(ink)
                .child(text)
                .into_any_element()
        };
        let mut body: Vec<AnyElement> = Vec::new();
        if let Some(source) = &source {
            body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .p(px(10.))
                    .rounded(px(8.))
                    .bg(palette.text.opacity(0.03))
                    .child(Icon::FILE_TEXT.element(ICON, palette.text_secondary))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_role(TextRole::BodyCompact, cx)
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text)
                                    .child(file_name(source)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(
                                        Icon::ARROW_RIGHT.element(px(11.), palette.text_secondary),
                                    )
                                    .child(
                                        div().truncate().child(join_phrases(
                                            &[Some(target.clone()), updated.clone()]
                                                .into_iter()
                                                .flatten()
                                                .collect::<Vec<_>>(),
                                        )),
                                    ),
                            ),
                    )
                    .child(
                        Button::new("linked-choose-another", t!("Choose another…"))
                            .compact()
                            .ghost()
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.choose(cx))),
                    )
                    .when(self.link.is_some(), |row| {
                        row.child(
                            Button::new("linked-unlink", t!("Unlink"))
                                .compact()
                                .ghost()
                                .disabled(self.busy)
                                .on_click(
                                    cx.listener(|this, _: &ClickEvent, _, cx| this.unlink(cx)),
                                ),
                        )
                    })
                    .into_any_element(),
            );
        }
        match &self.phase {
            Phase::Loading => body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(Icon::LOADER.element(ICON_SMALL, palette.text_secondary))
                    .child(caption(
                        match &source {
                            Some(source) => t!("Reading {0}…", file_name(source)),
                            None => t!("Reading the link…").to_string(),
                        },
                        palette.text_secondary,
                        cx,
                    ))
                    .into_any_element(),
            ),
            Phase::Unlinked => body.push(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(12.))
                    .flex_1()
                    .child(
                        div()
                            .text_role(TextRole::Body, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(t!("Link a Zotero or Paperpile export")),
                    )
                    .child(
                        Button::new("linked-choose", t!("Choose .bib file…"))
                            .primary()
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.choose(cx))),
                    )
                    .into_any_element(),
            ),
            Phase::Failed { source, error } => {
                let retry = source.clone();
                body.push(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(caption(
                            error.clone(),
                            mix(palette.danger, palette.text, 0.2),
                            cx,
                        ))
                        .child(caption(
                            t!("{target} has not been changed.", target = target),
                            palette.text_secondary,
                            cx,
                        ))
                        .child(
                            div()
                                .flex()
                                .gap(px(6.))
                                .when_some(retry, |row, source| {
                                    row.child(
                                        Button::new("linked-retry", t!("Try again"))
                                            .compact()
                                            .on_click(cx.listener(
                                                move |this, _: &ClickEvent, _, cx| {
                                                    this.load(source.clone(), cx)
                                                },
                                            )),
                                    )
                                })
                                .child(
                                    Button::new("linked-locate", t!("Locate the file…"))
                                        .compact()
                                        .ghost()
                                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                            this.choose(cx)
                                        })),
                                ),
                        )
                        .into_any_element(),
                );
            }
            Phase::Ready(loaded) if loaded.changes.is_empty() => body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(Icon::CHECK.element(ICON_SMALL, palette.success))
                    .child(caption(t!("Up to date").into(), palette.text_secondary, cx))
                    .into_any_element(),
            ),
            Phase::Ready(loaded) => {
                let count = |kind: Option<ChangeKind>| {
                    loaded
                        .changes
                        .iter()
                        .filter(|change| kind.is_none_or(|kind| change.kind == kind))
                        .count()
                };
                let mut tabs = div().flex().flex_wrap().gap(px(4.));
                for kind in [
                    None,
                    Some(ChangeKind::New),
                    Some(ChangeKind::Updated),
                    Some(ChangeKind::Conflict),
                    Some(ChangeKind::Removed),
                ] {
                    let n = count(kind);
                    if kind.is_some() && n == 0 {
                        continue;
                    }
                    let on = self.tab == kind;
                    tabs = tabs.child(
                        div()
                            .id(SharedString::from(format!("linked-tab:{kind:?}")))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .h(px(26.))
                            .px(px(10.))
                            .rounded_full()
                            .cursor_pointer()
                            .when(on, |tab| tab.bg(palette.text.opacity(0.07)))
                            .when(!on, |tab| tab.hover(|style| style.bg(palette.hover)))
                            .text_role(TextRole::Caption, cx)
                            .text_color(if on {
                                palette.text
                            } else {
                                palette.text_secondary
                            })
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                                this.tab = kind;
                                cx.notify();
                            }))
                            .child(kind.map_or(t!("All"), kind_label))
                            .child(format_count(n as i64)),
                    );
                }
                body.push(tabs.into_any_element());
                if loaded.base.is_some() {
                    body.push(caption(
                        t!("What you leave unticked is not offered again.").into(),
                        palette.text_secondary,
                        cx,
                    ));
                }
                let shown: Vec<LibraryChange> = loaded
                    .changes
                    .iter()
                    .filter(|change| self.tab.is_none_or(|kind| change.kind == kind))
                    .cloned()
                    .collect();
                let mut list = div()
                    .id("linked-rows")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(palette.line)
                    .bg(palette.raised);
                for (at, change) in shown.iter().enumerate() {
                    list = list.child(
                        div()
                            .when(at > 0, |row| row.border_t_1().border_color(palette.line))
                            .child(self.change_row(change, editor_font.clone(), cx)),
                    );
                }
                body.push(list.into_any_element());
            }
        }
        let (changes, base) = match &self.phase {
            Phase::Ready(loaded) => (loaded.changes.len(), Some(loaded)),
            _ => (0, None),
        };
        let chosen = self.chosen().len();
        let summary = match base {
            None => String::new(),
            Some(_) if changes > 0 => t!("{0} of {1} selected", chosen, changes),
            Some(_) => match &updated {
                Some(updated) => t!(
                    "Nothing has changed since you last updated, {updated}.",
                    updated = updated
                ),
                None => t!(
                    "Nothing to change — {target} already matches.",
                    target = target
                ),
            },
        };
        let relinking = self
            .link
            .as_ref()
            .is_none_or(|link| Some(&link.source) != base.map(|loaded| &loaded.source));
        let action = if changes == 0 {
            if relinking {
                t!("Link").to_string()
            } else {
                t!("Done").to_string()
            }
        } else if chosen == 1 {
            t!("Apply 1 change").to_string()
        } else if chosen > 0 {
            t!("Apply {0} changes", chosen)
        } else {
            t!("Skip these changes").to_string()
        };
        let mut actions: Vec<AnyElement> = vec![
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(summary)
                .into_any_element(),
            Button::new("linked-cancel", t!("Cancel"))
                .ghost()
                .disabled(self.busy)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close(cx)))
                .into_any_element(),
        ];
        if base.is_some() {
            actions.push(
                Button::new("linked-apply", action)
                    .primary()
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.apply(cx)))
                    .into_any_element(),
            );
        }
        let view = cx.entity().downgrade();
        SheetFrame {
            id: "linked-library",
            icon: Icon::LINK_2,
            title: t!("Linked library"),
            body,
            actions,
            scrim_closes: changes == 0 && !self.busy,
        }
        .render(window, cx, move |_, cx| {
            view.update(cx, |this, cx| this.close(cx)).ok();
        })
    }
}
