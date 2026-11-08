//! Trusted local command plugins. These are ordinary user processes, not a sandbox.
//! A plugin is linked by its canonical directory and is disabled on install.
mod registry;
pub(crate) mod runner;
#[cfg(test)]
mod tests;

pub(crate) use registry::{install, list, remove, set_enabled};
pub(crate) use runner::run;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub commands: Vec<PluginCommand>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PluginCommand {
    pub id: String,
    pub title: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Plugin {
    pub manifest: Manifest,
    pub path: String,
    pub enabled: bool,
}
