//! NDJSON bridge with explicit stdin-only controls for its owned staged workspace.
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
const OWNER: &str = "cli:ndjson";
const CLIENT: &str = "cli-ndjson-bridge";
struct Cleanup(Arc<crate::agent_runtime::Hub>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.close_all();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HostCommand {
    id: String,
    #[serde(rename = "latticeHostCommand")]
    command: String,
}
async fn emit(
    stdout: &mut tokio::io::Stdout, agent: &Arc<std::sync::Mutex<crate::agent_runtime::Running>>,
    value: &Value,
) -> Result<(), String> {
    let output = agent.lock().unwrap().redact(&value.to_string());
    stdout.write_all(format!("{output}\n").as_bytes()).await.map_err(|e| e.to_string())?;
    stdout.flush().await.map_err(|e| e.to_string())
}
fn host_record(value: Value) -> Result<HostCommand, Value> {
    let id = value.get("id").and_then(Value::as_str).filter(|id| id.len() <= 200);
    let error = json!({"_tag":"LatticeHostResult","id":id,"ok":false,"error":{"code":"invalid_host_command","message":"Use only id (1–200 UTF-8 bytes) and latticeHostCommand (status, apply or stop)."}});
    let parsed: HostCommand = serde_json::from_value(value.clone()).map_err(|_| error.clone())?;
    if parsed.id.is_empty() || parsed.id.len() > 200 {
        return Err(error);
    }
    Ok(parsed)
}
// A fresh owned server has a fresh instance ID. Negotiate inside this process,
// rather than asking callers to supply a stale ID from a previous CLI launch.
async fn feature_url(mut url: reqwest::Url) -> Result<reqwest::Url, String> {
    if url.path() != "/ws" {
        return Ok(url);
    }
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .ok_or("Missing private RPC token")?;
    let mut negotiation = url.clone();
    negotiation.set_scheme("http").map_err(|_| "Invalid RPC scheme")?;
    negotiation.set_path("/ws/negotiate");
    negotiation.set_query(None);
    negotiation.query_pairs_mut().extend_pairs([
        ("token", token.as_str()),
        ("x-synara-client-build", "lattice-cli"),
        ("x-synara-protocol-epoch", "1"),
        ("x-synara-protocol-min-revision", "3"),
        ("x-synara-protocol-max-revision", "3"),
    ]);
    let client = crate::http::async_builder()
        .no_proxy()
        .referer(false)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not create CLI negotiation client")?;
    let value: Value = client
        .get(negotiation)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| "Agent protocol negotiation failed")?
        .json()
        .await
        .map_err(|_| "Invalid agent protocol negotiation response")?;
    let instance = value
        .get("serverInstanceId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or("Missing agent instance identity")?;
    if value.get("protocolEpoch").and_then(Value::as_u64) != Some(1)
        || value.get("negotiatedRevision").and_then(Value::as_u64) != Some(3)
    {
        return Err("Unsupported agent protocol version".into());
    }
    url.set_query(None);
    url.query_pairs_mut().extend_pairs([
        ("token", token.as_str()),
        ("x-synara-client-build", "lattice-cli"),
        ("x-synara-protocol-epoch", "1"),
        ("x-synara-protocol-revision", "3"),
        ("x-synara-server-instance", instance),
    ]);
    Ok(url)
}
pub async fn run(
    runtime: PathBuf, project: PathBuf, state_dir: PathBuf, path: String,
) -> Result<(), String> {
    let core = crate::dispatch::Core::new(&project, &state_dir)?;
    let hub = Arc::new(crate::agent_runtime::Hub::new(Some(runtime), state_dir)?);
    // Also closes the child on malformed input, socket/stdio errors and early returns.
    let _cleanup = Cleanup(hub.clone());
    let starter = hub.clone();
    let root = core.root.clone();
    tokio::task::spawn_blocking(move || {
        starter.invoke(OWNER, CLIENT, &root, "synara_ensure_ready")
    })
    .await
    .map_err(|_| "Could not start agent".to_string())??;
    let agent = hub.get(OWNER, &core.root)?;
    let url = {
        let agent = agent.lock().unwrap();
        let mut url = reqwest::Url::parse(&format!(
            "ws://127.0.0.1:{}{}",
            agent.port,
            if path.starts_with('/') { path } else { format!("/{path}") }
        ))
        .map_err(|_| "Invalid RPC path".to_string())?;
        url.query_pairs_mut().append_pair("token", &agent.token);
        url
    };
    let url = feature_url(url).await?;
    let (socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|_| {
        "Agent RPC connection refused; use --path /ws for automatic protocol negotiation."
            .to_string()
    })?;
    let (mut sender, mut receiver) = socket.split();
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    loop {
        tokio::select! {
            line=input.next_line()=>{
                let Some(line)=line.map_err(|e|e.to_string())? else{break};
                let mut value:Value=serde_json::from_str(&line).map_err(|_|"RPC input must be one JSON object per line".to_string())?;
                if !value.is_object() { return Err("RPC input must be a JSON object".into()); }
                // Only user stdin reaches this branch. Sidecar output is never
                // interpreted as a host command, regardless of its JSON shape.
                if value.get("latticeHostCommand").is_some() {
                    let control = match host_record(value) {
                        Ok(control) => control,
                        Err(error) => {emit(&mut stdout,&agent,&error).await?;continue;}
                    };
                    let command=match control.command.as_str(){
                        "status"=>"headless_agent_status",
                        "apply"=>"headless_agent_apply",
                        "stop"=>"headless_agent_stop",
                        _=>{emit(&mut stdout,&agent,&json!({"_tag":"LatticeHostResult","id":control.id,"ok":false,"error":{"code":"unsupported_host_command","message":"Supported host commands: status, apply, stop."}})).await?;continue;}
                    };
                    let owned=hub.clone();let root=core.root.clone();
                    let result=tokio::task::spawn_blocking(move||owned.invoke(OWNER,CLIENT,&root,command)).await.map_err(|_|"Host command failed".to_string())?;
                    let response=match result {
                        Ok(result)=>json!({"_tag":"LatticeHostResult","id":control.id,"command":control.command,"ok":true,"result":result}),
                        Err(_)=>json!({"_tag":"LatticeHostResult","id":control.id,"command":control.command,"ok":false,"error":{"code":"host_command_failed","message":"The checked host operation was refused or could not be completed."}}),
                    };
                    emit(&mut stdout,&agent,&response).await?;
                    if command=="headless_agent_stop" {break;}
                    continue;
                }
                agent.lock().unwrap().map(&mut value,true);
                tokio::time::timeout(std::time::Duration::from_secs(2), sender.send(tokio_tungstenite::tungstenite::Message::Text(value.to_string().into()))).await.map_err(|_|"Agent RPC send timed out".to_string())?.map_err(|_|"Agent RPC stopped".to_string())?;
            },
            message=receiver.next()=>{
                let Some(Ok(message))=message else{break};
                if let tokio_tungstenite::tungstenite::Message::Text(text)=message{
                    let mut value:Value=serde_json::from_str(&text).map_err(|_|"Invalid agent RPC response".to_string())?;
                    agent.lock().unwrap().map(&mut value,false);
                    // Only this bridge creates trusted host acknowledgements.
                    // Preserve ordinary Synara frames; mark reserved-looking
                    // sidecar data explicitly so it cannot forge a host result.
                    if value.get("_tag").and_then(Value::as_str)==Some("LatticeHostResult")
                        || value.get("latticeHostCommand").is_some() {
                        value=json!({"_tag":"LatticeAgentMessage","message":value});
                    }
                    emit(&mut stdout,&agent,&value).await?;
                }
            },
            _=tokio::signal::ctrl_c()=>break,
        }
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sender.close()).await;
    Ok(())
}
