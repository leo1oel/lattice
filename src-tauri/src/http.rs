//! Where every blocking `reqwest` client starts, so deadlines, the agent
//! string and proxy use are chosen in one place. Callers add what is specific
//! to them (a redirect policy, a connect timeout) on the returned builder.

use reqwest::blocking::{Client, ClientBuilder};
use std::time::Duration;

/// A blocking client builder with an overall per-request deadline.
pub(crate) fn blocking(timeout: Duration) -> ClientBuilder {
    Client::builder().timeout(timeout)
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
