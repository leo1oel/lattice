//! NDJSON bridge to the same supervised agent RPC socket used by the browser.
use futures_util::{SinkExt, StreamExt};
use std::{path::PathBuf, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
pub async fn run(
    runtime: PathBuf, project: PathBuf, state_dir: PathBuf, path: String,
) -> Result<(), String> {
    let core = crate::dispatch::Core::new(&project, &state_dir)?;
    let hub = Arc::new(crate::agent_runtime::Hub::new(Some(runtime), state_dir)?);
    let starter = hub.clone();
    let root = core.root.clone();
    tokio::task::spawn_blocking(move || {
        starter.invoke("cli:ndjson", "cli-ndjson-bridge", &root, "synara_ensure_ready")
    })
    .await
    .map_err(|_| "Could not start agent".to_string())??;
    let agent = hub.get("cli:ndjson", &core.root)?;
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
    let (socket,_)=tokio_tungstenite::connect_async(url.as_str()).await.map_err(|_|"Agent RPC connection refused; use /ws/bootstrap to negotiate protocol capabilities first.".to_string())?;
    let (mut sender, mut receiver) = socket.split();
    let mut input = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    loop {
        tokio::select! {
            line=input.next_line()=>{let Some(line)=line.map_err(|e|e.to_string())? else{break};let mut value:serde_json::Value=serde_json::from_str(&line).map_err(|_|"RPC input must be one JSON object per line".to_string())?;agent.lock().unwrap().map(&mut value,true);tokio::time::timeout(std::time::Duration::from_secs(2), sender.send(tokio_tungstenite::tungstenite::Message::Text(value.to_string().into()))).await.map_err(|_|"Agent RPC send timed out".to_string())?.map_err(|_|"Agent RPC stopped".to_string())?;},
            message=receiver.next()=>{let Some(Ok(message))=message else{break};if let tokio_tungstenite::tungstenite::Message::Text(text)=message{let mut value:serde_json::Value=serde_json::from_str(&text).map_err(|_|"Invalid agent RPC response".to_string())?;agent.lock().unwrap().map(&mut value,false);stdout.write_all(format!("{}\n",agent.lock().unwrap().redact(&value.to_string())).as_bytes()).await.map_err(|e|e.to_string())?;stdout.flush().await.map_err(|e|e.to_string())?;}},
            _=tokio::signal::ctrl_c()=>break,
        }
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sender.close()).await;
    hub.close_all();
    Ok(())
}
