// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! What GPUI can't do for the board painter, done on the CPU: frame clips
//! and arrow label holes cut out of tessellated paths (triangle by triangle,
//! against a convex polygon), and images rotated, mirrored, cropped and
//! clipped into a bitmap (GPUI draws images upright and unclipped but for
//! an axis-aligned content mask).

use crate::board::display::{Clip, ElementDisplay, ImageItem};
use gpui::{Path, Pixels, point, px};

pub type Pt = [f64; 2];

/// A frame clip as a convex polygon in scene units, clockwise on screen:
/// the rounded rectangle, rotated about its center.
pub fn clip_polygon(k: &Clip) -> Vec<Pt> {
    let [x, y, w, h] = k.rect;
    let r = k.radius.min(w.abs() / 2.).min(h.abs() / 2.).max(0.);
    let c = [x + w / 2., y + h / 2.];
    let (s, co) = k.angle.sin_cos();
    let rot = |p: Pt| {
        [
            (p[0] - c[0]) * co - (p[1] - c[1]) * s + c[0],
            (p[0] - c[0]) * s + (p[1] - c[1]) * co + c[1],
        ]
    };
    const N: usize = 6;
    let mut out = Vec::with_capacity(4 * (N + 1));
    // corner centers TL, TR, BR, BL with the angle their arc starts at
    for (i, (cx, cy)) in [
        (x + r, y + r),
        (x + w - r, y + r),
        (x + w - r, y + h - r),
        (x + r, y + h - r),
    ]
    .into_iter()
    .enumerate()
    {
        let a0 = std::f64::consts::PI * (1. + i as f64 * 0.5);
        for j in 0..=N {
            let a = a0 + std::f64::consts::FRAC_PI_2 * j as f64 / N as f64;
            out.push(rot([cx + r * a.cos(), cy + r * a.sin()]));
            if r == 0. {
                break;
            }
        }
    }
    out
}

/// A local rectangle `[x, y, w, h]` of `d` as a scene quad, clockwise.
pub fn local_quad(d: &ElementDisplay, r: [f64; 4]) -> Vec<Pt> {
    let [x, y, w, h] = r;
    [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        .into_iter()
        .map(|p| d.to_scene(p))
        .collect()
}

pub fn aabb(poly: &[Pt]) -> [f64; 4] {
    poly.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        },
    )
}

