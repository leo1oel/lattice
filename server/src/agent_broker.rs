//! A capability-protected, project-bound literature gateway. No arbitrary IPC or paths.
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
};
pub struct Broker {
    stop: Arc<AtomicBool>,
    _worker: JoinHandle<()>,
    pub address: String,
    pub capability: String,
}
fn equal(a: &str, b: &str) -> bool {
    let mut difference = a.len() ^ b.len();
    for (i, byte) in a.bytes().enumerate() {
        difference |= usize::from(byte ^ b.as_bytes().get(i).copied().unwrap_or(0));
    }
    difference == 0
}
impl Broker {
    pub fn start(root: &Path) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?.to_string();
        let capability =
            uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
        let expected = capability.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let root = root.to_path_buf();
        let mutation = crate::project_locks::mutation(&root);
        let worker = std::thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let _ = socket.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                        let _ = socket.set_write_timeout(Some(std::time::Duration::from_secs(5)));
                        let mut bytes = Vec::new();
                        let result = BufReader::new((&socket).take(128 * 1024))
                            .read_until(b'\n', &mut bytes)
                            .map_err(|_| ())
                            .and_then(|_| {
                                serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| ())
                            })
                            .and_then(|value| {
                                if !equal(
                                    value.get("capability").and_then(|v| v.as_str()).unwrap_or(""),
                                    &expected,
                                ) {
                                    return Err(());
                                }
                                serde_json::from_value::<
                                        crate::agent_literature::LiteratureRequest,
                                    >(
                                        value.get("request").cloned().unwrap_or_default()
                                    )
                                    .map_err(|_| ())
                            })
                            .and_then(|request| {
                                let _lease = mutation.lock().map_err(|_| ())?;
                                if stopping.load(Ordering::Acquire) {
                                    return Err(());
                                }
                                request.run(&root).map_err(|_| ())
                            });
                        let response = match result {
                            Ok(value) => serde_json::json!({"result":value}),
                            Err(_) => {
                                serde_json::json!({"error":"The literature request was refused or could not be completed."})
                            }
                        };
                        let _ = writeln!(socket, "{response}");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(50))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self { stop, _worker: worker, address, capability })
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
pub fn cli() -> bool {
    if std::env::args().nth(1).as_deref() != Some("literature") {
        return false;
    }
    let Ok(address) = std::env::var("LATTICE_AGENT_BROKER_ADDR") else {
        return crate::agent_literature::run_cli();
    };
    let result = (|| -> Result<serde_json::Value, String> {
        let address: std::net::SocketAddr =
            address.parse().map_err(|_| "Invalid literature broker address".to_string())?;
        if !address.ip().is_loopback() {
            return Err("Literature broker must be loopback".into());
        }
        let mut socket =
            TcpStream::connect(address).map_err(|_| "Literature broker unavailable".to_string())?;
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(300)))
            .map_err(|e| e.to_string())?;
        let raw = std::env::args().skip(2).collect::<Vec<_>>().join(" ");
        let request: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "Invalid literature request".to_string())?;
        writeln!(socket,"{}",serde_json::json!({"capability":std::env::var("LATTICE_AGENT_BROKER_CAPABILITY").unwrap_or_default(),"request":request})).map_err(|e|e.to_string())?;
        let mut raw = String::new();
        BufReader::new(socket.take(20 * 1024 * 1024))
            .read_line(&mut raw)
            .map_err(|e| e.to_string())?;
        let response: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "Invalid broker response".to_string())?;
        response.get("result").cloned().ok_or_else(|| "Literature operation failed".to_string())
    })();
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
    true
}
