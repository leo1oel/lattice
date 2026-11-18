//! The Tauri adapter's tests (`agent-canvas-excalidraw-adapter.test.ts`), on
//! the native board with upstream's test measurement (10px per character).

use serde_json::{Value, json};

use super::{ToolError, execute};
use crate::board::text_measure::TestMeasure;
use crate::board::types::{BoundType, Element};

struct Board {
    elements: Vec<Element>,
    writable: bool,
    commits: usize,
}

impl Board {
    fn new() -> Self {
        Board {
            elements: vec![],
            writable: true,
            commits: 0,
        }
    }

    fn run(&mut self, action: &str, args: Value) -> Result<Value, ToolError> {
        let args = args.as_object().unwrap().clone();
        let (result, next) = execute(&self.elements, action, &args, self.writable, &TestMeasure)?;
        if let Some(next) = next {
            self.elements = next;
            self.commits += 1;
        }
        Ok(result)
    }

    fn shapes(&mut self, action: &str, list: Value) -> Vec<Value> {
        let result = self.run(action, json!({ "shapes": list })).unwrap();
        result["shapes"].as_array().unwrap().clone()
    }

    fn fails(&mut self, action: &str, args: Value) -> String {
        self.run(action, args).unwrap_err().message
    }

    fn element(&self, id: &str) -> &Element {
        self.elements.iter().find(|e| e.id == id).unwrap()
    }

    fn live(&self) -> usize {
        self.elements.iter().filter(|e| !e.is_deleted).count()
    }
}

fn has(value: &Value, expected: Value) {
    for (key, want) in expected.as_object().unwrap() {
        assert_eq!(&value[key], want, "{key} of {value}");
    }
}

#[test]
fn creates_lists_updates_and_deletes_shapes_in_the_tldraw_era_wire_format() {
    let mut b = Board::new();
    let made = b.shapes("create", json!([{ "id": "shape:box", "type": "rectangle", "x": 10, "y": 20, "width": 200, "height": 80, "text": "Result" }]));
    has(
        &made[0],
        json!({ "id": "shape:box", "type": "rectangle", "x": 10, "y": 20, "width": 200, "height": 80, "text": "Result", "fill": "none", "isLocked": false, "opacity": 1 }),
    );
    let label = b.element("box").bound_elements.as_ref().unwrap()[0]
        .id
        .clone();
    assert_eq!(
        b.element("box").bound_elements.as_ref().unwrap()[0].kind,
        BoundType::Text
    );
    assert_eq!(b.element(&label).text().unwrap().text, "Result");
    assert_eq!(b.element(&label).container_id(), Some("box"));
    let listing = b.run("list", json!({})).unwrap();
    has(
        &listing,
        json!({ "total": 1, "hasMore": false, "offset": 0, "nextOffset": 1 }),
    );
    assert_eq!(listing["shapes"][0]["id"], "shape:box");

    let offset = b.element(&label).x - b.element("box").x;
    let moved = b.shapes(
        "update",
        json!([{ "id": "shape:box", "x": 40, "color": "blue", "fill": "solid" }]),
    );
    has(
        &moved[0],
        json!({ "x": 40, "color": "#1971c2", "backgroundColor": "#a5d8ff", "fill": "solid", "text": "Result" }),
    );
    assert_eq!(b.element(&label).x, 40. + offset);

    let relabelled = b.shapes("update", json!([{ "id": "shape:box", "text": "Context" }]));
    assert_eq!(relabelled[0]["text"], "Context");
    assert!(b.element(&label).is_deleted);

    assert_eq!(
        b.run("delete", json!({ "ids": ["shape:box"] })).unwrap(),
        json!({ "deletedIds": ["shape:box"] })
    );
    assert_eq!(b.live(), 0);
    has(
        &b.run("list", json!({})).unwrap(),
        json!({ "shapes": [], "total": 0 }),
    );
}

