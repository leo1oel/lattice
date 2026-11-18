// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! TrueType subsetting for SVG export's inlined fonts. Stands in for
//! Excalidraw `excalidraw/subset/subset-shared.chunk.ts` @ 3a317b5
//! (`subsetWoff2GlyphsByCodepoints`: HarfBuzz's subsetter compiled to wasm,
//! output re-encoded as WOFF2). Differences: TrueType (`glyf`) fonts only,
//! the result stays TrueType (no WOFF2 encoder here), and two simpler
//! modes instead of HarfBuzz's layout closure:
//! - `keep_layout`: glyph ids stay, glyphs of characters not asked for are
//!   emptied; unencoded glyphs (reachable only through GSUB: ligatures,
//!   alternates, localized forms) are all kept, so GSUB / GPOS stay valid.
//! - otherwise the kept glyphs are renumbered and the layout tables dropped
//!   (for Xiaolai, whose GSUB holds only `vert` / `dlig`).
//!
//! Either way `cmap` is rebuilt for the asked characters only (formats 4
//! and 12), `loca` is written long, `post` becomes version 3 (no names).

use rustc_hash::{FxHashMap, FxHashSet};

fn u16_at(d: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes(d.get(o..o + 2)?.try_into().ok()?))
}
fn u32_at(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(d.get(o..o + 4)?.try_into().ok()?))
}

/// The table directory: tag → bytes.
fn tables(font: &[u8]) -> Option<Vec<([u8; 4], &[u8])>> {
    let n = u16_at(font, 4)? as usize;
    (0..n)
        .map(|i| {
            let r = 12 + i * 16;
            let tag: [u8; 4] = font.get(r..r + 4)?.try_into().ok()?;
            let (off, len) = (
                u32_at(font, r + 8)? as usize,
                u32_at(font, r + 12)? as usize,
            );
            Some((tag, font.get(off..off + len)?))
        })
        .collect()
}

/// `cmap`: the best Unicode subtable's mapping for `chars`.
fn lookup(cmap: &[u8], chars: &[char]) -> Option<Vec<(char, u16)>> {
    let n = u16_at(cmap, 2)? as usize;
    let mut best: Option<(u8, usize)> = None;
    for i in 0..n {
        let r = 4 + i * 8;
        let (p, e, off) = (
            u16_at(cmap, r)?,
            u16_at(cmap, r + 2)?,
            u32_at(cmap, r + 4)? as usize,
        );
        let fmt = u16_at(cmap, off)?;
        let rank = match (p, e, fmt) {
            (3, 10, 12) | (0, 4, 12) | (0, 6, 12) => 3,
            (3, 1, 4) | (0, 3, 4) | (0, _, 4) => 2,
            _ => 0,
        };
        if rank > 0 && best.is_none_or(|b| rank > b.0) {
            best = Some((rank, off));
        }
    }
    let (_, off) = best?;
    let t = cmap.get(off..)?;
    let mut out = vec![];
    match u16_at(t, 0)? {
        12 => {
            let groups = u32_at(t, 12)? as usize;
            for &c in chars {
                let cp = c as u32;
                let (mut lo, mut hi) = (0usize, groups);
                while lo < hi {
                    let mid = (lo + hi) / 2;
                    let g = 16 + mid * 12;
                    let (s, e) = (u32_at(t, g)?, u32_at(t, g + 4)?);
                    if cp < s {
                        hi = mid
                    } else if cp > e {
                        lo = mid + 1
                    } else {
                        out.push((c, (u32_at(t, g + 8)? + cp - s) as u16));
                        break;
                    }
                }
            }
        }
        4 => {
            let segs = u16_at(t, 6)? as usize / 2;
            for &c in chars {
                let cp = c as u32;
                if cp > 0xFFFF {
                    continue;
                }
                for s in 0..segs {
                    let end = u16_at(t, 14 + s * 2)? as u32;
                    if cp > end {
                        continue;
                    }
                    let start = u16_at(t, 16 + segs * 2 + s * 2)? as u32;
                    if cp < start {
                        break;
                    }
                    let delta = u16_at(t, 16 + segs * 4 + s * 2)?;
                    let ro_at = 16 + segs * 6 + s * 2;
                    let ro = u16_at(t, ro_at)? as usize;
                    let g = if ro == 0 {
                        (cp as u16).wrapping_add(delta)
                    } else {
                        let g = u16_at(t, ro_at + ro + (cp - start) as usize * 2)?;
                        if g == 0 { 0 } else { g.wrapping_add(delta) }
                    };
                    if g != 0 {
                        out.push((c, g));
                    }
                    break;
                }
            }
        }
        _ => return None,
    }
    Some(out.into_iter().filter(|&(_, g)| g != 0).collect())
}

