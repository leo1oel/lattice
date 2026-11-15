//! Settings › Integrations › Literature services (`literature-settings.tsx`):
//! whether adding a paper saves its full text, a personal key for OpenAlex,
//! Semantic Scholar and Firecrawl, and the contact address Crossref is sent.
//!
//! The keys go to the keychain through lattice-core (`literature_credentials`,
//! the Tauri app's `get_literature_credentials`, `set_literature_credential`,
//! `set_literature_contact` and `test_literature_credential`), under the same
//! entry the Tauri app uses, and are never read back: the page learns only
//! where each service's key comes from. A failure never shows the backend's
//! words, which may hold a URL or a key.

use gpui::{
    AnyElement, AppContext as _, Context, ElementId, Entity, ParentElement as _, SharedString,
    Styled as _, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::literature_credentials as credentials;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon,
    components::{Button, Field},
};
use serde_json::{Value, json};

use super::{
    controls::{self, Level, PageWidth, Row, Wrap},
    dialog::SettingsDialog,
    editor_pane::row,
};

/// The services with a personal key, in the page's order.
const PROVIDERS: [(&str, &str, &str); 3] = [
    ("openalex", "OpenAlex", "https://openalex.org/settings/api"),
    (
        "semanticscholar",
        "Semantic Scholar",
        "https://www.semanticscholar.org/product/api",
    ),
    (
        "firecrawl",
        "Firecrawl",
        "https://www.firecrawl.dev/app/api-keys",
    ),
];

/// Where a message belongs: a service's group, Crossref's, or the page.
type Target = &'static str;

struct Notice {
    target: Target,
    level: Level,
    text: SharedString,
}

pub struct LiteraturePane {
    /// Where each key comes from, and the Crossref address.
    credentials: Option<Value>,
    drafts: [Entity<InputState>; 3],
    email: Entity<InputState>,
    busy: Option<Target>,
    notice: Option<Notice>,
    _task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

/// Settings › Literature services, read from the keychain the first time it
/// is drawn.
pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let pane = dialog
        .pages
        .literature
        .get_or_insert_with(|| cx.new(|cx| LiteraturePane::new(window, cx)))
        .clone();
    let full_text = full_text_group(dialog, width, cx);
    let marks = super::pages::marks(dialog);
    pane.update(cx, |pane, cx| {
        pane.render_page(full_text, width, &marks, window, cx)
    })
}