fn cross(a: [f32; 2], b: [f32; 2], p: [f32; 2]) -> f32 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// Sutherland–Hodgman against the line a→b, keeping the inside (right of
/// a→b on screen) or, with `outside`, the rest.
fn cut(poly: &[[f32; 2]], a: [f32; 2], b: [f32; 2], outside: bool) -> Vec<[f32; 2]> {
    let side = |p| {
        if outside {
            -cross(a, b, p)
        } else {
            cross(a, b, p)
        }
    };
    let mut out = Vec::with_capacity(poly.len() + 2);
    for i in 0..poly.len() {
        let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
        let (sp, sq) = (side(p), side(q));
        if sp >= 0. {
            out.push(p);
        }
        if (sp >= 0.) != (sq >= 0.) {
            let t = sp / (sp - sq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
    }
    out
}

fn inside_convex(poly: &[[f32; 2]], p: [f32; 2]) -> bool {
    (0..poly.len()).all(|i| cross(poly[i], poly[(i + 1) % poly.len()], p) >= 0.)
}

/// `path` cut to the inside of the convex `keep` and the outside of the
/// convex `hole` (both in the path's coordinates, clockwise); None when
/// nothing is left. Paths built by `PathBuilder` are flat triangles (no
/// curve coordinates), so pieces are plain fans.
pub fn clip_path(
    path: &Path<Pixels>,
    keep: Option<&[[f32; 2]]>,
    hole: Option<&[[f32; 2]]>,
) -> Option<Path<Pixels>> {
    let tris: Vec<[[f32; 2]; 3]> = path
        .vertices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|t| {
            t.each_ref()
                .map(|v| [f32::from(v.xy_position.x), f32::from(v.xy_position.y)])
        })
        .collect();
    // untouched when the whole path is inside `keep` and clear of `hole`
    let (mut lo, mut hi) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
    for p in tris.iter().flatten() {
        lo = [lo[0].min(p[0]), lo[1].min(p[1])];
        hi = [hi[0].max(p[0]), hi[1].max(p[1])];
    }
    if tris.is_empty() {
        return None;
    }
    let corners = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]];
    let keep = keep.filter(|k| !corners.iter().all(|c| inside_convex(k, *c)));
    let hole = hole.filter(|h| {
        let (mut hl, mut hh) = ([f32::INFINITY; 2], [f32::NEG_INFINITY; 2]);
        for p in h.iter() {
            hl = [hl[0].min(p[0]), hl[1].min(p[1])];
            hh = [hh[0].max(p[0]), hh[1].max(p[1])];
        }
        hl[0] < hi[0] && hh[0] > lo[0] && hl[1] < hi[1] && hh[1] > lo[1]
    });
    if keep.is_none() && hole.is_none() {
        return Some(path.clone());
    }
    let mut pieces: Vec<Vec<[f32; 2]>> = vec![];
    for t in &tris {
        let mut p = t.to_vec();
        if let Some(k) = keep {
            for i in 0..k.len() {
                if p.len() < 3 {
                    break;
                }
                p = cut(&p, k[i], k[(i + 1) % k.len()], false);
            }
        }
        if p.len() < 3 {
            continue;
        }
        match hole {
            None => pieces.push(p),
            Some(h) => {
                let mut rest = p;
                for i in 0..h.len() {
                    if rest.len() < 3 {
                        break;
                    }
                    let (a, b) = (h[i], h[(i + 1) % h.len()]);
                    let out = cut(&rest, a, b, true);
                    if out.len() >= 3 {
                        pieces.push(out);
                    }
                    rest = cut(&rest, a, b, false);
                }
            }
        }
    }
    let first = pieces.first()?[0];
    let mut out = Path::new(point(px(first[0]), px(first[1])));
    let st = (point(0., 1.), point(0., 1.), point(0., 1.));
    let pt = |p: [f32; 2]| point(px(p[0]), px(p[1]));
    for p in &pieces {
        for i in 1..p.len() - 1 {
            out.push_triangle((pt(p[0]), pt(p[i]), pt(p[i + 1])), st);
        }
    }
    Some(out)
}

