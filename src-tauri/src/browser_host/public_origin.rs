//! `--browser-public-origin <origin>`: an origin that a reverse proxy, run by
//! whoever launched Lattice, serves the browser host at.
//!
//! Without the option nothing here accepts anything, and the host behaves as
//! it always has: only `http://127.0.0.1:<port>` (or the development server's
//! origin) may load the page, ask for a session, read project PDFs or attach
//! a tab to the bridge. Each configured origin is accepted *in addition*, by
//! exact comparison only, in the same places: as the `Host` of a request (a
//! proxy that keeps the browser's `Host`) and as the `Origin` a tab sends.
//! There are no wildcards, patterns or suffix matches, and the listener still
//! binds to 127.0.0.1 alone; reaching it from elsewhere, and authenticating
//! whoever does, stays the proxy's job.
//!
//! The browser host has no authentication of its own. Once an origin is
//! configured, the proxy's authentication is the only gate in front of the
//! session token, and the token reaches the project's files and the terminal.
//! An `http://` origin that is not loopback sends that token (`?token=`) and
//! everything else without TLS; the host starts with it but logs a warning.
//!
//! The option may be given more than once, one exact origin each, for a proxy
//! that answers at several names. A value is accepted only when it is already
//! written the way a browser serializes an origin in its `Origin` header
//! (`https://lattice.example` or `http://10.0.0.2:8080`: lowercase, no default
//! port, no trailing slash, path, query, fragment or credentials), so the
//! comparison with what browsers send can stay a plain string equality. An
//! invalid value stops the browser host from starting at all rather than
//! being skipped.

use std::{ffi::OsString, sync::Arc};

const OPTION: &str = "--browser-public-origin";

/// The exact origins accepted besides the loopback entry; empty by default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct PublicOrigins(Arc<[PublicOrigin]>);

#[derive(Debug, PartialEq, Eq)]
struct PublicOrigin {
    /// `scheme://host[:port]`, as browsers send it in `Origin`.
    origin: String,
    /// `host[:port]`, as browsers send it in `Host`.
    authority: String,
    /// `http://` to a host that is not loopback.
    without_tls: bool,
}

