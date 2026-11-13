//! The local asset protocol every island loads from.
//!
//! An island's page is never a `file://` URL and never a server: its own
//! files (the page, its scripts and styles, compiled into the binary as a
//! [`Bundle`]) and the project files it was granted are served by the host
//! under one custom scheme, through Wry's custom protocol handler, per
//! webview. A bundle file is at `bundle/<file>`; a granted project file at
//! `asset/<project-relative path>`.
//!
//! The scheme's URLs differ by platform, as Wry maps them: `lattice://island/…`
//! on macOS and Linux, `http://lattice.island/…` on Windows (WebView2 serves
//! custom schemes as a host under `http`). [`url`] and [`origin`] give the
//! right one; nothing else in the app spells either out.
//!
//! What a page may read is only what was granted ([`Grants`]): the HTML viewer
//! grants exactly the images and frames its document names, as the Tauri app
//! inlines exactly those (`src/canvas/html-preview.tsx`), so a script in an
//! authored page cannot walk the project through this protocol. A request
//! outside the project, through `..`, an absolute path or a symlink that leaves
//! it, is refused whatever the grants say ([`crate::files::FileScope`]).

use std::{borrow::Cow, cell::RefCell, collections::BTreeSet, rc::Rc};

use wry::http::{Request, Response, StatusCode, header};

use crate::files::FileScope;

/// The scheme's name, as registered with Wry.
pub const SCHEME: &str = "lattice";
/// The host every island's URLs are under.
const HOST: &str = "island";

/// The origin pages served by this protocol have.
pub fn origin() -> String {
    if cfg!(target_os = "windows") {
        format!("http://{SCHEME}.{HOST}")
    } else {
        format!("{SCHEME}://{HOST}")
    }
}

/// The URL of `path` (relative, no leading slash) under the protocol.
pub fn url(path: &str) -> String {
    format!("{}/{}", origin(), path.trim_start_matches('/'))
}

/// The URL a granted project file is served at.
pub fn asset_url(relative: &str) -> String {
    let encoded: Vec<String> = relative
        .split('/')
        .map(|segment| percent_encoding::utf8_percent_encode(segment, PATH_SEGMENT).to_string())
        .collect();
    url(&format!("asset/{}", encoded.join("/")))
}

/// What a path segment escapes: everything a URL path would misread.
const PATH_SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// One file an island ships in the binary.
#[derive(Clone, Copy, Debug)]
pub struct BundleFile {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

/// An island's own files, served at `bundle/<path>`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Bundle(pub &'static [BundleFile]);

impl Bundle {
    fn get(&self, path: &str) -> Option<&'static [u8]> {
        self.0
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.bytes)
    }
}

/// The project files a page may load.
#[derive(Clone, Debug, Default)]
pub struct Grants {
    paths: BTreeSet<String>,
}

impl Grants {
    pub fn grant(&mut self, relative: impl Into<String>) {
        self.paths.insert(normalize_relative(&relative.into()));
    }

    pub fn contains(&self, relative: &str) -> bool {
        self.paths.contains(&normalize_relative(relative))
    }

    pub fn clear(&mut self) {
        self.paths.clear();
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
}

/// `a/./b` and `a//b` name `a/b`; the protocol and the grants agree on it.
fn normalize_relative(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// What one webview's protocol handler serves from, shared with its island.
#[derive(Clone)]
pub struct Served {
    pub bundle: Bundle,
    pub files: Option<FileScope>,
    pub grants: Rc<RefCell<Grants>>,
    /// Project files served so far, for the scripted checks.
    pub log: Rc<RefCell<Vec<String>>>,
}

impl Served {
    pub fn new(bundle: Bundle, files: Option<FileScope>) -> Self {
        Self {
            bundle,
            files,
            grants: Rc::default(),
            log: Rc::default(),
        }
    }
}

/// The route a request's path names.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    Bundle(String),
    Asset(String),
}

/// The route in a request URI, if it is this protocol's at all. The host
/// part is ignored: Wry hands each webview only its own scheme's requests.
fn route(uri: &str) -> Option<Route> {
    let path = if let Some(rest) = uri.strip_prefix(&format!("{SCHEME}://")) {
        rest.split_once('/').map(|(_, path)| path)?
    } else {
        let rest = uri
            .strip_prefix("http://")
            .or_else(|| uri.strip_prefix("https://"))?;
        let (host, path) = rest.split_once('/')?;
        if !host.starts_with(&format!("{SCHEME}.")) {
            return None;
        }
        path
    };
    // The query (a cache-busting revision) and fragment play no part.
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?
        .into_owned();
    if let Some(file) = decoded.strip_prefix("bundle/") {
        Some(Route::Bundle(file.to_string()))
    } else {
        decoded
            .strip_prefix("asset/")
            .map(|relative| Route::Asset(relative.to_string()))
    }
}

/// The response to one request on the protocol.
pub fn respond(served: &Served, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    match route(&uri) {
        Some(Route::Bundle(path)) => match served.bundle.get(&path) {
            Some(bytes) => ok(Cow::Borrowed(bytes), mime_for(&path)),
            None => status(StatusCode::NOT_FOUND),
        },
        Some(Route::Asset(relative)) => {
            let Some(files) = &served.files else {
                return status(StatusCode::NOT_FOUND);
            };
            if !served.grants.borrow().contains(&relative) {
                return status(StatusCode::FORBIDDEN);
            }
            match files.read_bytes(&relative) {
                Ok(bytes) => {
                    served.log.borrow_mut().push(normalize_relative(&relative));
                    // A project file is never a document of the page's: one
                    // loaded as a frame (an authored SVG) runs sandboxed.
                    let mut response = ok(Cow::Owned(bytes), mime_for(&relative));
                    response.headers_mut().insert(
                        header::CONTENT_SECURITY_POLICY,
                        header::HeaderValue::from_static("sandbox"),
                    );
                    response
                }
                Err(error) => {
                    log::debug!("island asset {relative}: {error:#}");
                    status(StatusCode::NOT_FOUND)
                }
            }
        }
        None => status(StatusCode::NOT_FOUND),
    }
}

fn ok(body: Cow<'static, [u8]>, mime: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        // A project file changes under the page as the writer works; the
        // page asks again with a new revision rather than trusting a cache.
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

fn status(code: StatusCode) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(&[][..]));
    *response.status_mut() = code;
    response
}

