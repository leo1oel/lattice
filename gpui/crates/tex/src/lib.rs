//! TeX for the prototype: finding the distribution, running latexmk, and
//! turning its output into diagnostics.

pub mod build;
pub mod discovery;
pub mod log;

pub use build::{BuildOutcome, Engine, build, find_main_document};
pub use log::{Diagnostic, Level};
