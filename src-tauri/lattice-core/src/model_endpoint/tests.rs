use super::*;
use crate::test_support::TempDir;

const EXE: &str = "/Applications/Lattice.app/Contents/MacOS/lattice";

fn model(id: &str) -> EndpointModel {
    EndpointModel { id: id.into(), context_window: 128_000, max_tokens: 16_384, images: false }
}

fn endpoint(protocol: Protocol, base_url: &str, models: Vec<EndpointModel>) -> Endpoint {
    Endpoint { protocol, base_url: base_url.into(), models }
}

fn saved(home: &Path) -> Value {
    read_models(home).unwrap().expect("models.json")
}

#[test]
fn base_urls_lose_the_paths_pi_adds_itself() {
    let cases = [
        (
            Protocol::OpenAiCompletions,
            " https://api.example.com/v1/ ",
            "https://api.example.com/v1",
        ),
        (
            Protocol::OpenAiCompletions,
            "https://api.example.com/v1/chat/completions",
            "https://api.example.com/v1",
        ),
        (
            Protocol::OpenAiResponses,
            "https://api.example.com/v1/responses",
            "https://api.example.com/v1",
        ),
        (
            Protocol::AnthropicMessages,
            "https://api.example.com/v1/messages",
            "https://api.example.com",
        ),
        (
            Protocol::AnthropicMessages,
            "https://proxy.example.com/anthropic/v1",
            "https://proxy.example.com/anthropic",
        ),
        (Protocol::AnthropicMessages, "https://api.example.com", "https://api.example.com"),
        (
            Protocol::Google,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent",
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        (
            Protocol::Google,
            "https://generativelanguage.googleapis.com/v1beta/models",
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        (Protocol::OpenAiCompletions, "http://localhost:11434/v1", "http://localhost:11434/v1"),
    ];
    for (protocol, input, expected) in cases {
        assert_eq!(normalized_base_url(protocol, input).as_deref(), Ok(expected), "{input}");
    }
    for bad in [
        "",
        "api.example.com",
        "ftp://example.com",
        "https://a.com/v1?key=1",
        "https://u:p@a.com",
        "https://a.com/#x",
    ] {
        assert!(normalized_base_url(Protocol::OpenAiCompletions, bad).is_err(), "{bad}");
    }
}

#[test]
fn endpoints_need_distinct_plain_model_names_and_sane_limits() {
    let ok = endpoint(Protocol::OpenAiCompletions, "https://a.com/v1", vec![model(" gpt-x ")]);
    assert_eq!(ok.normalized().unwrap().models[0].id, "gpt-x");
    let too_many = (0..=MAX_MODELS).map(|i| model(&format!("m{i}"))).collect();
    let bad_limits = EndpointModel { max_tokens: 200_000, ..model("m") };
    for models in
        [vec![], too_many, vec![model("two words")], vec![model("m"), model("m")], vec![bad_limits]]
    {
        assert!(endpoint(Protocol::OpenAiCompletions, "https://a.com", models)
            .normalized()
            .is_err());
    }
}

#[test]
fn the_key_command_quotes_the_executable_for_sh() {
    assert_eq!(key_command(Path::new(EXE)), format!("!'{EXE}' agent-endpoint-key"));
    assert_eq!(key_command(Path::new("/a/it's/x")), r"!'/a/it'\''s/x' agent-endpoint-key");
}

#[test]
fn saving_keeps_the_key_out_of_models_json() {
    let home = TempDir::new("model-endpoint");
    let draft =
        endpoint(Protocol::OpenAiCompletions, "https://api.example.com/v1/", vec![model("gpt-x")]);
    let status =
        save(&home, Path::new(EXE), draft, KeyUpdate::Replace(" sk-secret ".into())).unwrap();
    assert!(status.key_saved);
    assert_eq!(status.endpoint.unwrap().base_url, "https://api.example.com/v1");
    assert_eq!(keychain::read().unwrap().as_deref(), Some("sk-secret"));

    let text = std::fs::read_to_string(home.join("pi-agent/models.json")).unwrap();
    assert!(!text.contains("sk-secret"));
    let entry = &saved(&home)["providers"]["lattice"];
    assert_eq!(entry["apiKey"], key_command(Path::new(EXE)));
    assert_eq!(entry["api"], "openai-completions");
    assert_eq!(entry["name"], "api.example.com");
    assert_eq!(
        entry["models"][0],
        json!({"id": "gpt-x", "contextWindow": 128000, "maxTokens": 16384, "input": ["text"]})
    );
}

#[test]
fn keep_and_remove_follow_the_saved_key() {
    let home = TempDir::new("model-endpoint");
    let draft = || endpoint(Protocol::AnthropicMessages, "http://localhost:8080", vec![model("m")]);
    assert!(!save(&home, Path::new(EXE), draft(), KeyUpdate::Keep).unwrap().key_saved);
    assert_eq!(saved(&home)["providers"]["lattice"]["apiKey"], NO_KEY);

    save(&home, Path::new(EXE), draft(), KeyUpdate::Replace("k1".into())).unwrap();
    assert!(save(&home, Path::new(EXE), draft(), KeyUpdate::Keep).unwrap().key_saved);
    assert_eq!(keychain::read().unwrap().as_deref(), Some("k1"));

    assert!(!save(&home, Path::new(EXE), draft(), KeyUpdate::Remove).unwrap().key_saved);
    assert_eq!(keychain::read().unwrap(), None);
    assert!(save(&home, Path::new(EXE), draft(), KeyUpdate::Replace("\n".into())).is_err());
}

#[test]
fn saving_preserves_fields_lattice_does_not_own() {
    let home = TempDir::new("model-endpoint");
    home.write(
        "pi-agent/models.json",
        json!({
            "providers": {
                "ollama": { "baseUrl": "http://localhost:11434/v1" },
                "lattice": {
                    "compat": { "supportsDeveloperRole": false },
                    "models": [
                        { "id": "kept", "name": "Kept by hand", "reasoning": true, "contextWindow": 1 },
                        { "id": "dropped", "reasoning": true },
                    ],
                },
            },
        })
        .to_string(),
    );
    let draft = endpoint(
        Protocol::OpenAiCompletions,
        "https://a.com/v1",
        vec![model("kept"), model("new")],
    );
    save(&home, Path::new(EXE), draft, KeyUpdate::Keep).unwrap();
    let document = saved(&home);
    let entry = &document["providers"]["lattice"];
    assert_eq!(document["providers"]["ollama"]["baseUrl"], "http://localhost:11434/v1");
    assert_eq!(entry["compat"]["supportsDeveloperRole"], false);
    assert_eq!(entry["models"][0]["reasoning"], true);
    assert_eq!(entry["models"][0]["name"], "Kept by hand");
    assert_eq!(entry["models"][0]["contextWindow"], 128_000);
    assert_eq!(
        entry["models"][1],
        json!({"id": "new", "contextWindow": 128000, "maxTokens": 16384, "input": ["text"]})
    );
    assert_eq!(entry["models"].as_array().unwrap().len(), 2);
}

#[test]
fn status_reads_the_endpoint_back_with_pi_defaults() {
    let document = json!({"providers": {"lattice": {
        "api": "google-generative-ai",
        "baseUrl": "https://g.example/v1beta",
        "apiKey": "!x agent-endpoint-key",
        "models": [{ "id": "gem", "input": ["text", "image"] }],
    }}});
    let status = status_of(Some(&document));
    assert!(status.key_saved);
    let endpoint = status.endpoint.unwrap();
    assert_eq!(endpoint.protocol, Protocol::Google);
    assert_eq!(endpoint.models, [EndpointModel { images: true, ..model("gem") }]);
    assert_eq!(status_of(None), EndpointStatus { endpoint: None, key_saved: false });
    let foreign =
        json!({"providers": {"lattice": {"api": "bedrock", "baseUrl": "x", "models": []}}});
    assert_eq!(status_of(Some(&foreign)).endpoint, None);
}

#[test]
fn removing_forgets_the_key_and_only_our_provider() {
    let home = TempDir::new("model-endpoint");
    let draft = || endpoint(Protocol::OpenAiCompletions, "https://a.com/v1", vec![model("m")]);
    save(&home, Path::new(EXE), draft(), KeyUpdate::Replace("k".into())).unwrap();
    remove(&home).unwrap();
    assert_eq!(keychain::read().unwrap(), None);
    assert!(!home.join("pi-agent/models.json").exists());

    home.write("pi-agent/models.json", json!({"providers": {"other": {}}}).to_string());
    save(&home, Path::new(EXE), draft(), KeyUpdate::Keep).unwrap();
    remove(&home).unwrap();
    assert_eq!(saved(&home), json!({"providers": {"other": {}}}));
}

fn env_of(command: &Command, name: &str) -> Option<PathBuf> {
    command.get_envs().find(|(key, _)| *key == name).and_then(|(_, value)| value.map(PathBuf::from))
}

#[test]
fn the_sidecar_gets_the_agent_dir_only_once_an_endpoint_is_saved() {
    let home = TempDir::new("model-endpoint");
    let mut command = Command::new("true");
    configure_sidecar(&mut command, &home, Path::new(EXE));
    assert_eq!(env_of(&command, "PI_CODING_AGENT_DIR"), None);

    let draft = endpoint(Protocol::OpenAiCompletions, "https://a.com/v1", vec![model("m")]);
    save(&home, Path::new("/old/place/lattice"), draft, KeyUpdate::Replace("k".into())).unwrap();
    configure_sidecar(&mut command, &home, Path::new(EXE));
    assert_eq!(env_of(&command, "PI_CODING_AGENT_DIR"), Some(home.join("pi-agent")));
    assert_eq!(saved(&home)["providers"]["lattice"]["apiKey"], key_command(Path::new(EXE)));
}

#[test]
fn a_keyless_endpoint_keeps_its_placeholder_when_the_app_moves() {
    let home = TempDir::new("model-endpoint");
    let draft = endpoint(Protocol::OpenAiCompletions, "http://localhost:1234/v1", vec![model("m")]);
    save(&home, Path::new("/old/lattice"), draft, KeyUpdate::Keep).unwrap();
    configure_sidecar(&mut Command::new("true"), &home, Path::new(EXE));
    assert_eq!(saved(&home)["providers"]["lattice"]["apiKey"], NO_KEY);
}

#[test]
fn a_key_the_keychain_lost_is_not_reported_or_kept() {
    let home = TempDir::new("model-endpoint");
    let draft = || endpoint(Protocol::OpenAiCompletions, "https://a.com/v1", vec![model("m")]);
    save(&home, Path::new(EXE), draft(), KeyUpdate::Replace("k".into())).unwrap();
    keychain::remove().unwrap();
    assert!(!checked_status(Some(&saved(&home))).key_saved);
    assert!(!save(&home, Path::new(EXE), draft(), KeyUpdate::Keep).unwrap().key_saved);
    assert_eq!(saved(&home)["providers"]["lattice"]["apiKey"], NO_KEY);
}
