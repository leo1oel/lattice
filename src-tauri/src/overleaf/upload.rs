//! Uploading files into a linked project (see the module header of
//! `overleaf` for the endpoint and why the root folder id is required).

use super::api::{folders_above, send_as, Remote, JSON};
use crate::util::err;
use crate::wide_event;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, COOKIE};
use reqwest::StatusCode;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

/// Uploads in flight at once. Over a slow link each upload costs a round trip
/// or two far more than its bytes, so a few in flight hide most of that, while
/// staying well short of anything Overleaf's rate limits would notice.
const PARALLEL_UPLOADS: usize = 4;

/// Uploads files into a linked project (see the module header of `overleaf`
/// for the endpoint and why the root folder id is required).
pub(super) struct Uploader<'a> {
    remote: &'a Remote,
    client: &'a Client,
    csrf: &'a str,
    root_folder_id: &'a str,
}

impl Uploader<'_> {
    pub fn upload(&self, rel: &str, bytes: Vec<u8>) -> Result<(), String> {
        self.try_upload(rel, bytes).map_err(|failure| failure.into_error(rel))
    }

    /// Upload every file, a few at a time; the first failure, in path order,
    /// is the error, and nothing new starts once one has failed.
    ///
    /// Overleaf creates the folders a relative path names, and two uploads
    /// creating the same folder at once can leave two folders of that name. So
    /// a file whose folder `existing` does not list goes up first and alone,
    /// which creates its folders before anything else can race to.
    pub fn upload_all(
        &self, files: &BTreeMap<String, Vec<u8>>, existing: &BTreeSet<String>,
    ) -> Result<(), String> {
        let mut folders: BTreeSet<&str> = existing.iter().map(String::as_str).collect();
        let mut together = Vec::new();
        for (rel, bytes) in files {
            let parent = folders_above(rel).last();
            if parent.is_none_or(|parent| folders.contains(parent)) {
                together.push((rel, bytes));
                continue;
            }
            self.upload(rel, bytes.clone())?;
            folders.extend(folders_above(rel));
        }
        let next = AtomicUsize::new(0);
        let failures = Mutex::new(BTreeMap::new());
        let span = tracing::Span::current();
        let dispatch = tracing::dispatcher::get_default(Clone::clone);
        std::thread::scope(|scope| {
            for _ in 0..PARALLEL_UPLOADS.min(together.len()) {
                scope.spawn(|| {
                    tracing::dispatcher::with_default(&dispatch, || {
                        span.in_scope(|| loop {
                            let index = next.fetch_add(1, Ordering::Relaxed);
                            let Some((rel, bytes)) = together.get(index) else { break };
                            if !failures.lock().unwrap_or_else(PoisonError::into_inner).is_empty() {
                                break;
                            }
                            if let Err(failure) = self.try_upload(rel, (*bytes).clone()) {
                                failures
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .insert(index, (*rel, failure));
                            }
                        })
                    })
                });
            }
        });
        // Only the failure that becomes the error reaches the event: workers
        // share the sync's span, so each recording its own refusal would pair
        // one upload's cause with another's status and code.
        let failures = failures.into_inner().unwrap_or_else(PoisonError::into_inner);
        failures.into_values().next().map_or(Ok(()), |(rel, failure)| Err(failure.into_error(rel)))
    }

    fn try_upload(&self, rel: &str, bytes: Vec<u8>) -> Result<(), UploadFailure> {
        use reqwest::blocking::multipart::{Form, Part};
        let file_name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let form = Form::new()
            .text("name", file_name.clone())
            .text("relativePath", rel.to_string())
            .part("qqfile", Part::bytes(bytes).file_name(file_name));
        let Remote { host, session, state } = self.remote;
        let request = (self.client.post(format!("{host}/project/{}/upload", state.project_id)))
            .query(&[("_csrf", self.csrf), ("folder_id", self.root_folder_id)])
            .header(COOKIE, &session.cookie)
            .header("X-Csrf-Token", self.csrf)
            .header(ACCEPT, JSON)
            .multipart(form);
        let response = send_as(request, err).map_err(UploadFailure::Unsent)?;
        let status = response.status();
        let body = serde_json::from_str::<Value>(&response.text().unwrap_or_default()).ok();
        let accepted = body.as_ref().and_then(|v| v.get("success")?.as_bool()).unwrap_or(false);
        if status.is_success() && accepted {
            return Ok(());
        }
        // The body is the server's arbitrary text and may quote the document,
        // so the failure carries only the status and an error code Overleaf is
        // known to send.
        let code = body
            .as_ref()
            .and_then(|v| v.get("error")?.as_str())
            .and_then(|code| UPLOAD_ERROR_CODES.iter().copied().find(|known| *known == code));
        Err(UploadFailure::Refused { status, code })
    }
}