/// A glyph's components (composite glyphs), with where each id sits.
fn components(g: &[u8]) -> Vec<(usize, u16)> {
    let mut out = vec![];
    if g.len() < 10 || (u16_at(g, 0).unwrap_or(0) as i16) >= 0 {
        return out;
    }
    let mut o = 10;
    while let (Some(flags), Some(id)) = (u16_at(g, o), u16_at(g, o + 2)) {
        out.push((o + 2, id));
        o += 4 + if flags & 1 != 0 { 4 } else { 2 };
        o += if flags & 0x8 != 0 {
            2
        } else if flags & 0x40 != 0 {
            4
        } else if flags & 0x80 != 0 {
            8
        } else {
            0
        };
        if flags & 0x20 == 0 {
            break;
        }
    }
    out
}

fn cmap_table(map: &[(u32, u32)]) -> Vec<u8> {
    // format 4: BMP runs of consecutive glyphs, plus the 0xFFFF end segment
    let mut segs: Vec<(u32, u32, u32)> = vec![];
    for &(c, g) in map.iter().filter(|m| m.0 < 0xFFFF) {
        match segs.last_mut() {
            Some(s) if s.1 + 1 == c && s.2 + (c - s.0) == g => s.1 = c,
            _ => segs.push((c, c, g)),
        }
    }
    segs.push((0xFFFF, 0xFFFF, 1));
    let n = segs.len();
    let mut f4 = vec![];
    let p = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_be_bytes());
    let pow = 1usize << (usize::BITS - 1 - n.leading_zeros());
    p(&mut f4, 4);
    p(&mut f4, (16 + n * 8) as u16);
    p(&mut f4, 0);
    p(&mut f4, (n * 2) as u16);
    p(&mut f4, (pow * 2) as u16);
    p(&mut f4, pow.trailing_zeros() as u16);
    p(&mut f4, ((n - pow) * 2) as u16);
    for s in &segs {
        p(&mut f4, s.1 as u16);
    }
    p(&mut f4, 0);
    for s in &segs {
        p(&mut f4, s.0 as u16);
    }
    for s in &segs {
        p(&mut f4, (s.2 as u16).wrapping_sub(s.0 as u16));
    }
    for _ in &segs {
        p(&mut f4, 0);
    }
    // format 12: every character
    let mut groups: Vec<(u32, u32, u32)> = vec![];
    for &(c, g) in map {
        match groups.last_mut() {
            Some(s) if s.1 + 1 == c && s.2 + (c - s.0) == g => s.1 = c,
            _ => groups.push((c, c, g)),
        }
    }
    let mut f12 = vec![];
    p(&mut f12, 12);
    p(&mut f12, 0);
    f12.extend_from_slice(&((16 + groups.len() * 12) as u32).to_be_bytes());
    f12.extend_from_slice(&0u32.to_be_bytes());
    f12.extend_from_slice(&(groups.len() as u32).to_be_bytes());
    for g in &groups {
        for v in [g.0, g.1, g.2] {
            f12.extend_from_slice(&v.to_be_bytes());
        }
    }
    let mut t = vec![];
    p(&mut t, 0);
    p(&mut t, 2);
    p(&mut t, 3);
    p(&mut t, 1);
    t.extend_from_slice(&20u32.to_be_bytes());
    p(&mut t, 3);
    p(&mut t, 10);
    t.extend_from_slice(&((20 + f4.len()) as u32).to_be_bytes());
    t.extend(f4);
    t.extend(f12);
    t
}

