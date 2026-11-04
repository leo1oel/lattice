//! One generation owns a companion load. All repeated enable requests observe
//! the same result; an old page cannot make a replacement window visible.
use tokio::sync::watch;

pub const CANCELLED: &str = "The desktop companion request was cancelled.";
pub const TIMED_OUT: &str = "The desktop companion did not finish loading. Try enabling it again.";
pub const ARTWORK_FAILED: &str =
    "The desktop companion could not load its artwork. Import its package again.";

#[derive(Clone)]
pub struct Ticket {
    pub generation: String,
    result: watch::Receiver<Option<Result<(), String>>>,
}
impl Ticket {
    pub async fn wait(&mut self) -> Result<(), String> {
        loop {
            if let Some(result) = self.result.borrow().clone() {
                return result;
            }
            self.result.changed().await.map_err(|_| CANCELLED.to_string())?;
        }
    }
}
struct Launch {
    generation: String,
    result: watch::Sender<Option<Result<(), String>>>,
}
#[derive(Default)]
pub struct Launches {
    active: Option<Launch>,
    pub error: Option<String>,
}
impl Launches {
    pub fn current(&self) -> Option<Ticket> {
        self.active.as_ref().map(|active| Ticket {
            generation: active.generation.clone(),
            result: active.result.subscribe(),
        })
    }
    pub fn begin(&mut self) -> Ticket {
        if let Some(ticket) = self.current() {
            return ticket;
        }
        let (sender, result) = watch::channel(None);
        let generation = uuid::Uuid::new_v4().to_string();
        self.active = Some(Launch { generation: generation.clone(), result: sender });
        self.error = None;
        Ticket { generation, result }
    }
    pub fn owns(&self, generation: &str) -> bool {
        self.active.as_ref().is_some_and(|active| active.generation == generation)
    }
    pub fn loading(&self, generation: &str) -> bool {
        self.active.as_ref().is_some_and(|active| {
            active.generation == generation && active.result.borrow().is_none()
        })
    }
    pub fn finish(&mut self, generation: &str, result: Result<(), String>) -> bool {
        if !self.loading(generation) {
            return false;
        }
        self.error = result.as_ref().err().cloned();
        self.active.as_ref().unwrap().result.send_replace(Some(result));
        true
    }
    pub fn abandon(&mut self, generation: &str, reason: &str, remember: bool) -> bool {
        if !self.owns(generation) {
            return false;
        }
        let active = self.active.take().unwrap();
        active.result.send_replace(Some(Err(reason.into())));
        self.error = remember.then(|| reason.to_string());
        true
    }
    pub fn cancel(&mut self) {
        if let Some(generation) = self.active.as_ref().map(|active| active.generation.clone()) {
            self.abandon(&generation, CANCELLED, false);
        }
        self.error = None;
    }
}