/// Why one upload failed, kept apart from the sync's event until the caller
/// knows this is the failure it reports.
enum UploadFailure {
    /// The request never got an answer (or the session had expired).
    Unsent(String),
    Refused {
        status: StatusCode,
        code: Option<&'static str>,
    },
}

impl UploadFailure {
    /// The error for `rel`, recording a refusal's status and code on the
    /// current event. The error is shown to the user and written to the
    /// event, so it too names only the status and the known code.
    fn into_error(self, rel: &str) -> String {
        let cause = match self {
            UploadFailure::Unsent(error) => error,
            UploadFailure::Refused { status, code } => {
                wide_event::record("upload_status", status.as_u16());
                if let Some(code) = code {
                    wide_event::record("upload_error", code);
                }
                let error = if status.is_success() {
                    "Overleaf rejected the upload".to_string()
                } else {
                    format!("Overleaf returned HTTP {} during upload", status.as_u16())
                };
                match code {
                    Some(code) => format!("{error} ({code})"),
                    None => error,
                }
            }
        };
        format!("Failed to upload \"{rel}\" to Overleaf: {cause}")
    }
}

/// The `error` codes Overleaf's upload endpoint answers with; anything else
/// in a rejection's body is left out of the error.
const UPLOAD_ERROR_CODES: &[&str] = &[
    "duplicate_file_name",
    "file_too_large",
    "folder_not_found",
    "invalid_filename",
    // The endpoint's multipart parse found no file (a 400).
    "invalid_upload_request",
    "project_has_too_many_files",
];

impl Remote {
    /// Fails until realtime has supplied the root folder id uploads need.
    pub fn uploader<'a>(
        &'a self, client: &'a Client, csrf: &'a str,
    ) -> Result<Uploader<'a>, String> {
        let root_folder_id = self.state.root_folder()?;
        Ok(Uploader { remote: self, client, csrf, root_folder_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overleaf::api::http_client;
    use crate::overleaf::test_support::*;
    use std::time::Duration;

    #[test]
    fn concurrent_upload_failures_record_only_the_reported_one() {
        // `a.tex` is the failure reported, in path order; `b.tex` fails too.
        // Each answers in turn, so whichever finishes last would win the
        // event if every worker recorded its own refusal.
        let a = (400, r#"{"error":"file_too_large"}"#);
        let b = (422, r#"{"error":"project_has_too_many_files"}"#);
        let unknown = (400, r#"{"error":"not_a_known_code"}"#);
        for (a, b, a_first, code) in [
            (a, b, true, Some("file_too_large")),
            (a, b, false, Some("file_too_large")),
            // A code-less failure never inherits the other upload's code.
            (unknown, b, false, None),
        ] {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let host = format!("http://{}", server.server_addr());
            let answering = std::thread::spawn(move || {
                // Both uploads are in flight before either is answered.
                let mut requests: Vec<_> = (0..2)
                    .map(|_| {
                        let mut request =
                            server.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
                        let mut body = String::new();
                        request.as_reader().read_to_string(&mut body).unwrap();
                        (body.contains("a.tex"), request)
                    })
                    .collect();
                requests.sort_by_key(|(is_a, _)| *is_a != a_first);
                for (is_a, request) in requests {
                    let (status, body) = if is_a { a } else { b };
                    let response = tiny_http::Response::from_string(body).with_status_code(status);
                    request.respond(response).unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let (config, root) = (signed_in(&host), TempDir::new("concurrent-upload-failures"));
            seed_linked_project(&root, &host, &[], &[]);
            let remote = Remote::open(&config, &root).unwrap();
            let client = http_client(10).unwrap();
            let files = BTreeMap::from([
                ("a.tex".to_string(), b"one".to_vec()),
                ("b.tex".to_string(), b"two".to_vec()),
            ]);
            let classify = crate::overleaf::sync::classify_sync_error;
            let (result, capture) = crate::wide_event::tests::capture(|| {
                let operation = crate::wide_event::Operation::start("overleaf.sync", classify);
                operation.run_sync(|| {
                    remote.uploader(&client, "fixture-csrf")?.upload_all(&files, &BTreeSet::new())
                })
            });
            answering.join().unwrap();
            let error = result.unwrap_err();
            let suffix = code.map(|code| format!(" ({code})")).unwrap_or_default();
            let expected = format!(
                "Failed to upload \"a.tex\" to Overleaf: Overleaf returned HTTP {} during upload{suffix}",
                a.0
            );
            assert_eq!(error, expected, "a_first={a_first}");
            let event = &capture.events()[0];
            assert_eq!(event["error_cause"], expected, "{event}");
            assert_eq!(event["upload_status"], a.0, "{event}");
            assert_eq!(event.get("upload_error").and_then(Value::as_str), code, "{event}");
        }
    }
}
