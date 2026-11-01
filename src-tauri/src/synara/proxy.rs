//! System proxy settings for the sidecar's provider CLIs.
//!
//! Provider CLIs are ordinary child processes and do not use CFNetwork, so a
//! Finder-launched app translates macOS's system proxy into their environment,
//! without overriding any proxy variable the user already set
//! (`environment`). The sidecar reads it once, as it starts, so a change is
//! watched for and offered as a restart.

use std::collections::BTreeSet;
use system_configuration::core_foundation::array::CFArray;
use system_configuration::core_foundation::base::{CFType, CFTypeRef, TCFType};
use system_configuration::core_foundation::dictionary::CFDictionary;
use system_configuration::core_foundation::number::CFNumber;
use system_configuration::core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use system_configuration::core_foundation::string::{CFString, CFStringRef};
use system_configuration::dynamic_store::{
    SCDynamicStore, SCDynamicStoreBuilder, SCDynamicStoreCallBackContext,
};
use system_configuration::sys::schema_definitions::{
    kSCPropNetProxiesExceptionsList, kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort,
    kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort,
    kSCPropNetProxiesHTTPSProxy,
};

/// Where configd publishes the proxy settings of the active network service.
const PROXIES_KEY: &str = "State:/Network/Global/Proxies";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SystemProxy {
    pub(super) http_proxy: Option<String>,
    pub(super) https_proxy: Option<String>,
    pub(super) no_proxy: String,
}

/// The variables `proxy` sets, skipping any `is_set` reports in either
/// spelling, and all of them when `ALL_PROXY` is set.
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

/// Call `on_change` on a thread of its own whenever the system proxy
/// settings change, for as long as Lattice runs.
pub(super) fn watch_system_proxy(on_change: impl Fn() + Send + 'static) {
    fn changed(_: SCDynamicStore, _: CFArray<CFString>, on_change: &mut Box<dyn Fn() + Send>) {
        on_change();
    }
    let on_change: Box<dyn Fn() + Send> = Box::new(on_change);
    let _ = std::thread::Builder::new().name("system-proxy-watch".into()).spawn(move || {
        let context = SCDynamicStoreCallBackContext { callout: changed, info: on_change };
        let Some(store) = SCDynamicStoreBuilder::new("Lattice Synara proxy watch")
            .callback_context(context)
            .build()
        else {
            return;
        };
        let keys = CFArray::from_CFTypes(&[CFString::new(PROXIES_KEY)]);
        let patterns = CFArray::<CFString>::from_CFTypes(&[]);
        let Some(source) = store
            .set_notification_keys(&keys, &patterns)
            .then(|| store.create_run_loop_source())
            .flatten()
        else {
            return;
        };
        let run_loop = CFRunLoop::get_current();
        // SAFETY: a constant CoreFoundation exports for exactly this use.
        run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });
        CFRunLoop::run_current();
    });
}

fn proxy_bypass_list(exceptions: Vec<String>) -> String {
    let mut entries = BTreeSet::from(["localhost", "127.0.0.1", "::1"].map(String::from));
    entries.extend(
        exceptions
            .iter()
            .map(|exception| exception.trim())
            .filter(|exception| !exception.is_empty() && *exception != "<local>")
            .map(|exception| {
                exception
                    .strip_prefix("*.")
                    .map_or_else(|| exception.to_string(), |domain| format!(".{domain}"))
            }),
    );
    entries.into_iter().collect::<Vec<_>>().join(",")
}

pub(super) fn system_proxy() -> Option<SystemProxy> {
    let store = SCDynamicStoreBuilder::new("Lattice Synara provider proxy").build()?;
    let settings = store.get_proxies()?;
    let (http, https, exceptions_key) = unsafe {
        (
            [kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPProxy, kSCPropNetProxiesHTTPPort],
            [kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSProxy, kSCPropNetProxiesHTTPSPort],
            kSCPropNetProxiesExceptionsList,
        )
    };
    let http_proxy = proxy_url(&settings, http);
    let https_proxy = proxy_url(&settings, https);
    if http_proxy.is_none() && https_proxy.is_none() {
        return None;
    }
    let exceptions = settings
        .find(exceptions_key)
        .and_then(|value| value.downcast::<CFArray>())
        .map(|values| {
            values
                .get_all_values()
                .into_iter()
                .filter_map(|value| {
                    let value = unsafe { CFType::wrap_under_get_rule(value as CFTypeRef) };
                    value.downcast::<CFString>().map(|value| value.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(SystemProxy { http_proxy, https_proxy, no_proxy: proxy_bypass_list(exceptions) })
}

fn proxy_url(
    settings: &CFDictionary<CFString, CFType>, [enabled, host, port]: [CFStringRef; 3],
) -> Option<String> {
    let number = |key: CFStringRef| {
        settings.find(key).and_then(|value| value.downcast::<CFNumber>())?.to_i32()
    };
    if number(enabled) != Some(1) {
        return None;
    }
    let host = settings
        .find(host)
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())?;
    let port = number(port).filter(|value| (1..=u16::MAX.into()).contains(value))?;
    let host = if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host
    };
    Some(format!("http://{host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_system_proxy_without_overriding_explicit_environment() {
        let proxy = SystemProxy {
            http_proxy: Some("http://127.0.0.1:7897".to_string()),
            https_proxy: Some("http://127.0.0.1:7897".to_string()),
            no_proxy: "localhost,127.0.0.1,::1".to_string(),
        };
        assert_eq!(
            system_proxy_variables(&proxy, |key| key == "http_proxy"),
            [
                ("HTTPS_PROXY", "http://127.0.0.1:7897".to_string()),
                ("NO_PROXY", "localhost,127.0.0.1,::1".to_string()),
            ]
        );
        assert!(system_proxy_variables(&proxy, |key| key == "ALL_PROXY").is_empty());
    }

    #[test]
    fn normalizes_system_proxy_bypass_entries_for_cli_children() {
        assert_eq!(
            proxy_bypass_list(vec![
                "*.local".to_string(),
                "<local>".to_string(),
                "10.0.0.0/8".to_string(),
            ]),
            ".local,10.0.0.0/8,127.0.0.1,::1,localhost"
        );
    }
}
