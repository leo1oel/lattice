//! Explicit Google OAuth and a closed set of Workspace API operations.
mod account;
mod api;
mod oauth;
#[cfg(test)]
mod tests;

pub use account::{disconnect, status};
pub use account::{GoogleState, GoogleStatus, OAuthClient};
pub use api::request;
pub use api::WorkspaceRequest;
pub use oauth::{begin_login, cancel_login};

use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    Docs,
    Sheets,
    Slides,
    Forms,
    Calendar,
}

impl Product {
    fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Docs => &["https://www.googleapis.com/auth/documents"],
            Self::Sheets => &["https://www.googleapis.com/auth/spreadsheets"],
            Self::Slides => &["https://www.googleapis.com/auth/presentations"],
            Self::Forms => &[
                "https://www.googleapis.com/auth/forms.body",
                "https://www.googleapis.com/auth/forms.responses.readonly",
            ],
            Self::Calendar => &[
                "https://www.googleapis.com/auth/calendar.events.owned",
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            ],
        }
    }
}
