// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! path-data-parser 0.1.0 (`parsePath`, `absolutize`, `normalize` with its
//! arc to cubic conversion) and points-on-path 0.2.1 (`pointsOnPath`), MIT,
//! Preet Shihn. Bad path data parses to no segments (upstream throws).

use super::curve::{points_on_bezier_curves, simplify};
use crate::board::math::Point;

/// A path command: its letter and parameters.
#[derive(Clone, Debug, PartialEq)]
pub struct Seg {
    pub key: char,
    pub data: Vec<f64>,
}

impl Seg {
    pub fn new(key: char, data: &[f64]) -> Seg {
        Seg {
            key,
            data: data.to_vec(),
        }
    }
}

fn params(c: char) -> Option<usize> {
    Some(match c {
        'A' | 'a' => 7,
        'C' | 'c' => 6,
        'H' | 'h' | 'V' | 'v' => 1,
        'L' | 'l' | 'M' | 'm' | 'T' | 't' => 2,
        'Q' | 'q' | 'S' | 's' => 4,
        'Z' | 'z' => 0,
        _ => return None,
    })
}

enum Tok {
    Cmd(char),
    Num(f64),
}

fn tokenize(d: &str) -> Option<Vec<Tok>> {
    let b = d.as_bytes();
    let (mut i, mut out) = (0, vec![]);
    while i < b.len() {
        let c = b[i];
        if matches!(c, b' ' | b'\t' | b'\r' | b'\n' | b',') {
            i += 1;
            continue;
        }
        if params(c as char).is_some() {
            out.push(Tok::Cmd(c as char));
            i += 1;
            continue;
        }
        // ([-+]?[0-9]+(\.[0-9]*)?|[-+]?\.[0-9]+)([eE][-+]?[0-9]+)?
        let start = i;
        let mut j = i;
        if j < b.len() && (b[j] == b'-' || b[j] == b'+') {
            j += 1;
        }
        let int_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let has_int = j > int_start;
        if j < b.len() && b[j] == b'.' {
            let k = j + 1;
            let mut m = k;
            while m < b.len() && b[m].is_ascii_digit() {
                m += 1;
            }
            if has_int || m > k {
                j = m;
            } else {
                return None;
            }
        } else if !has_int {
            return None;
        }
        if j < b.len() && (b[j] == b'e' || b[j] == b'E') {
            let mut m = j + 1;
            if m < b.len() && (b[m] == b'-' || b[m] == b'+') {
                m += 1;
            }
            let ds = m;
            while m < b.len() && b[m].is_ascii_digit() {
                m += 1;
            }
            if m > ds {
                j = m;
            }
        }
        let s = &d[start..j];
        out.push(Tok::Num(s.trim_end_matches('.').parse().ok()?));
        i = j;
    }
    Some(out)
}

/// `parsePath`: data before the first `M` is read as if after `M0,0`.
pub fn parse_path(d: &str) -> Vec<Seg> {
    let Some(tokens) = tokenize(d) else {
        return vec![];
    };
    if !matches!(tokens.first(), Some(Tok::Cmd('M' | 'm')) | None) {
        return parse_path(&format!("M0,0{d}"));
    }
    let mut segs = vec![];
    let (mut i, mut mode) = (0, 'M');
    while i < tokens.len() {
        match tokens[i] {
            Tok::Cmd(c) => {
                mode = c;
                i += 1;
            }
            Tok::Num(_) if segs.is_empty() && i == 0 => return vec![],
            Tok::Num(_) => {}
        }
        let n = params(mode).unwrap_or(0);
        // upstream needs room for the end-of-data token too
        if i + n > tokens.len() {
            return vec![];
        }
        let mut data = Vec::with_capacity(n);
        for t in &tokens[i..i + n] {
            match t {
                Tok::Num(v) => data.push(*v),
                Tok::Cmd(_) => return vec![],
            }
        }
        segs.push(Seg { key: mode, data });
        i += n;
        if mode == 'M' {
            mode = 'L'
        }
        if mode == 'm' {
            mode = 'l'
        }
        if n == 0 && i < tokens.len() && matches!(tokens[i], Tok::Num(_)) {
            return vec![];
        }
    }
    segs
}

