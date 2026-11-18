// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Writing scenes. Port of the serializing side of Excalidraw
//! `packages/excalidraw/data/json.ts` @ 3a317b5 (`serializeAsJSON` with
//! `"local"`, `filterOutDeletedFiles`), plus the compact scene form documents
//! embed. Reading goes through `restore.rs`.
//!
//! Output is stable: elements in the order given (a scene's z-order, which
//! is fractional-index order), keys in `types.ts` declaration order (`id`,
//! then `type`, then the base fields, then the type's own; unknown keys from
//! `extra` last, sorted), numbers formatted like JS `JSON.stringify`.
//! - `.excalidraw` files: `JSON.stringify(data, null, 2)` layout, so
//!   excalidraw.com output and ours differ only in key order.
//! - documents: `{"elements":[…],"files":{…}}`, one element / file per line.

use super::consts::{EXCALIDRAW_FILE_VERSION, EXPORT_DATA_TYPE_EXCALIDRAW};
use super::math::Point;
use super::restore::ExportedAppState;
use super::types::*;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt::Write;

/// An ordered JSON tree.
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(&'static str, J)>),
    /// Objects with dynamic keys (`extra`, `customData`, files).
    Dyn(Vec<(String, J)>),
}

/// JS `Number.prototype.toString` for finite numbers (`-0` is `"0"`).
pub fn js_number(v: f64) -> String {
    if v == 0. {
        return "0".into();
    }
    if !v.is_finite() {
        return if v.is_nan() {
            "NaN".into()
        } else if v > 0. {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    // shortest round-trip digits and exponent: "d.ddde±x"
    let e = format!("{:e}", v.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let mut s = String::new();
    if v < 0. {
        s.push('-');
    }
    if k <= n && n <= 21 {
        s.push_str(&digits);
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        s.push_str(&digits[..n as usize]);
        s.push('.');
        s.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        s.push_str("0.");
        s.extend(std::iter::repeat_n('0', (-n) as usize));
        s.push_str(&digits);
    } else {
        s.push_str(&digits[..1]);
        if k > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        let _ = write!(s, "e{}{}", if n > 0 { "+" } else { "-" }, (n - 1).abs());
    }
    s
}

fn num(v: f64) -> J {
    J::Num(v)
}
fn s(v: &str) -> J {
    J::Str(v.into())
}
fn opt_s(v: &Option<String>) -> J {
    v.as_ref().map_or(J::Null, |v| s(v))
}
fn opt_n(v: Option<f64>) -> J {
    v.map_or(J::Null, num)
}
fn point(p: &Point) -> J {
    J::Arr(vec![num(p[0]), num(p[1])])
}
fn points(ps: &[Point]) -> J {
    J::Arr(ps.iter().map(point).collect())
}

fn value(v: &Value) -> J {
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => J::Int(i),
            None => n.as_f64().map_or(J::Null, J::Num),
        },
        Value::String(t) => J::Str(t.clone()),
        Value::Array(a) => J::Arr(a.iter().map(value).collect()),
        Value::Object(o) => J::Dyn(o.iter().map(|(k, v)| (k.clone(), value(v))).collect()),
    }
}

fn binding(b: &Option<FixedPointBinding>) -> J {
    b.as_ref().map_or(J::Null, |b| {
        J::Obj(vec![
            ("elementId", s(&b.element_id)),
            ("fixedPoint", point(&b.fixed_point)),
            ("mode", s(b.mode.as_str())),
        ])
    })
}

fn element(e: &Element) -> J {
    let mut o: Vec<(&'static str, J)> = vec![
        ("id", s(&e.id)),
        ("type", s(e.ty().as_str())),
        ("x", num(e.x)),
        ("y", num(e.y)),
        ("strokeColor", s(&e.stroke_color)),
        ("backgroundColor", s(&e.background_color)),
        ("fillStyle", s(e.fill_style.as_str())),
        ("strokeWidth", num(e.stroke_width)),
        ("strokeStyle", s(e.stroke_style.as_str())),
        (
            "roundness",
            e.roundness.map_or(J::Null, |r| {
                let mut r2 = vec![("type", J::Int(r.kind as i64))];
                if let Some(v) = r.value {
                    r2.push(("value", num(v)));
                }
                J::Obj(r2)
            }),
        ),
        ("roughness", num(e.roughness)),
        ("opacity", num(e.opacity)),
        ("width", num(e.width)),
        ("height", num(e.height)),
        ("angle", num(e.angle)),
        ("seed", J::Int(e.seed)),
        ("version", J::Int(e.version)),
        ("versionNonce", J::Int(e.version_nonce)),
        ("index", opt_s(&e.index)),
        ("isDeleted", J::Bool(e.is_deleted)),
        (
            "groupIds",
            J::Arr(e.group_ids.iter().map(|g| s(g)).collect()),
        ),
        ("frameId", opt_s(&e.frame_id)),
        (
            "boundElements",
            e.bound_elements.as_ref().map_or(J::Null, |b| {
                J::Arr(
                    b.iter()
                        .map(|b| J::Obj(vec![("id", s(&b.id)), ("type", s(b.kind.as_str()))]))
                        .collect(),
                )
            }),
        ),
        ("updated", J::Int(e.updated)),
        ("created", e.created.map_or(J::Null, J::Int)),
        ("link", opt_s(&e.link)),
        ("locked", J::Bool(e.locked)),
    ];
    if let Some(c) = &e.custom_data {
        o.push(("customData", value(c)));
    }
    match &e.kind {
        Kind::Selection
        | Kind::Rectangle
        | Kind::Diamond
        | Kind::Ellipse
        | Kind::Embeddable
        | Kind::Iframe => {}
        Kind::StickyNote { base_height } => o.push(("baseHeight", num(*base_height))),
        Kind::Image(i) => {
            o.push(("fileId", opt_s(&i.file_id)));
            o.push(("status", s(i.status.as_str())));
            o.push(("scale", J::Arr(vec![num(i.scale[0]), num(i.scale[1])])));
            o.push((
                "crop",
                i.crop.map_or(J::Null, |c| {
                    J::Obj(vec![
                        ("x", num(c.x)),
                        ("y", num(c.y)),
                        ("width", num(c.width)),
                        ("height", num(c.height)),
                        ("naturalWidth", num(c.natural_width)),
                        ("naturalHeight", num(c.natural_height)),
                    ])
                }),
            ));
        }
        Kind::Frame { name } | Kind::MagicFrame { name } => o.push(("name", opt_s(name))),
        Kind::Text(t) => {
            o.extend([
                ("fontSize", num(t.font_size)),
                ("fontFamily", J::Int(t.font_family as i64)),
                ("baseFontSize", opt_n(t.base_font_size)),
                ("text", s(&t.text)),
                ("textAlign", s(t.text_align.as_str())),
                ("verticalAlign", s(t.vertical_align.as_str())),
                ("containerId", opt_s(&t.container_id)),
                ("originalText", s(&t.original_text)),
                ("autoResize", J::Bool(t.auto_resize)),
                ("lineHeight", num(t.line_height)),
            ]);
            if let Some(p) = t.label_position {
                o.push(("labelPosition", opt_n(p)));
            }
        }
        Kind::Line { linear, polygon } => {
            push_linear(&mut o, linear);
            o.push(("polygon", J::Bool(*polygon)));
        }
        Kind::Arrow { linear, elbow } => {
            push_linear(&mut o, linear);
            o.push(("elbowed", J::Bool(elbow.is_some())));
            if let Some(el) = elbow {
                o.push((
                    "fixedSegments",
                    el.fixed_segments.as_ref().map_or(J::Null, |f| {
                        J::Arr(
                            f.iter()
                                .map(|f| {
                                    J::Obj(vec![
                                        ("start", point(&f.start)),
                                        ("end", point(&f.end)),
                                        ("index", J::Int(f.index as i64)),
                                    ])
                                })
                                .collect(),
                        )
                    }),
                ));
                o.push((
                    "startIsSpecial",
                    el.start_is_special.map_or(J::Null, J::Bool),
                ));
                o.push(("endIsSpecial", el.end_is_special.map_or(J::Null, J::Bool)));
            }
        }
        Kind::FreeDraw(f) => {
            o.extend([
                ("points", points(&f.points)),
                (
                    "pressures",
                    J::Arr(f.pressures.iter().map(|p| num(*p)).collect()),
                ),
                ("simulatePressure", J::Bool(f.simulate_pressure)),
                (
                    "strokeOptions",
                    J::Obj(vec![
                        ("variability", s(f.stroke_options.variability.as_str())),
                        ("streamline", num(f.stroke_options.streamline)),
                    ]),
                ),
            ]);
        }
    }
    with_extra(J::Obj(o), &e.extra)
}

fn push_linear(o: &mut Vec<(&'static str, J)>, l: &LinearData) {
    o.extend([
        ("points", points(&l.points)),
        ("startBinding", binding(&l.start_binding)),
        ("endBinding", binding(&l.end_binding)),
        (
            "startArrowhead",
            l.start_arrowhead.map_or(J::Null, |a| s(a.as_str())),
        ),
        (
            "endArrowhead",
            l.end_arrowhead.map_or(J::Null, |a| s(a.as_str())),
        ),
    ]);
}

/// Appends unknown keys after the known ones.
fn with_extra(j: J, extra: &Map<String, Value>) -> J {
    let J::Obj(known) = j else { return j };
    if extra.is_empty() {
        return J::Obj(known);
    }
    // an `extra` key never shadows a written one (restore keeps them apart;
    // a hand-built element might not)
    let rest: Vec<(String, J)> = extra
        .iter()
        .filter(|(k, _)| !known.iter().any(|(k2, _)| k2 == k))
        .map(|(k, v)| (k.clone(), value(v)))
        .collect();
    let mut all: Vec<(String, J)> = known.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    all.extend(rest);
    J::Dyn(all)
}

fn file(f: &FileData) -> J {
    let mut o = vec![("mimeType", s(&f.mime_type)), ("id", s(&f.id))];
    if let Some(d) = &f.data_url {
        o.push(("dataURL", s(d)));
    }
    if let Some(p) = &f.path {
        o.push(("path", s(p)));
    }
    o.push(("created", J::Int(f.created)));
    if let Some(l) = f.last_retrieved {
        o.push(("lastRetrieved", J::Int(l)));
    }
    if let Some(v) = f.version {
        o.push(("version", J::Int(v)));
    }
    with_extra(J::Obj(o), &f.extra)
}

fn app_state(a: &ExportedAppState) -> J {
    J::Obj(vec![
        ("gridSize", num(a.grid_size)),
        ("gridStep", num(a.grid_step)),
        ("gridModeEnabled", J::Bool(a.grid_mode_enabled)),
        ("viewBackgroundColor", s(&a.view_background_color)),
    ])
}

/// `filterOutDeletedFiles`: the files non-deleted elements use, in first-use
/// order.
fn used_files<'a>(
    elements: &[Element],
    files: &'a BTreeMap<String, FileData>,
) -> Vec<(&'a String, &'a FileData)> {
    let mut out: Vec<(&String, &FileData)> = vec![];
    for e in elements.iter().filter(|e| !e.is_deleted) {
        if let Some(id) = e.image().and_then(|i| i.file_id.as_deref())
            && let Some((k, f)) = files.get_key_value(id)
            && !out.iter().any(|(k2, _)| *k2 == k)
        {
            out.push((k, f));
        }
    }
    out
}

fn write_str(out: &mut String, v: &str) {
    out.push_str(&serde_json::to_string(v).unwrap());
}

/// `JSON.stringify(j)`, or with `indent`, `JSON.stringify(j, null, indent)`.
fn write(out: &mut String, j: &J, indent: Option<usize>, depth: usize) {
    let nl = |out: &mut String, d: usize| {
        if let Some(n) = indent {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', n * d));
        }
    };
    let sep = if indent.is_some() { ": " } else { ":" };
    match j {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(v) => out.push_str(&if v.is_finite() {
            js_number(*v)
        } else {
            "null".into()
        }),
        J::Int(i) => {
            let _ = write!(out, "{i}");
        }
        J::Str(v) => write_str(out, v),
        J::Arr(a) if a.is_empty() => out.push_str("[]"),
        J::Arr(a) => {
            out.push('[');
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                nl(out, depth + 1);
                write(out, v, indent, depth + 1);
            }
            nl(out, depth);
            out.push(']');
        }
        J::Obj(o) if o.is_empty() => out.push_str("{}"),
        J::Dyn(o) if o.is_empty() => out.push_str("{}"),
        J::Obj(o) => write_obj(out, o.iter().map(|(k, v)| (*k, v)), indent, depth, sep),
        J::Dyn(o) => write_obj(
            out,
            o.iter().map(|(k, v)| (k.as_str(), v)),
            indent,
            depth,
            sep,
        ),
    }
}

