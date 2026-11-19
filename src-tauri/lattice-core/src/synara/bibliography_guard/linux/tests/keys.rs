use super::*;
use crate::literature_credentials::SIDECAR_VARIABLE as LITERATURE_VARIABLE;
use crate::model_endpoint::KEY_VARIABLE as ENDPOINT_VARIABLE;

/// Set for [`key_probe`] when a test runs it inside the sandbox.
const KEY_PROBE: &str = "LATTICE_GUARD_KEY_PROBE";

/// Not a test of its own: inside the sandbox, the test binary resolves the
/// keys as the agent's helpers do, `agent-endpoint-key` and the literature
/// tools, and prints them.
#[test]
fn key_probe() {
    if std::env::var_os(KEY_PROBE).is_none() {
        return;
    }
    let endpoint = crate::model_endpoint::helper_key(std::env::var_os(ENDPOINT_VARIABLE));
    let openalex = crate::literature_credentials::openalex_key();
    let contact = crate::literature_credentials::crossref_contact();
    println!(
        "{}\n{}\n{}",
        endpoint.unwrap_or_default().unwrap_or_default(),
        openalex.unwrap_or_default().unwrap_or_default(),
        contact.unwrap_or_default().unwrap_or_default(),
    );
}

/// Whether any file under `dir` holds `needle`, leaving out `skipped`: the
/// filter's mount, which is the whole file system again.
fn written_anywhere(dir: &Path, skipped: &Path, needle: &str) -> bool {
    fs::read_dir(dir).into_iter().flatten().flatten().any(|entry| {
        let path = entry.path();
        if path.starts_with(skipped) {
            return false;
        }
        if path.is_dir() && !path.is_symlink() {
            return written_anywhere(&path, skipped, needle);
        }
        fs::read(&path).is_ok_and(|bytes| {
            bytes.windows(needle.len()).any(|window| window == needle.as_bytes())
        })
    })
}

/// The keys Lattice reads outside the sandbox reach the helpers inside it
/// through the environment bubblewrap passes on, never as an argument
/// another process could list, and the agent's folders hold none of them.
#[test]
fn the_sandbox_gets_the_keys_lattice_passes_in_and_writes_none() {
    if !guard_available() {
        return;
    }
    let sandbox = Sandbox::new();
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let endpoint = format!("sk-endpoint-{tag}");
    let openalex = format!("openalex-{tag}");
    let vault = serde_json::json!({ "openalex": openalex, "crossref_email": "person@example.org" });

    let test = module_path!().split_once("::").map_or(module_path!(), |(_, path)| path);
    let test = format!("{test}::key_probe");
    let executable = std::env::current_exe().unwrap();
    let mut command = sandbox.program(&[executable.as_os_str(), "--exact".as_ref(), test.as_ref()]);
    command
        .args(["--nocapture", "--quiet"])
        .env(KEY_PROBE, "1")
        .env(ENDPOINT_VARIABLE, &endpoint)
        .env(LITERATURE_VARIABLE, vault.to_string())
        .stderr(Stdio::null());
    let arguments: Vec<_> = command.get_args().map(|argument| argument.to_os_string()).collect();
    for secret in [&endpoint, &openalex] {
        assert!(!arguments
            .iter()
            .any(|argument| argument.to_string_lossy().contains(secret.as_str())));
    }
    let output = command.output().expect("run the probe in the sandbox");
    assert!(output.status.success(), "the probe failed in the sandbox");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<_> = stdout.lines().filter(|line| !line.is_empty()).collect();
    assert!(lines.contains(&endpoint.as_str()), "the endpoint key did not arrive: {stdout}");
    assert!(lines.contains(&openalex.as_str()), "the literature key did not arrive: {stdout}");
    assert!(lines.contains(&"person@example.org"), "the contact did not arrive: {stdout}");

    let app_data = fs::canonicalize(&*sandbox._app_data).unwrap();
    let mounts = sandbox.mountpoint.0.parent().unwrap();
    for secret in [&endpoint, &openalex] {
        assert!(
            !written_anywhere(&app_data, mounts, secret),
            "a key was written under the agent's folder"
        );
    }
    eprintln!("checked the keys Lattice passes in: they arrive inside and are written nowhere");
}