/// `absolutize`.
pub fn absolutize(segs: &[Seg]) -> Vec<Seg> {
    let (mut cx, mut cy, mut subx, mut suby) = (0., 0., 0., 0.);
    let mut out = Vec::with_capacity(segs.len());
    let rel = |d: &[f64], cx: f64, cy: f64| -> Vec<f64> {
        d.iter()
            .enumerate()
            .map(|(i, v)| if i % 2 == 1 { v + cy } else { v + cx })
            .collect()
    };
    for Seg { key, data: d } in segs {
        match key {
            'M' => {
                out.push(Seg::new('M', d));
                (cx, cy) = (d[0], d[1]);
                (subx, suby) = (d[0], d[1]);
            }
            'm' => {
                cx += d[0];
                cy += d[1];
                out.push(Seg::new('M', &[cx, cy]));
                (subx, suby) = (cx, cy);
            }
            'L' => {
                out.push(Seg::new('L', d));
                (cx, cy) = (d[0], d[1]);
            }
            'l' => {
                cx += d[0];
                cy += d[1];
                out.push(Seg::new('L', &[cx, cy]));
            }
            'C' => {
                out.push(Seg::new('C', d));
                (cx, cy) = (d[4], d[5]);
            }
            'c' => {
                let n = rel(d, cx, cy);
                (cx, cy) = (n[4], n[5]);
                out.push(Seg { key: 'C', data: n });
            }
            'Q' => {
                out.push(Seg::new('Q', d));
                (cx, cy) = (d[2], d[3]);
            }
            'q' => {
                let n = rel(d, cx, cy);
                (cx, cy) = (n[2], n[3]);
                out.push(Seg { key: 'Q', data: n });
            }
            'A' => {
                out.push(Seg::new('A', d));
                (cx, cy) = (d[5], d[6]);
            }
            'a' => {
                cx += d[5];
                cy += d[6];
                out.push(Seg::new('A', &[d[0], d[1], d[2], d[3], d[4], cx, cy]));
            }
            'H' => {
                out.push(Seg::new('H', d));
                cx = d[0];
            }
            'h' => {
                cx += d[0];
                out.push(Seg::new('H', &[cx]));
            }
            'V' => {
                out.push(Seg::new('V', d));
                cy = d[0];
            }
            'v' => {
                cy += d[0];
                out.push(Seg::new('V', &[cy]));
            }
            'S' => {
                out.push(Seg::new('S', d));
                (cx, cy) = (d[2], d[3]);
            }
            's' => {
                let n = rel(d, cx, cy);
                (cx, cy) = (n[2], n[3]);
                out.push(Seg { key: 'S', data: n });
            }
            'T' => {
                out.push(Seg::new('T', d));
                (cx, cy) = (d[0], d[1]);
            }
            't' => {
                cx += d[0];
                cy += d[1];
                out.push(Seg::new('T', &[cx, cy]));
            }
            'Z' | 'z' => {
                out.push(Seg::new('Z', &[]));
                (cx, cy) = (subx, suby);
            }
            _ => {}
        }
    }
    out
}