/// The Add papers sheet's choice, shared with it (`save-full-text-setting.ts`).
fn full_text_group(
    dialog: &SettingsDialog,
    width: PageWidth,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let on = super::get(cx).save_full_text;
    controls::first_group(
        Some(t!("Adding papers").into()),
        vec![row(
            dialog,
            Row::new("literature-full-text", t!("Also save full text (Markdown)"))
                .description(
                    t!("When off, adding a paper adds only its citation. Its full text can still be saved later from the paper’s row."),
                    cx,
                )
                .control(controls::switch(
                    "literature-full-text",
                    on,
                    false,
                    |on, _, cx| super::update(cx, |settings| settings.save_full_text = on),
                ))
                .wrap(Wrap::Never),
            width,
            cx,
        )],
        cx,
    )
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

impl LiteraturePane {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let masked = |window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).masked(true))
        };
        let drafts = [masked(window, cx), masked(window, cx), masked(window, cx)];
        let email = cx.new(|cx| InputState::new(window, cx).placeholder(t!("name@example.org")));
        let mut subscriptions = Vec::new();
        for input in drafts.iter().chain([&email]) {
            subscriptions.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    this.notice = None;
                    cx.notify();
                }
            }));
        }
        let mut pane = Self {
            credentials: None,
            drafts,
            email,
            busy: Some("load"),
            notice: None,
            _task: None,
            _subscriptions: subscriptions,
        };
        pane.load(window, cx);
        pane
    }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let read = cx.background_spawn(async {
            lattice_core::runtime::block_on(credentials::get_literature_credentials())
                .and_then(to_value)
        });
        let handle = window.window_handle();
        self._task = Some(cx.spawn(async move |this, cx| {
            let status = read.await;
            cx.update_window(handle, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.busy = None;
                    match status {
                        Ok(status) => this.adopt(status, window, cx),
                        Err(_) => {
                            this.notice = Some(Notice {
                                target: "load",
                                level: Level::Error,
                                text: t!("Couldn’t read the keychain. Reopen Settings to retry")
                                    .into(),
                            })
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .ok();
        }));
    }

    fn adopt(&mut self, status: Value, window: &mut Window, cx: &mut Context<Self>) {
        let email = status
            .get("crossrefEmail")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.email
            .update(cx, |input, cx| input.set_value(email, window, cx));
        self.credentials = Some(status);
    }

    fn source(&self, provider: &str) -> Option<String> {
        self.credentials
            .as_ref()
            .and_then(|credentials| credentials.get(provider))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn saved_email(&self) -> String {
        self.credentials
            .as_ref()
            .and_then(|credentials| credentials.get("crossrefEmail"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    }

    /// Run one keychain call off the main thread, unless another is under
    /// way; its answer goes to `done` on this window.
    fn run(
        &mut self,
        target: Target,
        work: impl FnOnce() -> Result<Value, String> + Send + 'static,
        done: impl FnOnce(&mut Self, Value, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(target);
        self.notice = None;
        let work = cx.background_spawn(async move { work() });
        let handle = window.window_handle();
        self._task = Some(cx.spawn(async move |this, cx| {
            let result = work.await;
            cx.update_window(handle, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.busy = None;
                    match result {
                        Ok(value) => done(this, value, window, cx),
                        // Never the backend's words: a provider or library
                        // may include a URL or a credential.
                        Err(_) => {
                            this.notice = Some(Notice {
                                target,
                                level: Level::Error,
                                text: t!("That didn’t work. Check the input and keychain access")
                                    .into(),
                            })
                        }
                    }
                    cx.notify();
                })
                .ok();
            })
            .ok();
        }));
        cx.notify();
    }

    fn save(
        &mut self,
        index: usize,
        secret: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (provider, _, _) = PROVIDERS[index];
        let removing = secret.is_none();
        self.run(
            provider,
            move || {
                let provider =
                    serde_json::from_value(json!(provider)).map_err(|error| error.to_string())?;
                lattice_core::runtime::block_on(credentials::set_literature_credential(
                    provider, secret,
                ))
                .and_then(to_value)
            },
            move |this, status, window, cx| {
                this.adopt(status, window, cx);
                this.drafts[index].update(cx, |input, cx| input.set_value("", window, cx));
                this.notice = Some(Notice {
                    target: provider,
                    level: Level::Success,
                    text: if removing {
                        t!("Key removed").into()
                    } else {
                        t!("Key saved to the keychain").into()
                    },
                });
            },
            window,
            cx,
        );
    }

    fn test(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let (provider, _, _) = PROVIDERS[index];
        let draft = self.drafts[index].read(cx).value().trim().to_string();
        let secret = (!draft.is_empty()).then_some(draft);
        self.run(
            provider,
            move || {
                let provider =
                    serde_json::from_value(json!(provider)).map_err(|error| error.to_string())?;
                lattice_core::runtime::block_on(credentials::test_literature_credential(
                    provider, secret,
                ))
                .and_then(to_value)
            },
            move |this, result, _, _| {
                let status = result
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let authenticated = result
                    .get("authenticated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let text = match status {
                    "ok" if authenticated => t!("The key works. Testing doesn’t save it"),
                    "ok" => t!("Connected without a key"),
                    "unauthorized" => t!("Access denied. Check the key"),
                    "rate_limited" => t!("Rate-limited. Try again later"),
                    _ => t!("Couldn’t reach the service"),
                };
                this.notice = Some(Notice {
                    target: provider,
                    level: if status == "ok" {
                        Level::Success
                    } else {
                        Level::Warning
                    },
                    text: text.into(),
                });
            },
            window,
            cx,
        );
    }

    fn save_email(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let email = self.email.read(cx).value().trim().to_string();
        self.run(
            "crossref",
            move || {
                lattice_core::runtime::block_on(credentials::set_literature_contact(email))
                    .and_then(to_value)
            },
            |this, status, window, cx| {
                this.adopt(status, window, cx);
                this.notice = Some(Notice {
                    target: "crossref",
                    level: Level::Success,
                    text: t!("Contact settings saved.").into(),
                });
            },
            window,
            cx,
        );
    }

    /// The notice for `target`, if it has one.
    fn message(&self, target: Target, cx: &gpui::App) -> Option<AnyElement> {
        self.notice
            .as_ref()
            .filter(|notice| notice.target == target)
            .map(|notice| {
                controls::block(
                    controls::inline_message(notice.level, notice.text.clone(), cx),
                    true,
                )
            })
    }

    fn render_page(
        &mut self,
        full_text: AnyElement,
        width: PageWidth,
        marks: &controls::Marks,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let loaded = self.credentials.is_some();
        let disabled = self.busy.is_some() || !loaded;
        let this = cx.entity();
        let loader = |id: &'static str, size| {
            crate::build::chip_mark::infinity_loader(id, px(size), &palette)
        };
        let mut groups = vec![full_text];
        if self.busy == Some("load") {
            groups.push(loader("literature-loading", 16.));
        }
        if let Some(message) = self
            .notice
            .as_ref()
            .filter(|notice| notice.target == "load")
        {
            groups.push(controls::inline_message(
                message.level,
                message.text.clone(),
                cx,
            ));
        }
        // A group per service, titled with its name: the page holds four,
        // so the headings are what it scans by.
        for (index, (provider, name, url)) in PROVIDERS.into_iter().enumerate() {
            let source = self.source(provider);
            let draft_empty = self.drafts[index].read(cx).value().trim().is_empty();
            let described = match source.as_deref() {
                None => t!("Loading…"),
                Some("saved") => t!("Personal key saved"),
                Some("environment") => t!("Using environment key"),
                Some("shared") => t!("Using shared quota"),
                Some("missing") => t!("Not enabled, needs an API key"),
                Some(_) if provider == "semanticscholar" => {
                    t!("Not enabled, needs a personal API key")
                }
                Some(_) => t!("Public access, no key needed"),
            };
            let saved = source.as_deref() == Some("saved");
            let untestable = (provider == "semanticscholar"
                && source.as_deref() == Some("anonymous"))
                || source.as_deref() == Some("missing");
            self.drafts[index].update(cx, |input, cx| input.set_disabled(disabled, cx));
            let get_key = Button::new(
                ElementId::Name(format!("literature-{provider}-get-key").into()),
                t!("Get API key"),
            )
            .compact()
            .ghost()
            .trailing_icon(Icon::EXTERNAL_LINK)
            .disabled(self.busy.is_some())
            .on_click(move |_, _, cx| cx.open_url(url));
            let save = {
                let this = this.clone();
                Button::new(
                    ElementId::Name(format!("literature-{provider}-save").into()),
                    t!("Save"),
                )
                .compact()
                .disabled(disabled || draft_empty)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| {
                        let secret = pane.drafts[index].read(cx).value().trim().to_string();
                        pane.save(index, Some(secret), window, cx)
                    })
                })
            };
            let test = {
                let this = this.clone();
                Button::new(
                    ElementId::Name(format!("literature-{provider}-test").into()),
                    t!("Test connection"),
                )
                .compact()
                .disabled(disabled || (untestable && draft_empty))
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.test(index, window, cx))
                })
            };
            let remove = saved.then(|| {
                let this = this.clone();
                Button::new(
                    ElementId::Name(format!("literature-{provider}-remove").into()),
                    t!("Remove key"),
                )
                .compact()
                .ghost()
                .disabled(disabled)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.save(index, None, window, cx))
                })
            });
            self.drafts[index].update(cx, |input, cx| {
                input.set_placeholder(
                    if saved {
                        t!("Enter a replacement key")
                    } else {
                        t!("Paste your API key")
                    },
                    window,
                    cx,
                )
            });
            let form = div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(Field::new(&self.drafts[index]).disabled(disabled))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(4.))
                        .child(save)
                        .child(test)
                        .children(remove)
                        .when(self.busy == Some(provider), |this| {
                            this.child(loader("literature-working", 14.))
                        }),
                );
            let key_row = Row::new(
                match provider {
                    "openalex" => "literature-openalex",
                    "semanticscholar" => "literature-semanticscholar",
                    _ => "literature-firecrawl",
                },
                t!("API key"),
            )
            .description(described, cx)
            .control(controls::in_column(get_key));
            let mut rows = vec![marks.row(key_row, width, cx), controls::block(form, true)];
            rows.extend(self.message(provider, cx));
            groups.push(controls::group(Some(name.into()), rows, cx));
        }
        // Crossref's contact address.
        self.email
            .update(cx, |input, cx| input.set_disabled(disabled, cx));
        let unchanged = self.email.read(cx).value().trim() == self.saved_email();
        let save_email = {
            let this = this.clone();
            Button::new("literature-email-save", t!("Save"))
                .compact()
                .disabled(disabled || unchanged)
                .on_click(move |_, window, cx| {
                    this.update(cx, |pane, cx| pane.save_email(window, cx))
                })
        };
        let mut rows = vec![
            marks.row(
                Row::new("literature-email", t!("Contact email"))
                    .description(t!("Sent to Crossref"), cx),
                width,
                cx,
            ),
            controls::block(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(Field::new(&self.email).disabled(disabled))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .child(save_email)
                            .when(self.busy == Some("crossref"), |this| {
                                this.child(loader("literature-email-working", 14.))
                            }),
                    ),
                true,
            ),
        ];
        rows.extend(self.message("crossref", cx));
        groups.push(controls::group(Some("Crossref".into()), rows, cx));
        controls::page(t!("Literature services"), width, groups, cx)
    }
}
