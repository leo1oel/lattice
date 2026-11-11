//! Platform-neutral download of a pinned TeX/tool archive.

use super::installer::{create_private_file, PinnedDownload};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a download may go without a single byte before it fails. A
/// Cancel never waits for it: it is noticed within a tenth of a second.
const IDLE_LIMIT: Duration = Duration::from_secs(60);

/// What a download says when `cancel` ended it.
pub(crate) const DOWNLOAD_CANCELLED: &str = "The download was cancelled.";

/// Stream `pinned` into a new private file at `path`, checking its SHA-256.
/// `on_bytes(downloaded, total)` follows along when the size is known. A
/// download that fails, is cut short, runs past the pin's size cap or does not
/// match its digest leaves no file behind: a partial or unverified archive is
/// never something a later step could pick up.
pub(crate) fn download(
    pinned: &PinnedDownload, path: &Path, on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    download_from(pinned, pinned.url, path, None, on_bytes)
}

/// [`download`] that stops, within moments, once `cancel` is set.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn download_cancellable(
    pinned: &PinnedDownload, path: &Path, cancel: &AtomicBool, on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    download_from(pinned, pinned.url, path, Some(cancel), on_bytes)
}

/// Where a pinned download may be sent. Off macOS, redirects are followed only
/// to https, and at most ten of them: a pinned download that is sent to plain
/// http (a mirror's mistake or someone in the path) is refused instead of
/// fetched, whatever its digest would say. On macOS the pinned BasicTeX URL is
/// the `mirror.ctan.org` redirector, which may send a request to any CTAN
/// mirror, so it keeps the behavior it always had (reqwest's default of ten
/// redirects to any scheme); the pinned SHA-256 still decides what is kept.
fn redirect_policy(refuse_plain_http: bool) -> reqwest::redirect::Policy {
    if !refuse_plain_http {
        return reqwest::redirect::Policy::limited(10);
    }
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() != "https" {
            attempt.error("The download was redirected to an address that is not https.")
        } else if attempt.previous().len() >= 10 {
            attempt.error("The download was redirected too many times.")
        } else {
            attempt.follow()
        }
    })
}

/// [`download`] from `url` instead of the pinned one, for tests that serve the
/// bytes from loopback; the digest still has to match.
fn download_from(
    pinned: &PinnedDownload, url: &str, path: &Path, cancel: Option<&AtomicBool>,
    on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    let name = pinned.name;
    let user_agent = format!("Lattice/{}", env!("CARGO_PKG_VERSION"));
    let client = crate::http::blocking_as(&user_agent, pinned.timeout)
        .connect_timeout(Duration::from_secs(20))
        .redirect(redirect_policy(!cfg!(target_os = "macos")))
        .build()
        .map_err(|error| format!("Could not initialize the {name} download: {error}"))?;
    let response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download {}: {error}", pinned.source))?;
    let total = response.content_length().filter(|total| *total > 0);
    if total.is_some_and(|total| total > pinned.max_bytes) {
        return Err(too_large(pinned));
    }
    // Created only once the server has answered, and only by this call:
    // a file that already exists is never deleted here.
    let file = create_private_file(path)?;
    let saved = save_verified(pinned, response, total, file, cancel, on_bytes);
    if saved.is_err() {
        let _ = std::fs::remove_file(path);
    }
    saved
}

fn too_large(pinned: &PinnedDownload) -> String {
    format!("The downloaded {} is larger than expected, so it was refused.", pinned.artifact)
}

/// What the thread that reads the response hands over.
enum Chunk {
    Data(Vec<u8>),
    End,
    Failed(String),
}