/// `normalize`: only `M`, `L`, `C` and `Z` remain.
pub fn normalize(segs: &[Seg]) -> Vec<Seg> {
    let mut out = Vec::with_capacity(segs.len());
    let mut last = ' ';
    let (mut cx, mut cy, mut subx, mut suby, mut lcx, mut lcy) = (0., 0., 0., 0., 0., 0.);
    for Seg { key, data: d } in segs {
        match key {
            'M' => {
                out.push(Seg::new('M', d));
                (cx, cy) = (d[0], d[1]);
                (subx, suby) = (d[0], d[1]);
            }
            'C' => {
                out.push(Seg::new('C', d));
                (cx, cy) = (d[4], d[5]);
                (lcx, lcy) = (d[2], d[3]);
            }
            'L' => {
                out.push(Seg::new('L', d));
                (cx, cy) = (d[0], d[1]);
            }
            'H' => {
                cx = d[0];
                out.push(Seg::new('L', &[cx, cy]));
            }
            'V' => {
                cy = d[0];
                out.push(Seg::new('L', &[cx, cy]));
            }
            'S' => {
                let (cx1, cy1) = if last == 'C' || last == 'S' {
                    (cx + (cx - lcx), cy + (cy - lcy))
                } else {
                    (cx, cy)
                };
                out.push(Seg::new('C', &[cx1, cy1, d[0], d[1], d[2], d[3]]));
                (lcx, lcy) = (d[0], d[1]);
                (cx, cy) = (d[2], d[3]);
            }
            'T' => {
                let (x, y) = (d[0], d[1]);
                let (x1, y1) = if last == 'Q' || last == 'T' {
                    (cx + (cx - lcx), cy + (cy - lcy))
                } else {
                    (cx, cy)
                };
                out.push(Seg::new(
                    'C',
                    &[
                        cx + 2. * (x1 - cx) / 3.,
                        cy + 2. * (y1 - cy) / 3.,
                        x + 2. * (x1 - x) / 3.,
                        y + 2. * (y1 - y) / 3.,
                        x,
                        y,
                    ],
                ));
                (lcx, lcy) = (x1, y1);
                (cx, cy) = (x, y);
            }
            'Q' => {
                let (x1, y1, x, y) = (d[0], d[1], d[2], d[3]);
                out.push(Seg::new(
                    'C',
                    &[
                        cx + 2. * (x1 - cx) / 3.,
                        cy + 2. * (y1 - cy) / 3.,
                        x + 2. * (x1 - x) / 3.,
                        y + 2. * (y1 - y) / 3.,
                        x,
                        y,
                    ],
                ));
                (lcx, lcy) = (x1, y1);
                (cx, cy) = (x, y);
            }
            'A' => {
                let (r1, r2) = (d[0].abs(), d[1].abs());
                let (x, y) = (d[5], d[6]);
                if r1 == 0. || r2 == 0. {
                    out.push(Seg::new('C', &[cx, cy, x, y, x, y]));
                    (cx, cy) = (x, y);
                } else if cx != x || cy != y {
                    for c in arc_to_cubic_curves(cx, cy, x, y, r1, r2, d[2], d[3], d[4], None) {
                        out.push(Seg {
                            key: 'C',
                            data: c.to_vec(),
                        });
                    }
                    (cx, cy) = (x, y);
                }
            }
            'Z' => {
                out.push(Seg::new('Z', &[]));
                (cx, cy) = (subx, suby);
            }
            _ => {}
        }
        last = *key;
    }
    out
}

fn rotate(x: f64, y: f64, a: f64) -> (f64, f64) {
    (x * a.cos() - y * a.sin(), x * a.sin() + y * a.cos())
}

/// JS `parseFloat(v.toFixed(9))`.
fn fixed9(v: f64) -> f64 {
    format!("{v:.9}").parse().unwrap_or(v)
}

