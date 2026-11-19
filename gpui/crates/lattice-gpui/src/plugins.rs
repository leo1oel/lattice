//! Plugins (docs/plugins.md): the process's one [`PluginHost`] from
//! lattice-core, the palette's cached list of its commands, and what the
//! shell needs to run one and render what it returns.
//!
//! The host owns installing, granting, the sandbox and the protocol; this
//! app only lists [`PluginHost::commands`] in the palette
//! (`shell/palette/plugin.rs`), runs one off the main thread with a
//! [`CancelToken`], renders its [`CommandResult`] there, performs its
//! actions through the app's own paths (`plugins/actions.rs`), and offers
//! install, enable and remove in Settings › Plugins
//! (`settings/plugins_pane.rs`). The Tauri app does the same over IPC.
//!
//! - `text`: the words that depend on the data (the permissions in plain
//!   language, an error by its code, an action's label), pure and tested;
//! - `results`: a result as the palette's rows (diagnostics grouped by
//!   file), pure and tested;
//! - `markdown`: a message result's CommonMark as elements, raw HTML shown
//!   as text;
//! - `actions`: an action performed in the window.

pub mod actions;
pub mod markdown;
pub mod results;
pub mod text;

#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use futures::channel::mpsc;
use gpui::{App, AppContext as _, AsyncApp, Global, Task};
use lattice_core::{
    host::{Closed, Resources, Sink},
    plugins::{
        CancelToken, CommandResult, PluginCommand, PluginError, PluginHost, RunEvent, RunRequest,
        SecretStore,
    },
};

use crate::structured::resources;

/// The process's host and the palette's rows, read again after every change
/// Settings makes.
struct Plugins {
    host: Arc<PluginHost>,
    commands: Arc<Vec<PluginCommand>>,
    /// Bumped by every refresh, so a slow read never overwrites a newer one.
    revision: u64,
}

impl Global for Plugins {}

/// Secrets a scripted run saves, kept in memory so a scenario never
/// touches the writer's Keychain.
#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<(String, String), String>>);

impl SecretStore for MemorySecrets {
    fn get(&self, plugin: &str, name: &str) -> Result<Option<String>, String> {
        let saved = self.0.lock().map_err(|error| error.to_string())?;
        Ok(saved.get(&(plugin.to_string(), name.to_string())).cloned())
    }

    fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut saved = self.0.lock().map_err(|error| error.to_string())?;
        let key = (plugin.to_string(), name.to_string());
        match value {
            Some(value) => saved.insert(key, value.to_string()),
            None => saved.remove(&key),
        };
        Ok(())
    }
}

/// A Node for `runtime = "node"` plugins when the bundled one is missing,
/// as it is in a checkout without the Synara runtime: `LATTICE_PLUGIN_NODE`,
/// else the first on `PATH`, else Homebrew's, with the folders it links its
/// libraries from as the runtime's reads (the core's own tests do the same).
/// A packaged app always has the bundled Node and never gets here.
fn development_node() -> Option<(PathBuf, Vec<PathBuf>)> {
    let found = std::env::var_os("LATTICE_PLUGIN_NODE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::split_paths(&std::env::var_os("PATH")?)
                .map(|dir| dir.join("node"))
                .find(|path| path.is_file())
        })
        .or_else(|| {
            ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
        })?
        .canonicalize()
        .ok()?;
    let prefix = found.parent()?.parent()?.to_path_buf();
    let reads = [
        prefix,
        PathBuf::from("/opt/homebrew"),
        PathBuf::from("/usr/local"),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .collect();
    Some((found, reads))
}

/// The host: plugins under the app's data folder, secrets in the Keychain
/// (in memory for a scripted run), Node from the bundled runtime.
fn make_host(scripted: bool) -> PluginHost {
    let bundle_dir = resources::agent_bundle();
    let dirs = resources::app_dirs();
    let bundled = bundle_dir.join("synara-runtime/bin/node");
    if bundled.is_file() && !scripted {
        return PluginHost::new(&Resources {
            bundle_dir,
            app_data_dir: dirs.data,
            app_cache_dir: dirs.cache,
        });
    }
    let secrets: Box<dyn SecretStore> = if scripted {
        Box::new(MemorySecrets::default())
    } else {
        Box::new(lattice_core::plugins::KeyringSecrets)
    };
    let (node, reads) = if bundled.is_file() {
        (bundled, Vec::new())
    } else {
        development_node().unwrap_or((bundled, Vec::new()))
    };
    PluginHost::with(dirs.data.join("plugins"), node, reads, secrets)
}

/// The process's host, made on first use.
pub fn host(cx: &mut App) -> Arc<PluginHost> {
    if let Some(plugins) = cx.try_global::<Plugins>() {
        return plugins.host.clone();
    }
    let mut host = make_host(crate::settings::scripted(cx));
    // The plugin market's list and its block list, from the registry the
    // theme marketplace reads (the same signed files and cache).
    host.set_registry(Arc::new(crate::settings::registry()));
    let host = Arc::new(host);
    cx.set_global(Plugins {
        host: host.clone(),
        commands: Arc::default(),
        revision: 0,
    });
    refresh(cx).detach();
    host
}

/// The palette's plugin rows as last read: every enabled, still granted
/// plugin's commands (none where plugins cannot run).
pub fn commands(cx: &mut App) -> Arc<Vec<PluginCommand>> {
    host(cx);
    cx.global::<Plugins>().commands.clone()
}

/// Read the palette's rows again, off the main thread; a palette opened
/// after it lands lists them.
pub fn refresh(cx: &mut App) -> Task<()> {
    let host = host(cx);
    let revision = {
        let plugins = cx.global_mut::<Plugins>();
        plugins.revision += 1;
        plugins.revision
    };
    let read = cx.background_spawn(async move { host.commands() });
    cx.spawn(async move |cx: &mut AsyncApp| {
        let commands = read.await;
        cx.update(|cx| {
            let plugins = cx.global_mut::<Plugins>();
            if plugins.revision == revision {
                plugins.commands = Arc::new(commands);
            }
        });
    })
}

/// What a running command reports to the palette.
pub enum Update {
    Progress(String),
    Done(Result<CommandResult, PluginError>),
}

/// Run `request` on a background thread. Its progress and then its outcome
/// come through the returned stream; `cancel` stops it.
pub fn run(
    request: RunRequest,
    cancel: CancelToken,
    cx: &mut App,
) -> mpsc::UnboundedReceiver<Update> {
    let host = host(cx);
    let (sender, receiver) = mpsc::unbounded();
    cx.background_spawn(async move {
        let progress = Mutex::new(sender.clone());
        let sink = move |event: RunEvent| -> Result<(), Closed> {
            if let RunEvent::Progress { message, .. } = event {
                let sender = progress.lock().map_err(|_| Closed)?;
                sender
                    .unbounded_send(Update::Progress(message))
                    .map_err(|_| Closed)?;
            }
            Ok(())
        };
        let outcome = host.run(request, &sink as &dyn Sink<RunEvent>, &cancel);
        sender.unbounded_send(Update::Done(outcome)).ok();
    })
    .detach();
    receiver
}
