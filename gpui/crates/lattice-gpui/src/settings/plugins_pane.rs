//! Settings › Integrations › Plugins (docs/plugins.md, `plugin-settings.tsx`
//! in the Tauri app): install from a release URL with its SHA-256 or from a
//! folder (for developing a plugin), then one card per plugin: its name,
//! version, id, description, licence and source, a switch, what it may
//! access in plain words, a field per secret it declares, and Remove.
//!
//! Turning a plugin on grants what its manifest asks for now, so it first
//! asks, listing those permissions; so does a plugin that asks for more
//! since it was turned on (`needsReview`). Off macOS plugins are listed but
//! do not run, and the switches are dimmed. Every host call runs off the
//! main thread; the palette's rows are read again after each change.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use gpui::{AnyElement, AppContext as _, Context, Entity, Subscription, Task, Window};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_core::plugins::{PluginHost, PluginInfo};
use lattice_i18n::t;

mod view;

use super::{
    controls::{self, Level, PageWidth},
    dialog::SettingsDialog,
};
use crate::{
    confirm::{self, Confirm},
    plugins::{self, text},
};

/// Where a message belongs: the install form, or a plugin's card.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Install,
    Plugin(String),
}

pub struct PluginsPane {
    plugins: Option<Vec<PluginInfo>>,
    url_open: bool,
    url: Entity<InputState>,
    sha256: Entity<InputState>,
    /// A field per declared secret, by plugin and name.
    secrets: HashMap<(String, String), Entity<InputState>>,
    busy: Option<Target>,
    errors: HashMap<Target, String>,
    _task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

pub fn render(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    let pane = dialog
        .pages
        .plugins
        .get_or_insert_with(|| cx.new(|cx| PluginsPane::new(window, cx)))
        .clone();
    let marks = super::pages::marks(dialog);
    pane.update(cx, |pane, cx| pane.render_page(width, &marks, cx))
}

impl PluginsPane {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let url = cx.new(|cx| {
            InputState::new(window, cx).placeholder("https://example.org/plugin-1.0.0.zip")
        });
        let sha256 =
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("SHA-256 of the .zip")));
        let mut subscriptions = Vec::new();
        for input in [&url, &sha256] {
            subscriptions.push(cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    this.errors.remove(&Target::Install);
                    cx.notify();
                }
            }));
        }
        let mut pane = Self {
            plugins: None,
            url_open: false,
            url,
            sha256,
            secrets: HashMap::new(),
            busy: None,
            errors: HashMap::new(),
            _task: None,
            _subscriptions: subscriptions,
        };
        pane.call(Target::Install, |_| Ok(()), window, cx);
        pane
    }

    /// Run one host call off the main thread, unless another is under way;
    /// then read the list again and the palette's rows. A failure shows by
    /// `target`.
    fn call(
        &mut self,
        target: Target,
        work: impl FnOnce(&PluginHost) -> Result<(), String> + Send + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(target.clone());
        self.errors.remove(&target);
        let host: Arc<PluginHost> = plugins::host(cx);
        let work = cx.background_spawn(async move {
            let done = work(&host);
            (done, host.list())
        });
        let handle = window.window_handle();
        self._task = Some(cx.spawn(async move |this, cx| {
            let (done, list) = work.await;
            cx.update_window(handle, |_, window, cx| {
                this.update(cx, |this, cx| {
                    this.busy = None;
                    if let Err(error) = done {
                        this.errors.insert(target.clone(), error);
                    } else if target == Target::Install && this.url_open {
                        this.url
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.sha256
                            .update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    match list {
                        Ok(list) => this.adopt(list, window, cx),
                        Err(error) => {
                            this.errors.insert(Target::Install, error);
                        }
                    }
                    plugins::refresh(cx).detach();
                    cx.notify();
                })
                .ok();
            })
            .ok();
        }));
        cx.notify();
    }

    fn adopt(&mut self, list: Vec<PluginInfo>, window: &mut Window, cx: &mut Context<Self>) {
        for plugin in &list {
            for secret in &plugin.secrets {
                self.secrets
                    .entry((plugin.id.clone(), secret.name.clone()))
                    .or_insert_with(|| cx.new(|cx| InputState::new(window, cx).masked(true)));
            }
        }
        self.plugins = Some(list);
    }

    fn install_url(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = self.url.read(cx).value().trim().to_string();
        let sha = self.sha256.read(cx).value().trim().to_string();
        self.call(
            Target::Install,
            move |host| host.install_url(&url, &sha).map(|_| ()),
            window,
            cx,
        );
    }

    /// Install the plugin in `folder` (the folder picker's choice, or a
    /// scenario's).
    pub fn install_folder(&mut self, folder: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.call(
            Target::Install,
            move |host| host.install_folder(&folder).map(|_| ()),
            window,
            cx,
        );
    }

    fn pick_folder(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some(t!("Install plugin").into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            let Some(window) = cx.update(|cx| cx.active_window()) else {
                return;
            };
            cx.update_window(window, |_, window, cx| {
                this.update(cx, |this, cx| this.install_folder(folder, window, cx))
                    .ok();
            })
            .ok();
        })
        .detach();
    }

    /// Turn `plugin` on after the writer reads what it may access, or off.
    pub fn set_enabled(
        &mut self,
        plugin: &PluginInfo,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = plugin.id.clone();
        if !on {
            self.call(
                Target::Plugin(id.clone()),
                move |host| host.set_enabled(&id, false).map(|_| ()),
                window,
                cx,
            );
            return;
        }
        let lines = text::permission_lines(&plugin.permissions);
        let body = format!(
            "{}\n{}",
            t!("It will be able to:"),
            lines
                .iter()
                .map(|line| format!("• {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let pane = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(t!("Turn on “{0}”?", plugin.name))
                .body(body)
                .confirm_label(t!("Turn on"))
                .on_confirm(move |window, cx| {
                    let id = id.clone();
                    pane.update(cx, |pane, cx| {
                        let target = Target::Plugin(id.clone());
                        pane.call(
                            target,
                            move |host| host.set_enabled(&id, true).map(|_| ()),
                            window,
                            cx,
                        )
                    })
                    .ok();
                }),
            cx,
        );
    }

    fn remove(&mut self, plugin: &PluginInfo, cx: &mut Context<Self>) {
        let id = plugin.id.clone();
        let pane = cx.entity().downgrade();
        confirm::ask(
            Confirm::new(t!("Remove “{0}”?", plugin.name))
                .body(t!("Its data and saved secrets are deleted too."))
                .confirm_label(t!("Remove"))
                .destructive()
                .on_confirm(move |window, cx| {
                    let id = id.clone();
                    pane.update(cx, |pane, cx| {
                        pane.call(
                            Target::Plugin(id.clone()),
                            move |host| host.remove(&id),
                            window,
                            cx,
                        )
                    })
                    .ok();
                }),
            cx,
        );
    }

    fn save_secret(
        &mut self,
        id: String,
        name: String,
        value: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(input) = self.secrets.get(&(id.clone(), name.clone())) {
            input.update(cx, |input, cx| input.set_value("", window, cx));
        }
        self.call(
            Target::Plugin(id.clone()),
            move |host| host.set_secret(&id, &name, value.as_deref()).map(|_| ()),
            window,
            cx,
        );
    }

    /// The installed plugins as last read, for a scenario.
    pub fn listed(&self) -> Vec<PluginInfo> {
        self.plugins.clone().unwrap_or_default()
    }

    pub fn is_busy(&self) -> bool {
        self.busy.is_some()
    }

    /// The install form's error, for a scenario.
    pub fn install_error(&self) -> Option<String> {
        self.errors.get(&Target::Install).cloned()
    }

    fn message(&self, target: &Target, cx: &gpui::App) -> Option<AnyElement> {
        self.errors.get(target).map(|error| {
            controls::block(
                controls::inline_message(Level::Error, error.clone(), cx),
                true,
            )
        })
    }
}