#[allow(clippy::too_many_arguments)]
fn arc_to_cubic_curves(
    mut x1: f64,
    mut y1: f64,
    mut x2: f64,
    mut y2: f64,
    mut r1: f64,
    mut r2: f64,
    angle: f64,
    large_arc: f64,
    sweep: f64,
    recursive: Option<[f64; 4]>,
) -> Vec<[f64; 6]> {
    let angle_rad = std::f64::consts::PI * angle / 180.;
    let sweep = sweep != 0.;
    let mut params: Vec<Point> = vec![];
    let (mut f1, mut f2, cx, cy);
    if let Some([a, b, c, d]) = recursive {
        (f1, f2, cx, cy) = (a, b, c, d);
    } else {
        (x1, y1) = rotate(x1, y1, -angle_rad);
        (x2, y2) = rotate(x2, y2, -angle_rad);
        let x = (x1 - x2) / 2.;
        let y = (y1 - y2) / 2.;
        let mut h = (x * x) / (r1 * r1) + (y * y) / (r2 * r2);
        if h > 1. {
            h = h.sqrt();
            r1 *= h;
            r2 *= h;
        }
        let sign = if (large_arc != 0.) == sweep { -1. } else { 1. };
        let (r1p, r2p) = (r1 * r1, r2 * r2);
        let left = r1p * r2p - r1p * y * y - r2p * x * x;
        let right = r1p * y * y + r2p * x * x;
        let k = sign * (left / right).abs().sqrt();
        cx = k * r1 * y / r2 + (x1 + x2) / 2.;
        cy = k * -r2 * x / r1 + (y1 + y2) / 2.;
        f1 = fixed9((y1 - cy) / r2).asin();
        f2 = fixed9((y2 - cy) / r2).asin();
        if x1 < cx {
            f1 = std::f64::consts::PI - f1;
        }
        if x2 < cx {
            f2 = std::f64::consts::PI - f2;
        }
        if f1 < 0. {
            f1 += std::f64::consts::PI * 2.;
        }
        if f2 < 0. {
            f2 += std::f64::consts::PI * 2.;
        }
        if sweep && f1 > f2 {
            f1 -= std::f64::consts::PI * 2.;
        }
        if !sweep && f2 > f1 {
            f2 -= std::f64::consts::PI * 2.;
        }
    }
    let mut df = f2 - f1;
    let max = std::f64::consts::PI * 120. / 180.;
    if df.abs() > max {
        let (f2old, x2old, y2old) = (f2, x2, y2);
        f2 = if sweep && f2 > f1 { f1 + max } else { f1 - max };
        x2 = cx + r1 * f2.cos();
        y2 = cy + r2 * f2.sin();
        let rest = arc_to_cubic_curves(
            x2,
            y2,
            x2old,
            y2old,
            r1,
            r2,
            angle,
            0.,
            if sweep { 1. } else { 0. },
            Some([f2, f2old, cx, cy]),
        );
        params = rest
            .iter()
            .flat_map(|c| [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]]])
            .collect();
    }
    df = f2 - f1;
    let (c1, s1, c2, s2) = (f1.cos(), f1.sin(), f2.cos(), f2.sin());
    let t = (df / 4.).tan();
    let hx = 4. / 3. * r1 * t;
    let hy = 4. / 3. * r2 * t;
    let m1 = [x1, y1];
    let mut m2 = [x1 + hx * s1, y1 - hy * c1];
    let m3 = [x2 + hx * s2, y2 - hy * c2];
    let m4 = [x2, y2];
    m2[0] = 2. * m1[0] - m2[0];
    m2[1] = 2. * m1[1] - m2[1];
    let mut all = vec![m2, m3, m4];
    all.extend(params);
    if recursive.is_some() {
        // raw points, three per curve, rotated by the outermost call
        return all
            .chunks(3)
            .map(|c| [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1]])
            .collect();
    }
    all.chunks(3)
        .map(|c| {
            let (a, b) = rotate(c[0][0], c[0][1], angle_rad);
            let (p, q) = rotate(c[1][0], c[1][1], angle_rad);
            let (u, v) = rotate(c[2][0], c[2][1], angle_rad);
            [a, b, p, q, u, v]
        })
        .collect()
}

/// `pointsOnPath` over normalized segments: one point list per subpath,
/// simplified to `distance` when given.
pub fn points_on_path(
    normalized: &[Seg],
    tolerance: f64,
    distance: Option<f64>,
) -> Vec<Vec<Point>> {
    let (mut sets, mut cur): (Vec<Vec<Point>>, Vec<Point>) = (vec![], vec![]);
    let mut start = [0., 0.];
    let mut pending: Vec<Point> = vec![];
    fn append_curve(pending: &mut Vec<Point>, cur: &mut Vec<Point>, tolerance: f64) {
        if pending.len() >= 4 {
            cur.extend(points_on_bezier_curves(pending, tolerance, None));
        }
        pending.clear();
    }
    for Seg { key, data: d } in normalized {
        match key {
            'M' => {
                append_curve(&mut pending, &mut cur, tolerance);
                if !cur.is_empty() {
                    sets.push(std::mem::take(&mut cur));
                }
                start = [d[0], d[1]];
                cur.push(start);
            }
            'L' => {
                append_curve(&mut pending, &mut cur, tolerance);
                cur.push([d[0], d[1]]);
            }
            'C' => {
                if pending.is_empty() {
                    pending.push(*cur.last().unwrap_or(&start));
                }
                pending.extend([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]]]);
            }
            'Z' => {
                append_curve(&mut pending, &mut cur, tolerance);
                cur.push(start);
            }
            _ => {}
        }
    }
    append_curve(&mut pending, &mut cur, tolerance);
    if !cur.is_empty() {
        sets.push(cur);
    }
    match distance {
        Some(d) if d != 0. && !d.is_nan() => sets
            .iter()
            .map(|s| simplify(s, d))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => sets,
    }
}
