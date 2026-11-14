//! The `rtex serve` JSON-lines protocol, as `src/live-preview/rtex-protocol.ts`
//! types it (adapted there from realtime-tex-vsc-plugin's `src/protocol.ts`,
//! MIT License, Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md).
//! Display lists use the JSON mirror of realtime-tex's `docs/DISPLAY_LIST.md`.
//!
//! Lengths are scaled points (sp, 65536 to the TeX point), read as `f64`:
//! rtex prints some of them as floats (a font's `size`). Only the fields the
//! renderer and the session read are typed; the rest are skipped.

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// 1 bp (a PDF point) is 65781.76 sp; 1 pt is 65536 sp.
pub const SP_PER_BP: f64 = 65781.76;

/// One TeX point in sp.
pub const PT: f64 = 65536.;

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Versions {
    #[serde(default)]
    pub source_revision: u64,
    #[serde(default)]
    pub layout_version: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct FontDesc {
    #[serde(default)]
    pub id: u64,
    pub name: Option<String>,
    pub psname: Option<String>,
    pub filename: Option<String>,
    pub size: Option<f64>,
    pub slant: Option<f64>,
    pub extend: Option<f64>,
    pub subfont: Option<i64>,
}

impl FontDesc {
    /// The key of the font *resource* (outline data) the descriptor needs.
    /// Font ids are per process; sizes and transforms come from the
    /// descriptor, so one resource serves every size of a font file
    /// (`fontKey`).
    pub fn key(&self) -> String {
        match &self.filename {
            Some(file) => format!("file:{file}#{}", self.subfont.unwrap_or(0)),
            None => format!(
                "tfm:{}",
                self.name.clone().unwrap_or_else(|| self.id.to_string())
            ),
        }
    }
}

/// A display-list item (`docs/DISPLAY_LIST.md`):
/// `["g",font,char,index,x,y,w,ef]`, `["r",x,y_top,w,h]`,
/// `["c",stack,cmd,data]`, `["l",mode,data]`, `["u",kind,detail]`,
/// `["m","on"|"off",x]`, `["i",index,x,y_top,w,h]` and
/// `["M","save"|"set"|"restore",x,y,data]`.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Glyph {
        font: u64,
        char: u32,
        index: Option<u32>,
        x: f64,
        y: f64,
        ef: f64,
    },
    Rule {
        x: f64,
        y_top: f64,
        w: f64,
        h: f64,
    },
    Color {
        stack: u64,
        cmd: Option<u64>,
        data: String,
    },
    /// A PDF literal (`l`): drawing the renderer cannot reproduce.
    Literal,
    /// Something rtex could not describe (`u`), with its kind and detail.
    Unknown {
        kind: String,
        detail: Value,
    },
    Image {
        index: u64,
        x: f64,
        y_top: f64,
        w: f64,
        h: f64,
    },
    Matrix {
        op: String,
        x: f64,
        y: f64,
        data: String,
    },
    /// Anything else (`m`, a newer tag): drawn as nothing.
    Other,
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.)
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_string()
}

impl Item {
    fn from_array(values: &[Value]) -> Item {
        let tag = values.first().and_then(Value::as_str).unwrap_or_default();
        let at = |ix: usize| values.get(ix);
        match tag {
            "g" => Item::Glyph {
                font: number(at(1)) as u64,
                char: number(at(2)) as u32,
                index: at(3).and_then(Value::as_f64).map(|index| index as u32),
                x: number(at(4)),
                y: number(at(5)),
                ef: number(at(7)),
            },
            "r" => Item::Rule {
                x: number(at(1)),
                y_top: number(at(2)),
                w: number(at(3)),
                h: number(at(4)),
            },
            "c" => Item::Color {
                stack: number(at(1)) as u64,
                cmd: at(2).and_then(Value::as_f64).map(|cmd| cmd as u64),
                data: string(at(3)),
            },
            "l" => Item::Literal,
            "u" => Item::Unknown {
                kind: string(at(1)),
                detail: at(2).cloned().unwrap_or(Value::Null),
            },
            "i" => Item::Image {
                index: number(at(1)) as u64,
                x: number(at(2)),
                y_top: number(at(3)),
                w: number(at(4)),
                h: number(at(5)),
            },
            "M" => Item::Matrix {
                op: string(at(1)),
                x: number(at(2)),
                y: number(at(3)),
                data: string(at(4)),
            },
            _ => Item::Other,
        }
    }
}

