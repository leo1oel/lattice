//! System proxy translation is macOS-only (SCDynamicStore). On Linux the
//! sidecar inherits the process environment as-is.

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SystemProxy {
    pub(super) http_proxy: Option<String>,
    pub(super) https_proxy: Option<String>,
    pub(super) no_proxy: String,
}

pub(super) fn system_proxy_variables(
    proxy: &SystemProxy, is_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, String)> {
    let is_set = |keys: [&str; 2]| keys.into_iter().any(&is_set);
    let mut variables = Vec::new();
    if is_set(["ALL_PROXY", "all_proxy"]) {
        return variables;
    }
    for (key, lowercase, value) in [
        ("HTTP_PROXY", "http_proxy", &proxy.http_proxy),
        ("HTTPS_PROXY", "https_proxy", &proxy.https_proxy),
    ] {
        if let Some(value) = value.as_ref().filter(|_| !is_set([key, lowercase])) {
            variables.push((key, value.clone()));
        }
    }
    if !variables.is_empty() && !is_set(["NO_PROXY", "no_proxy"]) {
        variables.push(("NO_PROXY", proxy.no_proxy.clone()));
    }
    variables
}

pub(super) fn watch_system_proxy(_on_change: impl Fn() + Send + 'static) {}

pub(super) fn system_proxy() -> Option<SystemProxy> {
    None
}
