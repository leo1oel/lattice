//! Proofreading a selection with the agent, the pure half of the Tauri app's
//! `src/agent/agent-proofread.ts` and `src/agent/proofread-edits.ts`, and the
//! `heldRuns` helper of `src/canvas/proofread-card.tsx`:
//!
//! - [`prompt`] asks the agent to proofread, polish or follow the writer's
//!   instruction, byte for byte the prompt the Tauri app sends (it is model
//!   input both apps share), and [`parse_reply`] and [`parse_reasons`] read
//!   its answer;
//! - [`review`] splits the agent's revision into the edits a writer would
//!   name and holds back every one that would alter protected LaTeX
//!   ([`crate::latex::protected`]); [`with_reasons`] attaches the agent's
//!   reasons to them, and [`chosen_edits`] and [`apply_edits`] turn the
//!   writer's choice back into text.
//!
//! The agent task itself (starting, polling, cancelling) is the caller's.
//!
//! Every `from`/`to` here is a byte offset into the selection's text (the
//! GPUI editor's unit), and every one lands on a character boundary. The
//! TypeScript counts UTF-16 code units; where a count is a length the writer
//! sees rather than an offset ([`MAX_LENGTH`], the held-run gap), this counts
//! UTF-16 code units too, so both apps draw the same limits.

mod edits;
mod prompt;

pub use edits::{
    Context, Edit, HeldEdit, HeldRun, Hunk, Replacement, Review, apply_edits, chosen_edits,
    context, held_runs, phrase_hunks, protected_change, review, token_hunks, with_reasons,
};
pub use prompt::{parse_reasons, parse_reply, prompt};

/// The selection is sent whole; past this the turn is slow and the diff
/// unreadable. In UTF-16 code units, as the Tauri app counts it: see
/// [`within_max_length`].
pub const MAX_LENGTH: usize = 12_000;

/// Whether `text` is short enough to proofread, measured as the Tauri app
/// measures it (UTF-16 code units, not bytes).
pub fn within_max_length(text: &str) -> bool {
    text.encode_utf16().count() <= MAX_LENGTH
}

/// How hard the agent may edit: Proofread corrects errors and nothing else,
/// Polish also improves flow and academic clarity. ⌘⌥P is always Proofread;
/// Polish is asked for each time, never remembered as the default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Mode {
    #[default]
    Proofread,
    Polish,
}

/// What the agent is asked to do with a selection: one of the two fixed
/// strengths, or the writer's own instruction from the selection toolbar
/// ("translate into academic English", "cut to 100 words"), which may change
/// the excerpt's language when it asks for a translation.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Ask {
    Proofread,
    Polish,
    Instruction(String),
}

impl Ask {
    /// The fixed strength asked for; `None` for the writer's instruction.
    pub fn mode(&self) -> Option<Mode> {
        match self {
            Ask::Proofread => Some(Mode::Proofread),
            Ask::Polish => Some(Mode::Polish),
            Ask::Instruction(_) => None,
        }
    }
}

impl From<Mode> for Ask {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Proofread => Ask::Proofread,
            Mode::Polish => Ask::Polish,
        }
    }
}

/// What an edit is for, as the agent names it; the card shows each as a
/// short tag in the interface language. The model writes the English words
/// of [`Category::word`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    Spelling,
    Grammar,
    Punctuation,
    WordChoice,
    Clarity,
    Concision,
    Flow,
    Consistency,
    Translation,
}

impl Category {
    /// The vocabulary, in the order the prompt lists it.
    pub const ALL: [Category; 9] = [
        Category::Spelling,
        Category::Grammar,
        Category::Punctuation,
        Category::WordChoice,
        Category::Clarity,
        Category::Concision,
        Category::Flow,
        Category::Consistency,
        Category::Translation,
    ];

    /// The word the model writes for this category: model vocabulary, not
    /// interface copy.
    pub fn word(self) -> &'static str {
        match self {
            Category::Spelling => "spelling",
            Category::Grammar => "grammar",
            Category::Punctuation => "punctuation",
            Category::WordChoice => "word choice",
            Category::Clarity => "clarity",
            Category::Concision => "concision",
            Category::Flow => "flow",
            Category::Consistency => "consistency",
            Category::Translation => "translation",
        }
    }

    /// The category the model's `word` names, exactly as [`Category::word`]
    /// writes it (callers lowercase and trim first).
    pub fn parse(word: &str) -> Option<Category> {
        Category::ALL
            .into_iter()
            .find(|category| category.word() == word)
    }
}

/// The agent's account of one change: the words it replaced and what it
/// wrote instead, as it quoted them, why (a category), and an optional short
/// note in the interface language. Lattice matches these to its own edits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReasonLine {
    pub from: String,
    pub to: String,
    pub category: Option<Category>,
    pub note: String,
}

/// Why the agent made an edit: its category, and a short note when it gave
/// one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reason {
    pub category: Option<Category>,
    pub note: String,
}