fn checksum(d: &[u8]) -> u32 {
    d.chunks(4).fold(0u32, |s, c| {
        let mut b = [0u8; 4];
        b[..c.len()].copy_from_slice(c);
        s.wrapping_add(u32::from_be_bytes(b))
    })
}

/// The font cut down to `chars` (see the module docs); None when it isn't a
/// TrueType font or covers none of them.
pub fn subset(font: &[u8], chars: &[char], keep_layout: bool) -> Option<Vec<u8>> {
    let tabs = tables(font)?;
    let get = |t: &[u8; 4]| tabs.iter().find(|x| &x.0 == t).map(|x| x.1);
    let (head, maxp, hhea, hmtx, loca, glyf, cmap) = (
        get(b"head")?,
        get(b"maxp")?,
        get(b"hhea")?,
        get(b"hmtx")?,
        get(b"loca")?,
        get(b"glyf")?,
        get(b"cmap")?,
    );
    let num = u16_at(maxp, 4)? as usize;
    let long = u16_at(head, 50)? == 1;
    let at = |i: usize| -> Option<usize> {
        if long {
            u32_at(loca, i * 4).map(|v| v as usize)
        } else {
            u16_at(loca, i * 2).map(|v| v as usize * 2)
        }
    };
    let glyph = |i: usize| -> &[u8] {
        match (at(i), at(i + 1)) {
            (Some(a), Some(b)) if a <= b => glyf.get(a..b).unwrap_or(&[]),
            _ => &[],
        }
    };
    let hm = u16_at(hhea, 34)? as usize;
    let metric = |i: usize| -> (u16, i16) {
        let adv = u16_at(hmtx, hm.min(i + 1).saturating_sub(1) * 4).unwrap_or(0);
        let lsb = if i < hm {
            u16_at(hmtx, i * 4 + 2)
        } else {
            u16_at(hmtx, hm * 4 + (i - hm) * 2)
        };
        (adv, lsb.unwrap_or(0) as i16)
    };

    let mapping = lookup(cmap, chars)?;
    if mapping.is_empty() {
        return None;
    }
    let mut keep: FxHashSet<u16> = mapping.iter().map(|m| m.1).collect();
    keep.insert(0);
    if keep_layout {
        // glyphs no character maps to are only reachable through GSUB
        let all: Vec<char> = (0..=0x10FFFFu32).filter_map(char::from_u32).collect();
        let encoded: FxHashSet<u16> = lookup(cmap, &all)?.into_iter().map(|m| m.1).collect();
        keep.extend((0..num as u16).filter(|g| !encoded.contains(g)));
    }
    let mut stack: Vec<u16> = keep.iter().copied().collect();
    while let Some(g) = stack.pop() {
        for (_, c) in components(glyph(g as usize)) {
            if (c as usize) < num && keep.insert(c) {
                stack.push(c);
            }
        }
    }
    let order: Vec<u16> = if keep_layout {
        (0..num as u16).collect()
    } else {
        let mut v: Vec<u16> = keep.iter().copied().collect();
        v.sort();
        v
    };
    let new_id: FxHashMap<u16, u16> = order
        .iter()
        .enumerate()
        .map(|(i, &g)| (g, i as u16))
        .collect();

    let (mut nglyf, mut nloca, mut nhmtx) = (vec![], vec![], vec![]);
    for &g in &order {
        nloca.extend_from_slice(&(nglyf.len() as u32).to_be_bytes());
        let (adv, lsb) = metric(g as usize);
        nhmtx.extend_from_slice(&adv.to_be_bytes());
        nhmtx.extend_from_slice(&lsb.to_be_bytes());
        if !keep.contains(&g) {
            continue;
        }
        let mut data = glyph(g as usize).to_vec();
        if !keep_layout {
            for (o, c) in components(&data.clone()) {
                data[o..o + 2].copy_from_slice(&new_id.get(&c).copied().unwrap_or(0).to_be_bytes());
            }
        }
        nglyf.extend(data);
        while nglyf.len() % 4 != 0 {
            nglyf.push(0);
        }
    }
    nloca.extend_from_slice(&(nglyf.len() as u32).to_be_bytes());
    let n = order.len() as u16;
    let mut nhead = head.to_vec();
    nhead[8..12].copy_from_slice(&[0; 4]);
    nhead[50..52].copy_from_slice(&1u16.to_be_bytes());
    let mut nmaxp = maxp.to_vec();
    nmaxp[4..6].copy_from_slice(&n.to_be_bytes());
    let mut nhhea = hhea.to_vec();
    nhhea[34..36].copy_from_slice(&n.to_be_bytes());
    let mut map: Vec<(u32, u32)> = mapping
        .iter()
        .map(|&(c, g)| (c as u32, new_id[&g] as u32))
        .collect();
    map.sort();
    map.dedup_by_key(|m| m.0);
    let mut post = get(b"post")
        .map(|p| p.get(..32).unwrap_or(p).to_vec())
        .unwrap_or_default();
    if post.len() == 32 {
        post[0..4].copy_from_slice(&0x0003_0000u32.to_be_bytes());
    }

    const DROP_ALWAYS: [&[u8; 4]; 5] = [b"DSIG", b"hdmx", b"LTSH", b"VDMX", b"FFTM"];
    const DROP_LAYOUT: [&[u8; 4]; 9] = [
        b"GSUB", b"GPOS", b"GDEF", b"kern", b"vmtx", b"vhea", b"BASE", b"JSTF", b"MATH",
    ];
    let mut out_tabs: Vec<([u8; 4], Vec<u8>)> = vec![];
    for (tag, data) in &tabs {
        if DROP_ALWAYS.contains(&tag) || (!keep_layout && DROP_LAYOUT.contains(&tag)) {
            continue;
        }
        let d = match tag {
            b"head" => nhead.clone(),
            b"maxp" => nmaxp.clone(),
            b"hhea" => nhhea.clone(),
            b"hmtx" => nhmtx.clone(),
            b"loca" => nloca.clone(),
            b"glyf" => nglyf.clone(),
            b"cmap" => cmap_table(&map),
            b"post" if post.len() == 32 => post.clone(),
            _ => data.to_vec(),
        };
        out_tabs.push((*tag, d));
    }
    out_tabs.sort_by_key(|t| t.0);
    let nt = out_tabs.len();
    let pow = 1usize << (usize::BITS - 1 - nt.leading_zeros());
    let mut out = vec![];
    out.extend_from_slice(&font[0..4]);
    for v in [
        nt,
        pow * 16,
        pow.trailing_zeros() as usize,
        nt * 16 - pow * 16,
    ] {
        out.extend_from_slice(&(v as u16).to_be_bytes());
    }
    let mut off = 12 + nt * 16;
    let mut head_at = None;
    for (tag, d) in &out_tabs {
        if tag == b"head" {
            head_at = Some(off);
        }
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum(d).to_be_bytes());
        out.extend_from_slice(&(off as u32).to_be_bytes());
        out.extend_from_slice(&(d.len() as u32).to_be_bytes());
        off += d.len().div_ceil(4) * 4;
    }
    for (_, d) in &out_tabs {
        out.extend_from_slice(d);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    if let Some(h) = head_at {
        let adj = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[h + 8..h + 12].copy_from_slice(&adj.to_be_bytes());
    }
    Some(out)
}

/// Whether the font maps `c` (any Unicode `cmap` subtable).
pub fn covers(font: &[u8], c: char) -> bool {
    tables(font)
        .and_then(|t| t.iter().find(|x| &x.0 == b"cmap").map(|x| x.1))
        .and_then(|cmap| lookup(cmap, &[c]))
        .is_some_and(|m| !m.is_empty())
}

/// Every character the font maps.
pub fn mapped_chars(font: &[u8]) -> Vec<char> {
    let all: Vec<char> = (0..=0x10FFFFu32).filter_map(char::from_u32).collect();
    tables(font)
        .and_then(|t| t.iter().find(|x| &x.0 == b"cmap").map(|x| x.1))
        .and_then(|cmap| lookup(cmap, &all))
        .map_or(vec![], |m| m.into_iter().map(|m| m.0).collect())
}