/// The media type for a file name, by its extension; what the HTML viewer's
/// pages and the islands' own files use, and octet-stream otherwise.
pub fn mime_for(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "tex" | "bib" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    static BUNDLE: &[BundleFile] = &[BundleFile {
        path: "html-preview/index.html",
        bytes: b"<!doctype html>",
    }];

    fn served(root: &std::path::Path) -> Served {
        Served::new(Bundle(BUNDLE), Some(FileScope::new(root).unwrap()))
    }

    #[test]
    fn routes_both_url_shapes_and_ignores_queries() {
        assert_eq!(
            route("lattice://island/bundle/html-preview/index.html"),
            Some(Route::Bundle("html-preview/index.html".into()))
        );
        assert_eq!(
            route("http://lattice.island/asset/figures/a%20b.png?v=3#x"),
            Some(Route::Asset("figures/a b.png".into()))
        );
        assert_eq!(route("https://example.com/asset/x.png"), None);
        assert_eq!(route("lattice://island/other/x"), None);
    }

    #[test]
    fn asset_urls_escape_each_segment() {
        let url = asset_url("figures/plot 1#.png");
        assert!(url.ends_with("/asset/figures/plot%201%23.png"), "{url}");
        assert_eq!(
            route(&url),
            Some(Route::Asset("figures/plot 1#.png".into()))
        );
    }

    #[test]
    fn serves_bundle_files_with_their_type() {
        let dir = tempfile::tempdir().unwrap();
        let served = served(dir.path());
        let response = respond(&served, &request(&url("bundle/html-preview/index.html")));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(&response.body()[..], b"<!doctype html>");
        let missing = respond(&served, &request(&url("bundle/nope.js")));
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn serves_only_granted_project_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("figures")).unwrap();
        std::fs::write(dir.path().join("figures/plot.png"), b"png").unwrap();
        std::fs::write(dir.path().join("secret.tex"), b"tex").unwrap();
        let served = served(dir.path());
        served.grants.borrow_mut().grant("./figures//plot.png");

        let granted = respond(&served, &request(&asset_url("figures/plot.png")));
        assert_eq!(granted.status(), StatusCode::OK);
        assert_eq!(granted.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(&granted.body()[..], b"png");
        assert_eq!(*served.log.borrow(), vec!["figures/plot.png".to_string()]);
        assert_eq!(
            granted.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox"
        );
        let page = respond(&served, &request(&url("bundle/html-preview/index.html")));
        assert!(
            page.headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .is_none()
        );

        let refused = respond(&served, &request(&asset_url("secret.tex")));
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_grant_never_reaches_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(dir.path().join("outside.txt"), b"no").unwrap();
        let served = served(&project);
        served.grants.borrow_mut().grant("../outside.txt");
        let response = respond(&served, &request(&url("asset/..%2Foutside.txt")));
        assert_ne!(response.status(), StatusCode::OK);
        let response = respond(&served, &request(&url("asset/../outside.txt")));
        assert_ne!(response.status(), StatusCode::OK);
    }

    #[test]
    fn media_types_by_extension() {
        assert_eq!(mime_for("a/B.SVG"), "image/svg+xml");
        assert_eq!(mime_for("x.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }
}
