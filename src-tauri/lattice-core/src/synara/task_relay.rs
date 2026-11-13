//! The agent service's host tasks: compile repair and one-turn text tasks,
//! relayed to the sidecar's `/api/lattice/<route>` over loopback.

use super::SynaraRuntime;
use std::time::Duration;

/// The agent service's host task routes: compile repair edits the project; a
/// text task is one read-only turn whose final message is the answer
/// (proofreading).
pub const COMPILE_REPAIR_ROUTE: &str = "compile-repair";
pub const TEXT_TASK_ROUTE: &str = "text-task";
/// What a start answers when the running agent service predates the route, so
/// the renderer can say so instead of quoting an HTTP status.
pub const ROUTE_UNAVAILABLE: &str = "agent_route_unavailable";
/// What a compile repair status or cancel answers when the running agent
/// service does not know the thread. The route exists, since the task was
/// started on it: its poll and cancel answer an unknown thread with a
/// plain-text `Not Found` 404.
pub const TASK_UNKNOWN: &str = "agent_task_unknown";

/// One action on the task route `/api/lattice/<route>`: `start` posts
/// `payload`, `status` reads the task, `cancel` stops it. Keeps the desktop
/// token and loopback transport out of the renderer's CORS path.
pub fn task_relay_request(
    runtime: &SynaraRuntime, route: &str, action: &str, task_id: Option<&str>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let info = runtime.ensure_ready()?;
    // Where the agent is off (`bibliography_guard`), say why.
    let origin = info.origin.ok_or_else(|| {
        info.message.clone().unwrap_or_else(|| "The agent service is unavailable.".to_string())
    })?;
    let mut url = reqwest::Url::parse(&origin).map_err(|error| error.to_string())?;
    let mut segments = url.path_segments_mut().map_err(|_| "Invalid agent address.")?;
    segments.clear().extend(["api", "lattice", route]);
    match action {
        "start" => {}
        "status" | "cancel" => {
            let id = task_id.filter(|id| !id.is_empty()).ok_or("Missing agent task.")?;
            segments.push(id);
            if action == "cancel" {
                segments.push("cancel");
            }
        }
        _ => return Err("Invalid agent task action.".into()),
    }
    drop(segments);
    let client = crate::http::loopback(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request =
        if action == "status" { client.get(url) } else { client.post(url).json(&payload) };
    if let Some(token) = &info.auth_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND
        && route == COMPILE_REPAIR_ROUTE
        && action != "start"
    {
        return Err(TASK_UNKNOWN.into());
    }
    let mut value: serde_json::Value = match response.json() {
        Ok(value) => value,
        // The start routes answer JSON, even their own 404s; a bare 404 is the
        // router's, for a path this runtime does not have.
        Err(_) if status == reqwest::StatusCode::NOT_FOUND => return Err(ROUTE_UNAVAILABLE.into()),
        Err(_) => return Err(format!("The agent service returned {status}.")),
    };
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("The agent request failed.").to_string());
    }
    // The service that took the repair, which can be one this request had to
    // start: its windows hear of that restart, and must not take it for the
    // loss of this task (useCompileRepair).
    if action == "start" && route == COMPILE_REPAIR_ROUTE {
        if let Some(answer) = value.as_object_mut() {
            answer.insert("runtimeSession".into(), serde_json::json!(info.auth_token));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use crate::synara::{environment, RunningSynara};
    use std::thread;

    #[test]
    fn task_relay_preserves_payload_routes_and_server_errors() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr().to_ip().unwrap());
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in [
                (202, r#"{"threadId":"repair:one"}"#),
                (200, r#"{"status":"completed"}"#),
                (202, r#"{"status":"running"}"#),
                (409, r#"{"error":"Already repairing"}"#),
                (404, r#"{"error":"Workspace not found."}"#),
                (404, "Not Found"),
                (404, "Not Found"),
                (404, "Not Found"),
                (404, r#"{"error":"Task not found."}"#),
            ] {
                let mut request = server.recv().unwrap();
                let mut received = Vec::new();
                request.as_reader().read_to_end(&mut received).unwrap();
                requests.push((format!("{} {}", request.method(), request.url()), received));
                let response = tiny_http::Response::from_string(body).with_status_code(status);
                request.respond(response).unwrap();
            }
            requests
        });
        let mut runtime = SynaraRuntime::default();
        runtime.external_origin = Some(origin);
        let payload = serde_json::json!({
            "workspaceRoot": "/paper", "runtimeMode": "full-access", "rootDocument": "main.tex",
            "diagnostics": [
                {"level": "warning", "message": "Undefined reference", "file": "results.tex", "line": 17},
                {"level": "error", "message": "Undefined control sequence", "file": "main.tex", "line": 42}
            ]
        });
        let request = |action, thread_id, payload| {
            task_relay_request(&runtime, COMPILE_REPAIR_ROUTE, action, thread_id, payload)
        };
        let null = serde_json::Value::Null;
        assert_eq!(request("start", None, payload.clone()).unwrap()["threadId"], "repair:one");
        assert_eq!(
            request("status", Some("repair:one"), null.clone()).unwrap()["status"],
            "completed"
        );
        assert_eq!(request("cancel", Some("repair:one"), null).unwrap()["status"], "running");
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), "Already repairing");
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), "Workspace not found.");
        // A runtime without the route answers the router's plain 404.
        let text_task = serde_json::json!({"workspaceRoot": "/paper", "prompt": "Proofread"});
        assert_eq!(
            task_relay_request(&runtime, TEXT_TASK_ROUTE, "start", None, text_task.clone())
                .unwrap_err(),
            ROUTE_UNAVAILABLE
        );
        assert_eq!(request("start", None, payload.clone()).unwrap_err(), ROUTE_UNAVAILABLE);
        // latticeCompileRepairHttpRoute's poll answers a thread it does not
        // know with `HttpServerResponse.text("Not Found", { status: 404 })`.
        let null = serde_json::Value::Null;
        assert_eq!(request("status", Some("repair:gone"), null.clone()).unwrap_err(), TASK_UNKNOWN);
        // An unknown text task is a JSON 404, whose error reaches the reader as is.
        assert_eq!(
            task_relay_request(&runtime, TEXT_TASK_ROUTE, "cancel", Some("text:gone"), null)
                .unwrap_err(),
            "Task not found."
        );

        let requests = server.join().unwrap();
        assert_eq!(requests[0].0, "POST /api/lattice/compile-repair");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&requests[0].1).unwrap(), payload);
        assert_eq!(requests[1].0, "GET /api/lattice/compile-repair/repair:one");
        assert!(requests[1].1.is_empty());
        assert_eq!(requests[2].0, "POST /api/lattice/compile-repair/repair:one/cancel");
        assert_eq!(requests[5].0, "POST /api/lattice/text-task");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&requests[5].1).unwrap(), text_task);
        assert_eq!(requests[6].0, "POST /api/lattice/compile-repair");
        assert_eq!(requests[7].0, "GET /api/lattice/compile-repair/repair:gone");
        assert_eq!(requests[8].0, "POST /api/lattice/text-task/text:gone/cancel");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn repair_start_answer_names_the_service_that_took_it() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", server.server_addr().to_ip().unwrap());
        let server = thread::spawn(move || {
            let request = server.recv().unwrap();
            let token = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("Authorization"))
                .map(|header| header.value.to_string());
            let response = tiny_http::Response::from_string(r#"{"threadId":"repair:one"}"#)
                .with_status_code(202);
            request.respond(response).unwrap();
            token
        });
        let runtime = SynaraRuntime::default();
        let child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        *runtime.running.lock().unwrap() = Some(RunningSynara {
            child,
            info: runtime.ready_info(&origin, Some("launch-2"), 0),
            environment: environment::AgentEnvironment::default(),
        });
        let answer = task_relay_request(
            &runtime,
            COMPILE_REPAIR_ROUTE,
            "start",
            None,
            serde_json::json!({}),
        );
        let mut running = runtime.running.lock().unwrap().take().unwrap();
        let _ = running.child.kill();
        let _ = running.child.wait();
        let answer = answer.unwrap();
        assert_eq!(answer["threadId"], "repair:one");
        assert_eq!(answer["runtimeSession"], "launch-2");
        assert_eq!(server.join().unwrap().as_deref(), Some("Bearer launch-2"));
    }
}