/// Write the response to `file`, hash it, and check the digest. The response
/// is read on a thread of its own and handed over in chunks, so a cancel (or
/// the idle limit) ends this call within a tenth of a second even when the
/// server has gone silent in the middle of a read; the reader thread is left
/// to finish on its own and closes the connection when it does.
fn save_verified(
    pinned: &PinnedDownload, mut response: impl Read + Send + 'static, total: Option<u64>,
    mut file: std::fs::File, cancel: Option<&AtomicBool>, mut on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    let name = pinned.name;
    let interrupted = |error: &str| format!("The {name} download was interrupted: {error}");
    let (sender, chunks) = mpsc::sync_channel::<Chunk>(4);
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let message = match response.read(&mut buffer) {
                Ok(0) => Chunk::End,
                Ok(read) => Chunk::Data(buffer[..read].to_vec()),
                Err(error) => Chunk::Failed(error.to_string()),
            };
            let last = !matches!(message, Chunk::Data(_));
            if sender.send(message).is_err() || last {
                break;
            }
        }
    });
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_data = Instant::now();
    loop {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
            return Err(DOWNLOAD_CANCELLED.into());
        }
        match chunks.recv_timeout(Duration::from_millis(100)) {
            Ok(Chunk::Data(bytes)) => {
                last_data = Instant::now();
                downloaded += bytes.len() as u64;
                if downloaded > pinned.max_bytes {
                    return Err(too_large(pinned));
                }
                file.write_all(&bytes)
                    .map_err(|error| format!("Could not save the {name} download: {error}"))?;
                hasher.update(&bytes);
                if let Some(total) = total {
                    on_bytes(downloaded, total);
                }
            }
            Ok(Chunk::End) => break,
            Ok(Chunk::Failed(error)) => return Err(interrupted(&error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_data.elapsed() > IDLE_LIMIT {
                    return Err(interrupted("the server stopped sending"));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(interrupted("the connection ended"));
            }
        }
    }
    file.flush().map_err(|error| format!("Could not finish saving {name}: {error}"))?;
    if format!("{:x}", hasher.finalize()) != pinned.sha256 {
        return Err(format!("The downloaded {} failed its security check.", pinned.artifact));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::io::Cursor;

    /// SHA-256 of the three bytes `abc`.
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn pin(sha256: &'static str) -> PinnedDownload {
        PinnedDownload {
            url: "https://example.invalid/pinned.zip",
            sha256,
            timeout: Duration::from_secs(5),
            name: "test tool",
            source: "the test tool",
            artifact: "test archive",
            max_bytes: 1_000_000,
        }
    }

    #[test]
    fn a_matching_stream_is_kept_and_reports_progress() {
        let dir = TempDir::new("fetch-ok");
        let path = dir.join("tool.zip");
        let file = create_private_file(&path).unwrap();
        let mut seen = Vec::new();
        save_verified(
            &pin(ABC),
            Cursor::new(b"abc".to_vec()),
            Some(3),
            file,
            None,
            |done, total| {
                seen.push((done, total));
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(seen, [(3, 3)]);
    }

    #[test]
    fn a_mismatch_is_refused_with_the_artifact_named() {
        let dir = TempDir::new("fetch-mismatch");
        let file = create_private_file(&dir.join("tool.zip")).unwrap();
        let error =
            save_verified(&pin(ABC), Cursor::new(b"abd".to_vec()), None, file, None, |_, _| {})
                .unwrap_err();
        assert_eq!(error, "The downloaded test archive failed its security check.");
    }

    /// A one-shot HTTP server on loopback answering with `body` and then
    /// closing, after `truncate_at` bytes when the connection should break,
    /// and after a `stall` of silence when the rest should never come.
    fn serve(body: Vec<u8>, truncate_at: Option<usize>) -> String {
        serve_with(body, truncate_at, None)
    }

    fn serve_with(body: Vec<u8>, truncate_at: Option<usize>, stall: Option<Duration>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let sent = truncate_at.unwrap_or(body.len()).min(body.len());
            let _ = stream.write_all(&body[..sent]);
            let _ = stream.flush();
            if let Some(stall) = stall {
                std::thread::sleep(stall);
            }
        });
        format!("http://{address}/pinned.zip")
    }

    #[test]
    fn download_streams_verifies_and_reports_bytes() {
        let dir = TempDir::new("fetch-live-ok");
        let path = dir.join("tool.zip");
        let mut reports = Vec::new();
        let url = serve(b"abc".to_vec(), None);
        download_from(&pin(ABC), &url, &path, None, |done, total| reports.push((done, total)))
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(reports.last(), Some(&(3, 3)));
    }

    #[test]
    fn a_hash_mismatch_deletes_the_file() {
        let dir = TempDir::new("fetch-live-mismatch");
        let path = dir.join("tool.zip");
        let url = serve(b"abd".to_vec(), None);
        let error = download_from(&pin(ABC), &url, &path, None, |_, _| {}).unwrap_err();
        assert!(error.contains("failed its security check"), "{error}");
        assert!(!path.exists(), "an unverified download must not stay");
    }

    #[test]
    fn an_interrupted_download_deletes_the_partial_file() {
        let dir = TempDir::new("fetch-live-cut");
        let path = dir.join("tool.zip");
        let url = serve(vec![b'x'; 200_000], Some(70_000));
        let error = download_from(&pin(ABC), &url, &path, None, |_, _| {}).unwrap_err();
        assert!(error.contains("interrupted"), "{error}");
        assert!(!path.exists(), "a partial download must not stay");
    }

    #[test]
    fn an_existing_file_is_neither_overwritten_nor_deleted() {
        let dir = TempDir::new("fetch-existing");
        let path = dir.write("tool.zip", "precious");
        let url = serve(b"abc".to_vec(), None);
        let error = download_from(&pin(ABC), &url, &path, None, |_, _| {}).unwrap_err();
        assert!(error.contains("Could not create"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"precious");
    }

    #[test]
    fn an_http_error_status_leaves_nothing() {
        let dir = TempDir::new("fetch-404");
        let path = dir.join("tool.zip");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/missing", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        let error = download_from(&pin(ABC), &url, &path, None, |_, _| {}).unwrap_err();
        assert!(error.starts_with("Could not download the test tool"), "{error}");
        assert!(!path.exists());
    }

    #[test]
    fn a_download_larger_than_its_cap_is_refused_and_leaves_nothing() {
        let dir = TempDir::new("fetch-cap");
        // Announced too large: refused before a file exists.
        let path = dir.join("announced.zip");
        let mut small = pin(ABC);
        small.max_bytes = 100;
        let url = serve(vec![b'x'; 5_000], None);
        let error = download_from(&small, &url, &path, None, |_, _| {}).unwrap_err();
        assert_eq!(
            error,
            "The downloaded test archive is larger than expected, so it was refused."
        );
        assert!(!path.exists());
        // A stream that outgrows the cap while it flows (no usable length).
        let path = dir.join("streamed.zip");
        let file = create_private_file(&path).unwrap();
        let error =
            save_verified(&small, Cursor::new(vec![b'x'; 5_000]), None, file, None, |_, _| {})
                .unwrap_err();
        assert!(error.contains("larger than expected"), "{error}");
    }

    /// A one-shot server that answers with a redirect to `location`.
    fn redirect_to(location: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/start", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(response.as_bytes());
        });
        url
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_redirect_to_plain_http_is_refused() {
        let dir = TempDir::new("fetch-redirect");
        let path = dir.join("tool.zip");
        // The target would serve the right bytes; it must never be asked.
        let target = serve(b"abc".to_vec(), None);
        let url = redirect_to(target);
        let error = download_from(&pin(ABC), &url, &path, None, |_, _| {}).unwrap_err();
        assert!(error.starts_with("Could not download the test tool"), "{error}");
        assert!(!path.exists());
    }

    /// The macOS policy is reqwest's own: a redirect to plain http is followed.
    #[test]
    fn without_the_refusal_a_redirect_to_plain_http_is_followed() {
        let url = redirect_to(serve(b"abc".to_vec(), None));
        let client = crate::http::blocking(Duration::from_secs(10))
            .redirect(redirect_policy(false))
            .build()
            .unwrap();
        let body = client.get(url).send().unwrap().bytes().unwrap();
        assert_eq!(&body[..], b"abc");
    }

    #[test]
    fn cancelling_stops_a_download_that_is_still_flowing_or_has_stalled() {
        let dir = TempDir::new("fetch-cancel");
        // Set before the first byte: nothing is kept.
        let path = dir.join("early.zip");
        let url = serve(b"abc".to_vec(), None);
        let cancel = AtomicBool::new(true);
        let error = download_from(&pin(ABC), &url, &path, Some(&cancel), |_, _| {}).unwrap_err();
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert!(!path.exists());

        // Set while the server sends a part and then goes silent: the call
        // returns on the next chunk, not on the read timeout (a minute).
        let path = dir.join("stalled.zip");
        let url = serve_with(vec![b'x'; 200_000], Some(100_000), Some(Duration::from_secs(8)));
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let error = download_from(&pin(ABC), &url, &path, Some(&cancel), |downloaded, _| {
            if downloaded >= 64 * 1024 {
                cancel.store(true, Ordering::Release);
            }
        })
        .unwrap_err();
        assert_eq!(error, DOWNLOAD_CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        assert!(!path.exists(), "a cancelled download must not stay");
    }
}
