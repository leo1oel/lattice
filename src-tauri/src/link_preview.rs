use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::{header, redirect::Policy, Client, StatusCode, Url};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

const USER_AGENT: &str = "ResearchWriter-LinkPreview/1.0";
const PAGE_LIMIT: usize = 512 * 1024;
const ICON_LIMIT: usize = 100 * 1024;

#[derive(Serialize)]
#[serde(untagged)]
pub enum LinkPreviewResult {
    Success { ok: bool, metadata: LinkMetadata },
    Failure { ok: bool, reason: &'static str },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkMetadata {
    domain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon_data_uri: Option<String>,
}

#[tauri::command]
pub async fn link_preview(url: String) -> LinkPreviewResult {
    match tokio::time::timeout(Duration::from_millis(5000), preview(&url)).await {
        Ok(Ok(metadata)) => LinkPreviewResult::Success { ok: true, metadata },
        _ => LinkPreviewResult::Failure {
            ok: false,
            reason: "blocked",
        },
    }
}

async fn preview(input: &str) -> Result<LinkMetadata, ()> {
    let original = clean_url(Url::parse(input).map_err(|_| ())?)?;
    let domain = display_domain(&original)?;
    let (final_url, html) = fetch_page(original).await?;
    let extracted = extract_metadata(&html);
    let icon_url = extracted
        .favicon
        .as_deref()
        .and_then(|href| final_url.join(href).ok())
        .or_else(|| final_url.join("/favicon.ico").ok());
    let favicon_data_uri = match icon_url {
        Some(url) => tokio::time::timeout(Duration::from_millis(2500), fetch_icon(url))
            .await
            .ok()
            .and_then(Result::ok),
        None => None,
    };
    Ok(LinkMetadata {
        domain,
        title: extracted.title,
        description: extracted.description,
        site_name: extracted.site_name,
        favicon_data_uri,
    })
}

fn clean_url(mut url: Url) -> Result<Url, ()> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(());
    }
    url.set_username("").map_err(|_| ())?;
    url.set_password(None).map_err(|_| ())?;
    url.set_fragment(None);
    Ok(url)
}

async fn client_for(url: &Url) -> Result<Client, ()> {
    let host = url.host_str().ok_or(())?;
    let port = url.port_or_known_default().ok_or(())?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(());
    }
    Client::builder()
        .redirect(Policy::none())
        .resolve(host, addresses[0])
        .build()
        .map_err(|_| ())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip == Ipv4Addr::BROADCAST
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 0)
        || (a == 255 && b == 255 && c == 255 && d == 255))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || segments[0] == 0x2002
        || (segments[0..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff))
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

async fn request(url: &Url, accept: &str) -> Result<reqwest::Response, ()> {
    client_for(url)
        .await?
        .get(url.clone())
        .header(header::ACCEPT, accept)
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|_| ())
}

async fn fetch_page(mut url: Url) -> Result<(Url, String), ()> {
    for hop in 0..=3 {
        url = clean_url(url)?;
        let response = request(&url, "text/html").await?;
        if is_redirect(response.status()) {
            if hop == 3 {
                return Err(());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .ok_or(())?
                .to_str()
                .map_err(|_| ())?;
            url = url.join(location).map_err(|_| ())?;
            continue;
        }
        if !response.status().is_success()
            || !content_type(&response).is_some_and(|kind| kind.eq_ignore_ascii_case("text/html"))
        {
            return Err(());
        }
        let bytes = read_head(response).await?;
        return String::from_utf8(bytes)
            .map(|html| (url, html))
            .map_err(|_| ());
    }
    Err(())
}

fn content_type(response: &reqwest::Response) -> Option<&str> {
    response
        .headers()
        .get(header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()
        .map(str::trim)
}

async fn read_head(response: reqwest::Response) -> Result<Vec<u8>, ()> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend_from_slice(&chunk.map_err(|_| ())?);
        let lower = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
        if let Some(index) = lower.find("</head>").or_else(|| lower.find("<body")) {
            if index > PAGE_LIMIT {
                return Err(());
            }
            bytes.truncate(index);
            return Ok(bytes);
        }
        if bytes.len() >= PAGE_LIMIT {
            return Err(());
        }
    }
    Ok(bytes)
}

async fn fetch_icon(mut url: Url) -> Result<String, ()> {
    for hop in 0..=3 {
        url = clean_url(url)?;
        let response = request(&url, "image/*").await?;
        if is_redirect(response.status()) {
            if hop == 3 {
                return Err(());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .ok_or(())?
                .to_str()
                .map_err(|_| ())?;
            url = url.join(location).map_err(|_| ())?;
            continue;
        }
        let declared = content_type(&response).ok_or(())?.to_ascii_lowercase();
        if !response.status().is_success() || !declared.starts_with("image/") {
            return Err(());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ())?;
            if bytes.len() + chunk.len() > ICON_LIMIT {
                return Err(());
            }
            bytes.extend_from_slice(&chunk);
        }
        let mime = sniff_image(&bytes).ok_or(())?;
        return Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
    }
    Err(())
}

fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        None
    }
}

#[derive(Default)]
struct Extracted {
    title: Option<String>,
    description: Option<String>,
    site_name: Option<String>,
    favicon: Option<String>,
}

fn extract_metadata(html: &str) -> Extracted {
    let tag_re = regex::Regex::new(r"(?is)<!--.*?-->|<script\b.*?</script\s*>|<style\b.*?</style\s*>|<template\b.*?</template\s*>|<[^>]+>").expect("valid regex");
    let attr_re =
        regex::Regex::new(r#"(?is)([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
            .expect("valid regex");
    let mut out = Extracted::default();
    let mut fallback_title = None;
    let mut fallback_description = None;
    for found in tag_re.find_iter(html) {
        let tag = found.as_str();
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<title") {
            if let Some(end) = lower.find('>') {
                let rest = &html[found.start() + end + 1..];
                if let Some(close) = rest.to_ascii_lowercase().find("</title") {
                    fallback_title = sanitized(&rest[..close], 200);
                }
            }
        } else if lower.starts_with("<meta") || lower.starts_with("<link") {
            let mut attrs = std::collections::HashMap::new();
            for caps in attr_re.captures_iter(tag) {
                let key = caps[1].to_ascii_lowercase();
                let value = caps
                    .get(2)
                    .or_else(|| caps.get(3))
                    .or_else(|| caps.get(4))
                    .map_or("", |m| m.as_str());
                attrs.entry(key).or_insert(value);
            }
            if lower.starts_with("<meta") {
                let key = attrs
                    .get("property")
                    .or_else(|| attrs.get("name"))
                    .map(|s| s.to_ascii_lowercase());
                let value = attrs.get("content").copied();
                match key.as_deref() {
                    Some("og:title") if out.title.is_none() => {
                        out.title = value.and_then(|v| sanitized(v, 200))
                    }
                    Some("og:description") if out.description.is_none() => {
                        out.description = value.and_then(|v| sanitized(v, 500))
                    }
                    Some("description") if fallback_description.is_none() => {
                        fallback_description = value.and_then(|v| sanitized(v, 500))
                    }
                    Some("og:site_name") if out.site_name.is_none() => {
                        out.site_name = value.and_then(|v| sanitized(v, 100))
                    }
                    _ => {}
                }
            } else if out.favicon.is_none()
                && attrs.get("rel").is_some_and(|v| {
                    v.split_ascii_whitespace()
                        .any(|r| r.eq_ignore_ascii_case("icon"))
                })
            {
                out.favicon = attrs
                    .get("href")
                    .map(|v| html_escape::decode_html_entities(v).into_owned());
            }
        }
    }
    out.title = out.title.or(fallback_title);
    out.description = out.description.or(fallback_description);
    out
}

fn sanitized(value: &str, max: usize) -> Option<String> {
    let decoded = html_escape::decode_html_entities(value);
    let cleaned: String = decoded.chars().map(|c| {
        if matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}') { '\0' }
        else if c.is_control() { ' ' } else { c }
    }).filter(|c| *c != '\0').collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= max {
        return Some(collapsed);
    }
    Some(
        collapsed
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>()
            + "…",
    )
}

fn display_domain(url: &Url) -> Result<String, ()> {
    let host = url.host_str().ok_or(())?;
    Ok(host
        .strip_prefix("www.")
        .filter(|rest| rest.contains('.'))
        .unwrap_or(host)
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_public_addresses() {
        for address in [
            "127.1.2.3",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "224.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "198.18.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "ff00::1",
            "::",
            "2002::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "allowed {address}");
        }
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn sanitizes_entities_controls_and_length() {
        assert_eq!(
            sanitized(" A&nbsp; &amp;\u{202e}\u{0007} B ", 20).as_deref(),
            Some("A & B")
        );
        assert_eq!(sanitized("abcdef", 5).as_deref(), Some("abcd…"));
    }

    #[test]
    fn extracts_head_metadata() {
        let html = r#"<meta property="og:title" content="Open &amp; Clear"><meta name='description' content=' Summary '><meta property="og:site_name" content="Example"><link rel="shortcut icon" href="/x.png"><title>Fallback</title>"#;
        let result = extract_metadata(html);
        assert_eq!(result.title.as_deref(), Some("Open & Clear"));
        assert_eq!(result.description.as_deref(), Some("Summary"));
        assert_eq!(result.site_name.as_deref(), Some("Example"));
        assert_eq!(result.favicon.as_deref(), Some("/x.png"));
    }

    #[test]
    fn derives_display_domain() {
        assert_eq!(
            display_domain(&Url::parse("https://www.xn--bcher-kva.example/a").unwrap()).unwrap(),
            "xn--bcher-kva.example"
        );
        assert_eq!(
            display_domain(&Url::parse("https://www.localhost/").unwrap()).unwrap(),
            "www.localhost"
        );
    }
}
