use super::*;
use crate::literature_service::serve_once;

const KEY: &str = "sk-test-secret-key";

fn sse(lines: &[&str]) -> String {
    lines.iter().map(|line| format!("{line}\n\n")).collect()
}

fn reply(status: u16, content_type: &str, body: String) -> tiny_http::ResponseBox {
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("content-type", content_type).unwrap())
        .boxed()
}

/// Runs the probe against one canned reply, checking the request on the way.
fn probe(
    protocol: Protocol, status: u16, content_type: &'static str, body: String,
    check: impl FnOnce(&str, &[tiny_http::Header], Value) + Send + 'static,
) -> ProbeReport {
    let (base, responder) = serve_once(move |mut request| {
        let mut text = String::new();
        request.as_reader().read_to_string(&mut text).unwrap();
        check(request.url(), request.headers(), serde_json::from_str(&text).unwrap());
        request.respond(reply(status, content_type, body)).unwrap();
    });
    let report = run(protocol, &base, "test-model", Some(KEY));
    responder.join().unwrap();
    report
}

fn header<'a>(headers: &'a [tiny_http::Header], name: &'static str) -> Option<&'a str> {
    headers.iter().find(|header| header.field.equiv(name)).map(|header| header.value.as_str())
}

const ALL: [Check; 5] = [Check::Reach, Check::Key, Check::Model, Check::Stream, Check::Tools];

#[test]
fn openai_tool_call_passes_every_check() {
    let body = sse(&[
        r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"report_status"}}]}}]}"#,
        "data: [DONE]",
    ]);
    let report =
        probe(Protocol::OpenAiCompletions, 200, "text/event-stream", body, |url, headers, body| {
            assert_eq!(url, "/chat/completions");
            assert_eq!(header(headers, "authorization"), Some("Bearer sk-test-secret-key"));
            assert_eq!(body["model"], "test-model");
            assert_eq!(body["stream"], true);
            assert_eq!(body["tools"][0]["function"]["name"], TOOL);
        });
    assert_eq!(report.passed, ALL);
    assert_eq!(report.problem, None);
}

#[test]
fn anthropic_tool_use_passes_with_its_own_headers() {
    let body = sse(&[
        "event: message_start\ndata: {\"type\":\"message_start\"}",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"name\":\"report_status\"}}",
    ]);
    let report =
        probe(Protocol::AnthropicMessages, 200, "text/event-stream", body, |url, headers, body| {
            assert_eq!(url, "/v1/messages");
            assert_eq!(header(headers, "x-api-key"), Some(KEY));
            assert_eq!(header(headers, "anthropic-version"), Some("2023-06-01"));
            assert_eq!(body["tools"][0]["input_schema"]["required"][0], "ok");
        });
    assert_eq!(report.passed, ALL);
}

#[test]
fn responses_and_gemini_tool_calls_pass() {
    let body =
        sse(&[r#"data: {"type":"response.output_item.added","item":{"type":"function_call"}}"#]);
    let report =
        probe(Protocol::OpenAiResponses, 200, "text/event-stream", body, |url, _, body| {
            assert_eq!(url, "/responses");
            assert_eq!(body["tools"][0]["name"], TOOL);
        });
    assert_eq!(report.passed, ALL);

    let body = sse(&[
        r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"report_status"}}]}}]}"#,
    ]);
    let report = probe(Protocol::Google, 200, "text/event-stream", body, |url, headers, _| {
        assert_eq!(url, "/models/test-model:streamGenerateContent?alt=sse");
        assert_eq!(header(headers, "x-goog-api-key"), Some(KEY));
    });
    assert_eq!(report.passed, ALL);
}

#[test]
fn a_text_answer_means_the_model_skipped_the_tool() {
    let body = sse(&[r#"data: {"choices":[{"delta":{"content":"ok"}}]}"#, "data: [DONE]"]);
    let report = probe(Protocol::OpenAiCompletions, 200, "text/event-stream", body, |_, _, _| {});
    assert_eq!(report.passed, [Check::Reach, Check::Key, Check::Model, Check::Stream]);
    assert_eq!(report.problem, Some(Problem::NoToolCall));
}

#[test]
fn a_json_reply_means_no_streaming() {
    let report =
        probe(Protocol::OpenAiCompletions, 200, "application/json", "{}".into(), |_, _, _| {});
    assert_eq!(report.problem, Some(Problem::NoStream));
}

#[test]
fn an_error_event_inside_the_stream_is_reported() {
    let body = sse(&[r#"data: {"error":{"message":"tools are not supported by this model"}}"#]);
    let report = probe(Protocol::OpenAiCompletions, 200, "text/event-stream", body, |_, _, _| {});
    assert_eq!(report.problem, Some(Problem::ToolsRejected));
    assert_eq!(report.detail.as_deref(), Some("tools are not supported by this model"));
}

#[test]
fn http_failures_are_named_and_the_key_never_echoes() {
    let cases = [
        (401, r#"{"error":{"message":"Invalid key sk-test-secret-key"}}"#, Problem::KeyRejected),
        (
            404,
            r#"{"error":{"message":"The model test-model does not exist"}}"#,
            Problem::ModelNotFound,
        ),
        (404, "Not Found", Problem::WrongAddress),
        (400, r#"{"error":{"message":"tool_choice is not supported"}}"#, Problem::ToolsRejected),
        (429, r#"{"error":{"message":"slow down"}}"#, Problem::RateLimited),
        (502, "bad gateway", Problem::ServerError),
        (418, "teapot", Problem::Refused),
    ];
    for (status, body, expected) in cases {
        let report = probe(
            Protocol::OpenAiCompletions,
            status,
            "application/json",
            body.into(),
            |_, _, _| {},
        );
        assert_eq!(report.problem, Some(expected), "{status} {body}");
        assert_eq!(report.status, Some(status));
        assert!(!report.detail.unwrap_or_default().contains(KEY));
    }
}

#[test]
fn an_unreachable_address_fails_before_any_check() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let report = run(Protocol::OpenAiCompletions, &base, "m", None);
    assert_eq!(report.passed, []);
    assert_eq!(report.problem, Some(Problem::Unreachable));
}

#[test]
fn redaction_hides_the_key_and_shortens_long_text() {
    assert_eq!(redacted("bad key abcd1234", Some("abcd1234")), "bad key ••••");
    let long = "x".repeat(MAX_DETAIL + 50);
    assert_eq!(redacted(&long, None).chars().count(), MAX_DETAIL + 1);
}

#[test]
fn only_loopback_addresses_skip_the_system_proxy() {
    for local in [
        "http://localhost:11434/v1",
        "http://127.0.0.1:1234",
        "http://[::1]:8080",
        "http://a.localhost",
    ] {
        assert!(is_loopback(local), "{local}");
    }
    for remote in
        ["https://api.example.com/v1", "http://10.0.0.2:8000", "http://localhost.example.com"]
    {
        assert!(!is_loopback(remote), "{remote}");
    }
}
