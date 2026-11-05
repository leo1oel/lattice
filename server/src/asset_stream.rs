//! Authorized ordinary project assets. The caller owns authentication and origin
//! checks; this module owns descriptor confinement and bounded streaming.
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::stream;
use rustix::fs::{open, openat, Mode, OFlags};
use std::{
    fs::File,
    io,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK_BYTES: usize = 64 * 1024;

/// Walk the caller's lexical path from an open workspace directory, refusing
/// symlinks at every component. NONBLOCK lets fstat reject a FIFO without
/// waiting for a writer. The exact final descriptor is subsequently streamed.
fn open_asset(root: &Path, candidate: &Path) -> io::Result<File> {
    let relative = candidate.strip_prefix(root).map_err(|_| io::ErrorKind::PermissionDenied)?;
    let mut parts = relative.components().peekable();
    let mut directory = open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(io::ErrorKind::PermissionDenied.into());
        };
        if name.to_string_lossy().starts_with('.') {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let child = openat(
            &directory,
            name,
            flags | if parts.peek().is_some() { OFlags::DIRECTORY } else { OFlags::NONBLOCK },
            Mode::empty(),
        )?;
        if parts.peek().is_none() {
            let file = File::from(child);
            if !file.metadata()?.is_file() {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            return Ok(file);
        }
        directory = child;
    }
    Err(io::ErrorKind::PermissionDenied.into())
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// Inclusive HTTP single byte ranges. Reject multipart and malformed requests
/// rather than constructing unbounded multipart replies. HEAD ignores Range.
fn byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 {
        return None;
    }
    let parse = |text: &str| {
        if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
            text.parse::<u64>().ok()
        } else {
            None
        }
    };
    if start.is_empty() {
        let count = parse(end)?;
        return (count > 0).then(|| (length.saturating_sub(count), length - 1));
    }
    let start = parse(start)?;
    let end = if end.is_empty() { length - 1 } else { parse(end)?.min(length - 1) };
    (start < length && start <= end).then_some((start, end))
}

fn text_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn common(response: &mut Response, path: &Path, etag: &str) {
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(path)));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::ETAG, HeaderValue::from_str(etag).unwrap());
}

pub(crate) async fn serve(
    root: &Path, path: &Path, headers: &HeaderMap, method: Method,
) -> Response {
    let (root_owned, path_owned) = (root.to_owned(), path.to_owned());
    let opened = tokio::task::spawn_blocking(move || {
        let file = open_asset(&root_owned, &path_owned)?;
        let metadata = file.metadata()?;
        Ok::<_, io::Error>((file, metadata))
    })
    .await;
    let (file, metadata) = match opened {
        Ok(Ok(opened)) => opened,
        _ => return (StatusCode::FORBIDDEN, "Asset is unavailable.").into_response(),
    };
    let length = metadata.len();
    let etag = format!(
        "\"{:x}-{:x}-{:x}-{:x}-{:x}\"",
        metadata.dev(),
        metadata.ino(),
        length,
        metadata.mtime(),
        metadata.mtime_nsec()
    );
    let matches = text_header(headers, header::IF_NONE_MATCH).is_some_and(|value| {
        value.split(',').any(|entry| {
            let entry = entry.trim();
            entry == "*" || entry.strip_prefix("W/").unwrap_or(entry) == etag
        })
    });
    if matches {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        common(&mut response, path, &etag);
        return response;
    }
    let range = if method == Method::GET
        && text_header(headers, header::IF_RANGE).is_none_or(|value| value == etag)
    {
        text_header(headers, header::RANGE)
    } else {
        None
    };
    let (status, start, count) = match range {
        Some(range) => match byte_range(range, length) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
            None => {
                let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                common(&mut response, path, &etag);
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{length}")).unwrap(),
                );
                return response;
            }
        },
        None => (StatusCode::OK, 0, length),
    };
    let mut file = tokio::fs::File::from_std(file);
    if start != 0 && file.seek(io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(stream::try_unfold((file, count), |(mut file, left)| async move {
            if left == 0 {
                return Ok::<_, io::Error>(None);
            }
            let mut chunk = vec![0; left.min(CHUNK_BYTES as u64) as usize];
            let read = file.read(&mut chunk).await?;
            if read == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            chunk.truncate(read);
            Ok(Some((chunk, (file, left - read as u64))))
        }))
    };
    let mut response = (status, body).into_response();
    common(&mut response, path, &etag);
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from_str(&count.to_string()).unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{}/{length}", start + count - 1))
                .unwrap(),
        );
    }
    response
}