impl PublicOrigins {
    /// Read every `--browser-public-origin` value from the process arguments
    /// (`args` excludes the program name).
    pub(super) fn from_args(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let mut origins = Vec::new();
        while let Some(argument) = args.next() {
            let value = if argument == OPTION {
                args.next().ok_or_else(|| format!("{OPTION} needs an origin after it."))?
            } else if let Some(value) = argument
                .to_str()
                .and_then(|argument| argument.strip_prefix(OPTION)?.strip_prefix('='))
            {
                OsString::from(value)
            } else {
                continue;
            };
            let value = value
                .into_string()
                .map_err(|value| format!("{OPTION} {value:?} is not a valid origin."))?;
            let origin = parse(&value)?;
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        Ok(Self(origins.into()))
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether `origin` (an `Origin` header) is exactly a configured origin.
    pub(super) fn accepts_origin(&self, origin: &str) -> bool {
        self.0.iter().any(|allowed| allowed.origin == origin)
    }

    /// Whether `host` (a `Host` header) is exactly a configured origin's host
    /// and port.
    pub(super) fn accepts_host(&self, host: &str) -> bool {
        self.0.iter().any(|allowed| allowed.authority == host)
    }

    /// The configured origins, for the startup log.
    pub(super) fn describe(&self) -> String {
        self.0.iter().map(|allowed| allowed.origin.as_str()).collect::<Vec<_>>().join(", ")
    }

    /// Configured `http://` origins whose host is not loopback: their traffic,
    /// the session token included, crosses the network without TLS.
    pub(super) fn without_tls(&self) -> Vec<&str> {
        self.0
            .iter()
            .filter(|allowed| allowed.without_tls)
            .map(|allowed| allowed.origin.as_str())
            .collect()
    }
}

fn parse(value: &str) -> Result<PublicOrigin, String> {
    let invalid = |why: &str| format!("{OPTION} {value:?} is not accepted: {why}.");
    let url = tauri::Url::parse(value).map_err(|error| invalid(&error.to_string()))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(invalid("the scheme must be https or http"));
    }
    let host = url.host_str().unwrap_or_default();
    // WHATWG URL parsing allows characters such as `*` in a domain; an origin
    // here must name one host, never a pattern. An IPv4 address passes as
    // labels of digits; an IPv6 one is bracketed, and the parser checked it.
    if !host.starts_with('[') && !host.split('.').all(dns_label) {
        return Err(invalid("the host must be a DNS name or an IP address"));
    }
    let origin = url.origin().ascii_serialization();
    // Anything the origin does not keep (credentials, a path, a query, a
    // fragment, a trailing slash) or writes differently (case, a default
    // port, an IDN) makes the value unequal to it.
    if origin != value {
        return Err(invalid(&format!(
            "write exactly the origin a browser sends, such as {origin:?}, with no path, query or credentials"
        )));
    }
    let authority = origin[url.scheme().len() + "://".len()..].to_string();
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    let without_tls = url.scheme() == "http" && !loopback;
    Ok(PublicOrigin { origin, authority, without_tls })
}

fn dns_label(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins(args: &[&str]) -> Result<PublicOrigins, String> {
        PublicOrigins::from_args(args.iter().map(OsString::from))
    }

    #[test]
    fn nothing_is_accepted_without_the_option() {
        let none = origins(&["--browser-host"]).unwrap();
        assert!(none.is_empty());
        assert!(!none.accepts_origin("http://127.0.0.1:18452"));
        assert!(!none.accepts_host("127.0.0.1:18452"));
        assert!(!none.accepts_origin("null"));
        assert!(!none.accepts_host(""));
    }

    #[test]
    fn each_value_is_one_exact_origin_and_its_host() {
        let configured = origins(&[
            "--browser-host",
            "--browser-public-origin",
            "https://lattice.example",
            "--browser-public-origin=http://10.0.0.2:8080",
            "--browser-public-origin",
            "https://[fd00::2]:8443",
        ])
        .unwrap();
        assert_eq!(
            configured.describe(),
            "https://lattice.example, http://10.0.0.2:8080, https://[fd00::2]:8443"
        );
        for (origin, host) in [
            ("https://lattice.example", "lattice.example"),
            ("http://10.0.0.2:8080", "10.0.0.2:8080"),
            ("https://[fd00::2]:8443", "[fd00::2]:8443"),
        ] {
            assert!(configured.accepts_origin(origin), "{origin}");
            assert!(configured.accepts_host(host), "{host}");
        }
        // Exact values only: no other scheme, port, subdomain, suffix or case.
        for origin in [
            "http://lattice.example",
            "https://lattice.example:443",
            "https://lattice.example:8443",
            "https://www.lattice.example",
            "https://lattice.example.attacker.example",
            "https://attacker-lattice.example",
            "https://LATTICE.example",
            "https://lattice.example/",
            "http://10.0.0.2",
            "null",
            "",
        ] {
            assert!(!configured.accepts_origin(origin), "{origin}");
        }
        for host in [
            "lattice.example:443",
            "LATTICE.example",
            "lattice.example.",
            "www.lattice.example",
            "10.0.0.2",
            "[FD00::2]:8443",
            "attacker.example",
        ] {
            assert!(!configured.accepts_host(host), "{host}");
        }
    }

    #[test]
    fn values_that_are_not_exactly_an_origin_are_refused() {
        for value in [
            "lattice.example",
            "https://",
            "https://*.lattice.example",
            "https://lattice.*",
            "https://lattice.example/",
            "https://lattice.example/lattice",
            "https://lattice.example?x=1",
            "https://lattice.example#x",
            "https://user:pass@lattice.example",
            "https://user@lattice.example",
            "https://Lattice.example",
            "https://lattice.example:443",
            "http://lattice.example:80",
            "https://lattice..example",
            "https://-lattice.example",
            "https://lattice_example.com",
            "https://lättice.example",
            "https://lattice.example.",
            "https://[FD00::2]:8443",
            "https://[fd00:0::2]:8443",
            "ws://lattice.example",
            "file:///tmp/lattice",
            "null",
            "",
        ] {
            assert!(origins(&["--browser-public-origin", value]).is_err(), "{value}");
            assert!(origins(&[&format!("--browser-public-origin={value}")]).is_err(), "{value}");
        }
        // A name already in punycode is exactly its origin, and accepted.
        let punycode =
            origins(&["--browser-public-origin", "https://xn--lttice-gua.example"]).unwrap();
        assert!(punycode.accepts_origin("https://xn--lttice-gua.example"));
        assert!(punycode.accepts_host("xn--lttice-gua.example"));
        // A missing value is an error, not an empty list.
        assert!(origins(&["--browser-public-origin"]).is_err());
    }

    #[test]
    fn plain_http_is_flagged_unless_it_stays_on_loopback() {
        let configured = origins(&[
            "--browser-public-origin=https://lattice.example",
            "--browser-public-origin=http://10.0.0.2:8080",
            "--browser-public-origin=http://lattice.lan",
            "--browser-public-origin=http://localhost:8080",
            "--browser-public-origin=http://127.0.0.1:8080",
            "--browser-public-origin=http://[::1]:8080",
        ])
        .unwrap();
        assert_eq!(configured.without_tls(), ["http://10.0.0.2:8080", "http://lattice.lan"]);
    }
}