fn write_obj<'a>(
    out: &mut String,
    items: impl Iterator<Item = (&'a str, &'a J)>,
    indent: Option<usize>,
    depth: usize,
    sep: &str,
) {
    out.push('{');
    for (i, (k, v)) in items.enumerate() {
        if i > 0 {
            out.push(',');
        }
        if let Some(n) = indent {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', n * (depth + 1)));
        }
        write_str(out, k);
        out.push_str(sep);
        write(out, v, indent, depth + 1);
    }
    if let Some(n) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * depth));
    }
    out.push('}');
}

/// One element as compact JSON.
pub fn element_to_json(e: &Element) -> String {
    let mut out = String::new();
    write(&mut out, &element(e), None, 0);
    out
}

/// One file (`BinaryFileData`) as compact JSON.
pub fn file_to_json(f: &FileData) -> String {
    let mut out = String::new();
    write(&mut out, &file(f), None, 0);
    out
}

/// One element as a `serde_json::Value` (tests and clipboard use it; key
/// order is lost unless serde_json preserves it).
pub fn element_to_value(e: &Element) -> Value {
    serde_json::from_str(&element_to_json(e)).unwrap()
}

/// `serializeAsJSON(elements, appState, files, "local")`: a whole
/// `.excalidraw` file. `source` is the exporting app's origin.
pub fn serialize_as_json(
    elements: &[Element],
    app: &ExportedAppState,
    files: &BTreeMap<String, FileData>,
    source: &str,
) -> String {
    let data = J::Obj(vec![
        ("type", s(EXPORT_DATA_TYPE_EXCALIDRAW)),
        ("version", J::Int(EXCALIDRAW_FILE_VERSION as i64)),
        ("source", s(source)),
        ("elements", J::Arr(elements.iter().map(element).collect())),
        ("appState", app_state(app)),
        (
            "files",
            J::Dyn(
                used_files(elements, files)
                    .into_iter()
                    .map(|(k, f)| (k.clone(), file(f)))
                    .collect(),
            ),
        ),
    ]);
    let mut out = String::new();
    write(&mut out, &data, Some(2), 0);
    out
}

/// The scene form inside documents: `{"elements":[…],"files":{…}}`, one
/// element per line and one file per line.
pub fn serialize_scene(elements: &[Element], files: &BTreeMap<String, FileData>) -> String {
    let mut out = String::from("{\"elements\":[");
    for (i, e) in elements.iter().enumerate() {
        out.push_str(if i > 0 { ",\n" } else { "\n" });
        write(&mut out, &element(e), None, 0);
    }
    if !elements.is_empty() {
        out.push('\n');
    }
    out.push_str("],\"files\":{");
    let used = used_files(elements, files);
    for (i, (k, f)) in used.iter().enumerate() {
        out.push_str(if i > 0 { ",\n" } else { "\n" });
        write_str(&mut out, k);
        out.push(':');
        write(&mut out, &file(f), None, 0);
    }
    if !used.is_empty() {
        out.push('\n');
    }
    out.push_str("}}");
    out
}