#[test]
fn makes_notes_text_lines_strokes_highlights_and_frames_in_one_step_per_call() {
    let mut b = Board::new();
    let made = b.shapes("create", json!([
        { "id": "shape:note", "type": "sticky", "x": 0, "y": 0, "text": "Idea" },
        { "id": "shape:title", "type": "text", "x": 0, "y": 300, "text": "Title" },
        { "id": "shape:rule", "type": "line", "x": 0, "y": 400, "width": 300 },
        { "id": "shape:scribble", "type": "draw", "x": 0, "y": 500, "points": [[0, 0], [10, 5], [20, 0]] },
        { "id": "shape:mark", "type": "highlight", "x": 0, "y": 600, "points": [[0, 0], [50, 0]], "color": "green" },
        { "id": "shape:area", "type": "frame", "x": 500, "y": 0, "text": "Section" },
    ]));
    let types: Vec<&str> = made.iter().map(|s| s["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        ["note", "text", "line", "draw", "highlight", "frame"]
    );
    has(
        &made[0],
        json!({ "width": 200, "height": 200, "backgroundColor": "#ffec99", "text": "Idea" }),
    );
    has(&made[1], json!({ "text": "Title", "width": 50 }));
    assert_eq!(made[2]["points"], json!([[0, 0], [300, 0]]));
    has(&made[4], json!({ "color": "#69db7c", "opacity": 0.5 }));
    has(
        &made[5],
        json!({ "text": "Section", "width": 400, "height": 300 }),
    );
    assert_eq!(
        (b.element("rule").roughness, b.element("rule").stroke_width),
        (0., 2.)
    );
    assert_eq!(b.commits, 1);

    let title = b.shapes(
        "update",
        json!([{ "id": "shape:title", "text": "A longer title", "frameId": "shape:area" }]),
    );
    has(
        &title[0],
        json!({ "text": "A longer title", "width": 140, "frameId": "shape:area" }),
    );
}

#[test]
fn binds_an_arrows_ends_to_shapes_and_unbinds_them_when_a_shape_goes() {
    let mut b = Board::new();
    b.shapes("create", json!([{ "id": "shape:a", "type": "ellipse" }, { "id": "shape:b", "type": "diamond", "x": 400 }]));
    let arrow = b.shapes("create", json!([{ "id": "shape:link", "type": "arrow", "x": 160, "y": 50, "points": [[0, 0], [240, 0]], "startBinding": "shape:a", "endBinding": "shape:b", "text": "uses" }]));
    has(
        &arrow[0],
        json!({ "startBinding": "shape:a", "endBinding": "shape:b", "text": "uses" }),
    );
    let bound = |b: &Board, id: &str| -> Vec<String> {
        b.element(id)
            .bound_elements
            .iter()
            .flatten()
            .map(|e| e.id.clone())
            .collect()
    };
    assert_eq!(bound(&b, "b"), ["link"]);
    b.shapes(
        "update",
        json!([{ "id": "shape:link", "endBinding": null }]),
    );
    assert!(bound(&b, "b").is_empty());
    assert!(b.element("link").linear().unwrap().end_binding.is_none());
    b.run("delete", json!({ "ids": ["shape:a"] })).unwrap();
    assert!(b.element("link").linear().unwrap().start_binding.is_none());
    assert!(!b.element("link").is_deleted);
}

#[test]
fn refuses_what_the_contract_refuses() {
    let mut b = Board::new();
    b.shapes("create", json!([{ "id": "shape:pinned", "type": "rectangle", "isLocked": true }, { "id": "shape:rule", "type": "line" }]));
    let cases = [
        (
            "create",
            json!({ "shapes": [{ "type": "cloud" }] }),
            "Unsupported canvas shape type: cloud",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "rectangle", "id": "box" }] }),
            "Shape ids must use the form shape:<letters, numbers, _ or ->.",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "rectangle", "id": "shape:pinned" }] }),
            "Canvas shape already exists: shape:pinned",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "rectangle", "color": "teal" }] }),
            "Unsupported canvas color.",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "draw" }] }),
            "points must hold between 2 and 2000 [x, y] pairs.",
        ),
        (
            "create",
            json!({ "shapes": [] }),
            "shapes must contain between 1 and 100 items.",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "note", "props": { "__proto__": { "polluted": true } } }] }),
            "Raw canvas props are not supported.",
        ),
        (
            "create",
            json!({ "shapes": [{ "type": "rectangle", "x": 1e9 }] }),
            "x must be between -10000000 and 10000000.",
        ),
        (
            "update",
            json!({ "shapes": [{ "id": "shape:pinned", "x": 1 }] }),
            "Canvas shape is locked: shape:pinned",
        ),
        (
            "update",
            json!({ "shapes": [{ "id": "shape:gone", "x": 1 }] }),
            "Canvas shape not found: shape:gone",
        ),
        (
            "update",
            json!({ "shapes": [{ "id": "shape:rule", "text": "no" }] }),
            "The line shape type does not accept text.",
        ),
        (
            "update",
            json!({ "shapes": [{ "id": "shape:rule", "startBinding": "shape:pinned" }] }),
            "Only arrows bind to shapes.",
        ),
        (
            "update",
            json!({ "shapes": [{ "id": "shape:rule", "frameId": "shape:pinned" }] }),
            "Not a frame: shape:pinned",
        ),
        (
            "delete",
            json!({ "ids": ["shape:pinned"] }),
            "Canvas shape is locked: shape:pinned",
        ),
        (
            "list",
            json!({ "limit": 1.5 }),
            "offset and limit must be integers.",
        ),
        (
            "list",
            json!({ "limit": 21 }),
            "limit must be between 1 and 20.",
        ),
    ];
    for (action, args, message) in cases {
        assert_eq!(b.fails(action, args), message);
    }
    let before = b.elements.clone();
    assert_eq!(
        b.fails(
            "create",
            json!({ "shapes": [{ "type": "rectangle" }, { "type": "cloud" }] })
        ),
        "Unsupported canvas shape type: cloud"
    );
    assert_eq!(b.elements, before, "a refused call changes nothing");
    b.writable = false;
    let refused = b
        .run("create", json!({ "shapes": [{ "type": "note" }] }))
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        ("canvas_read_only", "The active canvas is read-only.")
    );
    assert!(b.run("list", json!({})).is_ok());
}
