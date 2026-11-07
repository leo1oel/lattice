//! System proxy translation is macOS-only (SCDynamicStore). On Linux the
//! sidecar inherits the process environment as-is.

use super::environment::SystemProxy;

pub(super) fn watch_system_proxy(_on_change: impl Fn() + Send + 'static) {}

pub(super) fn system_proxy() -> Option<SystemProxy> {
    None
}
