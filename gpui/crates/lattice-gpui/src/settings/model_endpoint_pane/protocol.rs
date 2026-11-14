//! What Settings › Model endpoint says about the API it talks to: Pi's
//! protocol names, and what a connection test found
//! (`model-endpoint-probe.ts`).

use gpui::SharedString;
use lattice_i18n::t;
use serde_json::Value;

/// Pi's API names (`lattice_core::model_endpoint::Protocol`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Protocol {
    OpenAiCompletions,
    AnthropicMessages,
    OpenAiResponses,
    Google,
}

impl Protocol {
    pub(super) fn tag(self) -> &'static str {
        match self {
            Self::OpenAiCompletions => "openai-completions",
            Self::AnthropicMessages => "anthropic-messages",
            Self::OpenAiResponses => "openai-responses",
            Self::Google => "google-generative-ai",
        }
    }

    pub(super) fn from_tag(tag: &str) -> Self {
        match tag {
            "anthropic-messages" => Self::AnthropicMessages,
            "openai-responses" => Self::OpenAiResponses,
            "google-generative-ai" => Self::Google,
            _ => Self::OpenAiCompletions,
        }
    }

    /// Shown only with "More protocols" on.
    pub(super) fn advanced(self) -> bool {
        matches!(self, Self::OpenAiResponses | Self::Google)
    }

    pub(super) fn placeholder(self) -> &'static str {
        match self {
            Self::OpenAiCompletions | Self::OpenAiResponses => "https://api.example.com/v1",
            Self::AnthropicMessages => "https://api.example.com",
            Self::Google => "https://generativelanguage.googleapis.com/v1beta",
        }
    }

    pub(super) fn address_help(self) -> SharedString {
        match self {
            Self::OpenAiCompletions => {
                t!("The address before /chat/completions, often ending in /v1.").into()
            }
            Self::AnthropicMessages => t!("The address before /v1/messages.").into(),
            Self::OpenAiResponses => {
                t!("The address before /responses, often ending in /v1.").into()
            }
            Self::Google => t!("The address before /models, with its API version.").into(),
        }
    }
}

/// The API names the advanced protocols go by, the same in every language.
pub(super) const ADVANCED_NAMES: [(Protocol, &str); 2] = [
    (Protocol::OpenAiResponses, "OpenAI Responses"),
    (Protocol::Google, "Google Gemini"),
];

/// The steps the test ticks off, in the order a request reaches them
/// (`PROBE_CHECKS`).
pub(super) fn probe_checks() -> [(&'static str, SharedString); 5] {
    [
        ("reach", t!("Reached the address").into()),
        ("key", t!("Key accepted").into()),
        ("model", t!("Model found").into()),
        ("stream", t!("Streams replies").into()),
        ("tools", t!("Calls tools").into()),
    ]
}

/// What the test found, as one sentence (`describeProbe`).
pub(super) fn describe_probe(report: &Value) -> (bool, SharedString) {
    let Some(problem) = report.get("problem").and_then(Value::as_str) else {
        return (
            true,
            t!("Connected. The agent can use this model. Testing doesn’t save anything.").into(),
        );
    };
    let text = match problem {
        "unreachable" => t!("Couldn’t reach the address. Check it, and your network or proxy."),
        "timeout" => t!("The endpoint didn’t answer within 45 seconds."),
        "wrongAddress" => {
            t!("Nothing answers at that address. Check the address and the protocol.")
        }
        "keyRejected" => t!("The endpoint refused the key."),
        "modelNotFound" => t!("The endpoint doesn’t know that model name."),
        "rateLimited" => t!("The endpoint is rate-limiting this key. Try again later."),
        "serverError" => t!("The endpoint had an error of its own. Try again later."),
        "toolsRejected" => {
            t!("The endpoint refused tool calls, which the agent needs to edit files.")
        }
        "noStream" => t!("The endpoint answered without streaming, which the agent needs."),
        "noToolCall" => t!(
            "The model answered but didn’t call the test tool. The agent may not manage to edit files with it."
        ),
        "badResponse" => {
            t!("The endpoint’s answer wasn’t one the agent can read. Check the protocol.")
        }
        _ => t!("The endpoint refused the request."),
    };
    (false, text.into())
}

/// The host of `url`, which the model menu groups the endpoint's models by.
pub(super) fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn protocols_round_trip_through_their_tags() {
        for protocol in [
            Protocol::OpenAiCompletions,
            Protocol::AnthropicMessages,
            Protocol::OpenAiResponses,
            Protocol::Google,
        ] {
            assert_eq!(Protocol::from_tag(protocol.tag()), protocol);
        }
        assert_eq!(Protocol::from_tag("nonsense"), Protocol::OpenAiCompletions);
    }

    #[test]
    fn the_host_groups_the_models() {
        assert_eq!(host_of("https://api.example.com/v1"), "api.example.com");
        assert_eq!(host_of("not a url"), "");
    }

    #[test]
    fn a_report_without_a_problem_is_connected() {
        let (ok, _) = describe_probe(&json!({ "passed": ["reach"], "problem": null }));
        assert!(ok);
        let (ok, _) = describe_probe(&json!({ "passed": [], "problem": "keyRejected" }));
        assert!(!ok);
    }
}
