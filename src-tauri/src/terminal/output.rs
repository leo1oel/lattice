//! Terminal output independent of the window/web transport.
use std::sync::Arc;

pub(crate) enum OutputMessage {
    Bytes(Vec<u8>),
    Exit(Option<i32>),
}

pub(crate) struct Output(Arc<dyn Fn(OutputMessage) -> Result<(), String> + Send + Sync>);
impl Output {
    pub(crate) fn new(
        send: impl Fn(OutputMessage) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(send))
    }
    pub(crate) fn send(&self, message: OutputMessage) -> Result<(), String> {
        (self.0)(message)
    }
}