/// Decoded image pixels, RGBA, straight alpha.
#[derive(Clone)]
pub struct Src {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

/// `img` of `d` as drawn: a BGRA bitmap (straight alpha, GPUI's) covering
/// the scene rectangle it returns, at `res` pixels per scene unit, clipped
/// by `clip` (a convex scene polygon). None when nothing shows.
pub fn transform_image(
    src: &Src,
    img: &ImageItem,
    d: &ElementDisplay,
    clip: Option<&[Pt]>,
    res: f64,
) -> Option<(u32, u32, Vec<u8>, [f64; 4])> {
    let [x, y, w, h] = img.dest;
    if w <= 0. || h <= 0. || src.w == 0 || src.h == 0 {
        return None;
    }
    let mut r = aabb(&local_quad(d, img.dest));
    if let Some(c) = clip {
        let b = aabb(c);
        r = [
            r[0].max(b[0]),
            r[1].max(b[1]),
            r[2].min(b[2]),
            r[3].min(b[3]),
        ];
    }
    if r[2] <= r[0] || r[3] <= r[1] {
        return None;
    }
    // a clear margin, so the GPU's filtering at the bitmap's edge samples nothing
    let m = 2. / res;
    let r = [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
    let (ow, oh) = (
        ((r[2] - r[0]) * res).ceil().max(1.) as u32,
        ((r[3] - r[1]) * res).ceil().max(1.) as u32,
    );
    let r = [r[0], r[1], r[0] + ow as f64 / res, r[1] + oh as f64 / res];
    // source pixels per local unit, and where local (0, 0) lands in them
    let (sx, sy, ox, oy) = match (img.crop, img.natural_size) {
        (Some(c), Some([nw, nh])) if c[2] > 0. && c[3] > 0. && nw > 0. && nh > 0. => {
            let (kx, ky) = (src.w as f64 / nw, src.h as f64 / nh);
            (c[2] / w * kx, c[3] / h * ky, c[0] * kx, c[1] * ky)
        }
        _ => (src.w as f64 / w, src.h as f64 / h, 0., 0.),
    };
    let (s, co) = (-d.angle).sin_cos();
    let rad = img.corner_radius.min(w / 2.).min(h / 2.).max(0.);
    let edges: Vec<(Pt, Pt, f64)> = clip
        .map(|c| {
            (0..c.len())
                .map(|i| {
                    let (a, b) = (c[i], c[(i + 1) % c.len()]);
                    (a, b, ((b[0] - a[0]).hypot(b[1] - a[1])).max(1e-9))
                })
                .collect()
        })
        .unwrap_or_default();
    let sample = |fx: f64, fy: f64| -> [f64; 4] {
        let (fx, fy) = (
            (fx - 0.5).clamp(0., src.w as f64 - 1.),
            (fy - 0.5).clamp(0., src.h as f64 - 1.),
        );
        let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(src.w - 1), (y0 + 1).min(src.h - 1));
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
        let mut acc = [0.; 4];
        for (xx, yy, wgt) in [
            (x0, y0, (1. - tx) * (1. - ty)),
            (x1, y0, tx * (1. - ty)),
            (x0, y1, (1. - tx) * ty),
            (x1, y1, tx * ty),
        ] {
            let i = ((yy * src.w + xx) * 4) as usize;
            let a = src.px[i + 3] as f64 / 255. * wgt;
            for (k, sum) in acc.iter_mut().take(3).enumerate() {
                *sum += src.px[i + k] as f64 * a;
            }
            acc[3] += a;
        }
        acc
    };
    let mut out = vec![0u8; (ow * oh * 4) as usize];
    let mut any = false;
    for j in 0..oh {
        for i in 0..ow {
            let p = [r[0] + (i as f64 + 0.5) / res, r[1] + (j as f64 + 0.5) / res];
            // scene → local
            let q = [
                p[0] - d.origin[0] - d.center[0],
                p[1] - d.origin[1] - d.center[1],
            ];
            let (lx, ly) = (
                q[0] * co - q[1] * s + d.center[0] - x,
                q[0] * s + q[1] * co + d.center[1] - y,
            );
            // coverage: distance inside the rounded rect, in output pixels
            let (dx, dy) = (lx.min(w - lx), ly.min(h - ly));
            let mut dist = dx.min(dy);
            if rad > 0. && dx < rad && dy < rad {
                dist = rad - (rad - dx).hypot(rad - dy);
            }
            for (a, b, len) in &edges {
                dist =
                    dist.min(((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len);
            }
            let cov = (dist * res + 0.5).clamp(0., 1.);
            // clear pixels still get the nearest color: straight alpha filters them in
            let (ux, uy) = (
                if img.flip[0] < 0. { w - lx } else { lx },
                if img.flip[1] < 0. { h - ly } else { ly },
            );
            let c = sample(ox + ux.clamp(0., w) * sx, oy + uy.clamp(0., h) * sy);
            if c[3] <= 0. {
                continue;
            }
            let o = ((j * ow + i) * 4) as usize;
            out[o] = (c[2] / c[3]).round() as u8;
            out[o + 1] = (c[1] / c[3]).round() as u8;
            out[o + 2] = (c[0] / c[3]).round() as u8;
            out[o + 3] = (c[3] * cov * 255.).round() as u8;
            any |= cov > 0.;
        }
    }
    any.then_some((ow, oh, out, r))
}

pub fn to_f32(poly: &[Pt], scale: f32) -> Vec<[f32; 2]> {
    poly.iter()
        .map(|p| [p[0] as f32 * scale, p[1] as f32 * scale])
        .collect()
}