impl<'de> Deserialize<'de> for Item {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let values = Vec::<Value>::deserialize(deserializer)?;
        Ok(Item::from_array(&values))
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Line {
    pub unit: Option<u64>,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub d: f64,
    #[serde(default)]
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ImageInfo {
    #[serde(default)]
    pub file: String,
    pub page: Option<u32>,
    /// A TikZ picture the background pass reused from an earlier pass's PDF
    /// (the page is degraded and drawn from the PDF).
    #[serde(default)]
    pub cached_picture: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct DisplayList {
    #[serde(default)]
    pub fonts: HashMap<String, FontDesc>,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub other: Vec<Item>,
    /// Material the renderer cannot draw, named by key: a non-empty object.
    #[serde(default)]
    pub flags: Value,
    pub images_info: Option<HashMap<String, ImageInfo>>,
}

impl DisplayList {
    /// The flags rtex raised, when they are an object naming some.
    pub fn flag_names(&self) -> Vec<String> {
        self.flags
            .as_object()
            .map(|flags| flags.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Fragment {
    pub page: u32,
    pub first_line: usize,
    #[serde(default)]
    pub last_line: usize,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub xs: Vec<f64>,
    #[serde(default)]
    pub baselines: Vec<f64>,
    #[serde(default)]
    pub approximate: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Placement {
    pub par_id: u64,
    #[serde(default)]
    pub fragments: Vec<Fragment>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PageUpdate {
    pub page: u32,
    #[serde(default)]
    pub exact: bool,
    pub dl: DisplayList,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "state")]
pub enum Convergence {
    Converged,
    Converging,
    PassLimitReached,
    Stale,
    #[serde(other)]
    Unknown,
}

impl Convergence {
    pub fn settled(&self) -> bool {
        matches!(self, Convergence::Converged | Convergence::PassLimitReached)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "state")]
pub enum CompileStatus {
    Ok,
    CompiledWithErrors,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ParagraphUpdate {
    pub par_id: u64,
    pub versions: Versions,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub fragments: Vec<Fragment>,
    #[serde(default)]
    pub pagination_stale: bool,
    pub dl: DisplayList,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LayoutUpdate {
    pub versions: Versions,
    pub compile: CompileStatus,
    pub convergence: Convergence,
    #[serde(default)]
    pub pages_changed: Vec<PageUpdate>,
    #[serde(default)]
    pub pages_total: u32,
    #[serde(default)]
    pub placements: Vec<Placement>,
    pub pdf_fallback: Option<String>,
}

/// One line rtex printed: an event or a reply to a command.
#[derive(Debug)]
pub enum Message {
    EngineState {
        engine_generation: u64,
        state: String,
        reason: Option<String>,
    },
    Layout(Box<LayoutUpdate>),
    Paragraph(Box<ParagraphUpdate>),
    BackgroundScheduled,
    /// Lattice's own: rtex exited without being asked to
    /// (lattice-core's `live_preview/session.rs`).
    SessionExited {
        stderr: String,
    },
    /// An event the session does not act on (`Diagnostics`, `PdfExported`).
    OtherEvent(String),
    Reply(Reply),
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditOutcome {
    #[serde(default)]
    pub removed: Vec<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditResult {
    #[serde(default)]
    pub source_revision: u64,
    #[serde(default)]
    pub outcome: EditOutcome,
    #[serde(default)]
    pub routed: String,
}

#[derive(Debug)]
pub enum Reply {
    /// `edit` and `set_document`.
    Edit(EditResult),
    Status { source_revision: u64 },
    /// `request_layout`, `spans`, `error` and anything newer.
    Other(String),
}

/// Parse one line rtex (or lattice-core, for `SessionExited`) printed.
pub fn parse(line: &str) -> Option<Message> {
    let value: Value = serde_json::from_str(line).ok()?;
    if let Some(reply) = value.get("reply").and_then(Value::as_str) {
        return Some(Message::Reply(match reply {
            "edit" | "set_document" => Reply::Edit(
                serde_json::from_value(value.get("result").cloned().unwrap_or(Value::Null))
                    .unwrap_or_default(),
            ),
            "status" => Reply::Status {
                source_revision: value
                    .pointer("/versions/source_revision")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            },
            other => Reply::Other(other.to_string()),
        }));
    }
    let event = value.get("event").and_then(Value::as_str)?.to_string();
    Some(match event.as_str() {
        "EngineState" => Message::EngineState {
            engine_generation: value
                .get("engine_generation")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            state: string(value.get("state")),
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        "LayoutUpdate" => Message::Layout(Box::new(serde_json::from_value(value).ok()?)),
        "ParagraphUpdate" => Message::Paragraph(Box::new(serde_json::from_value(value).ok()?)),
        "BackgroundScheduled" => Message::BackgroundScheduled,
        "SessionExited" => Message::SessionExited {
            stderr: string(value.get("stderr")),
        },
        _ => Message::OtherEvent(event),
    })
}

/// What the window may send; lattice-core refuses the rest (`export_pdf`,
/// `quit`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    Edit {
        path: String,
        start: usize,
        end: usize,
        text: String,
    },
    SetDocument {
        path: String,
        text: String,
    },
    Status,
    RequestLayout,
}

impl Command {
    /// A text change: rtex numbers each with a source revision.
    pub fn changes_text(&self) -> bool {
        matches!(self, Command::Edit { .. } | Command::SetDocument { .. })
    }

    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_list_items_read_from_their_arrays() {
        let line: Line = serde_json::from_str(
            r#"{"x":1,"y":2,"w":3,"h":4,"d":5,"unit":7,"items":[
                ["g",15,49,82,8799518,8865054,531313,0],
                ["c",0,null,"1 0 0 rg 1 0 0 RG"],
                ["r",1.5,2,3,4],
                ["i",1,0,0,10,20],
                ["M","set",1,2,"1 0 0 1"],
                ["l","page","q"],
                ["u","cached_picture","1 0 0 5 5"],
                ["m","on",3]
            ]}"#,
        )
        .unwrap();
        assert_eq!(line.unit, Some(7));
        assert_eq!(
            line.items[0],
            Item::Glyph {
                font: 15,
                char: 49,
                index: Some(82),
                x: 8799518.,
                y: 8865054.,
                ef: 0.
            }
        );
        assert!(matches!(&line.items[1], Item::Color { cmd: None, data, .. } if data.contains("rg")));
        assert!(matches!(line.items[2], Item::Rule { x, .. } if x == 1.5));
        assert!(matches!(line.items[3], Item::Image { index: 1, h, .. } if h == 20.));
        assert!(matches!(&line.items[4], Item::Matrix { op, .. } if op == "set"));
        assert_eq!(line.items[5], Item::Literal);
        assert!(matches!(&line.items[6], Item::Unknown { kind, .. } if kind == "cached_picture"));
        assert_eq!(line.items[7], Item::Other);
    }

    #[test]
    fn events_and_replies_parse() {
        let status = parse(r#"{"convergence":null,"reply":"status","versions":{"source_revision":1}}"#);
        assert!(matches!(
            status,
            Some(Message::Reply(Reply::Status { source_revision: 1 }))
        ));
        let edit = parse(
            r#"{"reply":"edit","result":{"edit_id":1,"outcome":{"added":[],"removed":[4],"touched":[3]},"routed":"fast","source_revision":2}}"#,
        );
        assert!(matches!(
            edit,
            Some(Message::Reply(Reply::Edit(EditResult { source_revision: 2, ref outcome, ref routed })))
                if outcome.removed == [4] && routed == "fast"
        ));
        let layout = parse(
            r#"{"event":"LayoutUpdate","versions":{"source_revision":1,"layout_version":1},"compile":{"state":"Ok"},"convergence":{"state":"Converged"},"pages_changed":[{"page":1,"exact":true,"hash":14491253209492887728,"dl":{"fonts":{},"lines":[],"other":[],"flags":[]}}],"pages_total":1,"placements":[{"par_id":2,"fragments":[{"page":1,"first_line":1,"last_line":1,"x":5,"xs":[5],"baselines":[9],"approximate":false}],"lines":1,"kind":"par"}],"pdf_fallback":null}"#,
        );
        let Some(Message::Layout(layout)) = layout else {
            panic!("a layout");
        };
        assert!(layout.convergence.settled());
        assert_eq!(layout.pages_changed[0].page, 1);
        assert_eq!(layout.placements[0].fragments[0].baselines, [9.]);
        assert!(matches!(
            parse(r#"{"event":"Diagnostics","source":"background","items":[]}"#),
            Some(Message::OtherEvent(_))
        ));
    }

    #[test]
    fn commands_serialize_as_rtex_reads_them() {
        let edit = Command::Edit {
            path: "main.tex".into(),
            start: 3,
            end: 3,
            text: "a\nb".into(),
        };
        assert_eq!(
            edit.line(),
            r#"{"cmd":"edit","path":"main.tex","start":3,"end":3,"text":"a\nb"}"#
        );
        assert_eq!(Command::RequestLayout.line(), r#"{"cmd":"request_layout"}"#);
        assert_eq!(Command::Status.line(), r#"{"cmd":"status"}"#);
        assert!(lattice_core::live_preview::allowed_command(&edit.line()).is_ok());
    }
}
