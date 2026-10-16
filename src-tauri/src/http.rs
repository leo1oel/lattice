//! Where every blocking `reqwest` client starts, so deadlines, the agent
//! string and proxy use are chosen in one place. Callers add what is specific
//! to them (a redirect policy, a connect timeout) on the returned builder.

use reqwest::blocking::{Client, ClientBuilder};
use std::sync::Once;
use std::time::Duration;

/// Makes `ring` the process's rustls provider. reqwest is built without one
/// of its own (Cargo.toml), and building any client, async or blocking, http
/// or https, panics until one is installed. So clients are built only here
/// (clippy.toml disallows reqwest's own constructors elsewhere), and `run`
/// installs it at startup as well. Idempotent; a provider installed earlier
/// (the updater installs the same one) stays.
pub(crate) fn install_tls_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A blocking client builder with no deadline of its own: prefer [`blocking`].
#[allow(clippy::disallowed_methods)]
pub(crate) fn blocking_builder() -> ClientBuilder {
    install_tls_provider();
    Client::builder()
}

/// An async client builder, the only way to start one.
#[allow(clippy::disallowed_methods)]
pub(crate) fn async_builder() -> reqwest::ClientBuilder {
    install_tls_provider();
    reqwest::Client::builder()
}

/// A blocking client builder with an overall per-request deadline.
pub(crate) fn blocking(timeout: Duration) -> ClientBuilder {
    blocking_builder().timeout(timeout)
}

/// [`blocking`], identifying itself as `user_agent`.
pub(crate) fn blocking_as(user_agent: &str, timeout: Duration) -> ClientBuilder {
    blocking(timeout).user_agent(user_agent)
}

/// [`blocking`] for the app's own loopback services (the agent sidecar, the
/// Open Slide server). Never routed through HTTP(S)_PROXY or ALL_PROXY, which
/// can make a healthy local server look unreachable.
pub(crate) fn loopback(timeout: Duration) -> ClientBuilder {
    blocking(timeout).no_proxy()
}
