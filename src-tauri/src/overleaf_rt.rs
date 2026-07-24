use tokio::sync::oneshot;
pub fn probe() -> oneshot::Sender<()> { let (tx, _rx) = oneshot::channel(); tx }
