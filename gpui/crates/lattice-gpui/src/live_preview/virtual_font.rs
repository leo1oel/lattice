//! TeX virtual fonts (.vf) and the character widths of their base fonts
//! (.tfm), as `src/live-preview/tex-virtual-font.ts` reads them.
//!
//! rtex's display lists name a TFM font such as `ptmr8t` (Times in the T1
//! encoding, what `\usepackage{times}` selects under LuaLaTeX) by name only.
//! pdftex.map has no outline for it because it is virtual: each of its
//! characters is a short DVI program that sets characters of real fonts
//! (`ptmr8r`, Times in TeX's base encoding) and moves between them. This
//! module runs those programs once per font into parts the renderer draws.
//!
//! Formats: Knuth's VFtoVP and TFtoPL (TeX Live's texk/web2c). Every length
//! here is a fraction of the font's size, as the files store them.

use std::collections::{HashMap, HashSet};

/// One piece of a virtual character: a character of base font `font` at
/// (h, v), or a rule.
#[derive(Clone, Debug, PartialEq)]
pub enum VirtualPart {
    Char {
        font: usize,
        char: u32,
        h: f64,
        v: f64,
    },
    Rule {
        h: f64,
        v: f64,
        width: f64,
        height: f64,
    },
}

/// A base font a virtual font draws from, at `scale` times the virtual
/// font's size.
#[derive(Clone, Debug, PartialEq)]
pub struct VirtualFontRef {
    pub name: String,
    pub scale: f64,
}

#[derive(Clone, Debug, Default)]
pub struct VirtualFont {
    pub fonts: Vec<VirtualFontRef>,
    /// Each character's parts, by character code.
    pub chars: HashMap<u32, Vec<VirtualPart>>,
    /// Packets that need something this renderer cannot draw (a \special).
    pub unsupported: HashSet<u32>,
}

/// Character widths of a TFM font, as fractions of its size, by code.
pub type TfmWidths = HashMap<u32, f64>;

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn done(&self) -> bool {
        self.offset >= self.bytes.len()
    }

    fn u(&mut self, n: usize) -> Result<u64, String> {
        let mut value = 0u64;
        for _ in 0..n {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or("the font file ends early")?;
            value = value * 256 + u64::from(byte);
            self.offset += 1;
        }
        Ok(value)
    }

    fn s(&mut self, n: usize) -> Result<i64, String> {
        let value = self.u(n)? as i64;
        let top = 1i64 << (8 * n);
        Ok(if value >= top / 2 { value - top } else { value })
    }

    /// A fix_word: a signed 32-bit number with 20 fraction bits.
    fn fix(&mut self) -> Result<f64, String> {
        Ok(self.s(4)? as f64 / f64::from(1 << 20))
    }

    fn text(&mut self, n: usize) -> Result<String, String> {
        let bytes = self
            .bytes
            .get(self.offset..self.offset + n)
            .ok_or("the font file ends early")?;
        self.offset += n;
        Ok(bytes.iter().map(|byte| char::from(*byte)).collect())
    }
}

/// The widths of a .tfm file's characters.
pub fn parse_tfm(bytes: &[u8]) -> Result<TfmWidths, String> {
    let mut r = Reader::new(bytes);
    r.u(2)?; // lf
    let lh = r.u(2)? as usize;
    let bc = r.u(2)? as u32;
    let ec = r.u(2)? as u32;
    let nw = r.u(2)? as usize;
    r.offset = 24 + lh * 4;
    let mut infos = Vec::new();
    // A font with no characters has ec = bc − 1.
    for _ in bc..ec.saturating_add(1) {
        infos.push(r.u(1)? as usize);
        r.offset += 3;
    }
    let mut widths = Vec::with_capacity(nw);
    for _ in 0..nw {
        widths.push(r.fix()?);
    }
    Ok(infos
        .into_iter()
        .enumerate()
        .filter(|(_, index)| *index > 0)
        .map(|(i, index)| (bc + i as u32, widths.get(index).copied().unwrap_or(0.)))
        .collect())
}

const PRE: u64 = 247;
const POST: u64 = 248;
const LONG_CHAR: u64 = 242;

/// The base fonts a .vf file names, in order, without running its
/// characters.
pub fn virtual_font_names(bytes: &[u8]) -> Result<Vec<String>, String> {
    Ok(parse_virtual_font(bytes, &|_| None)?
        .fonts
        .into_iter()
        .map(|font| font.name)
        .collect())
}

/// Run a .vf file's character programs. `widths(font)` gives the character
/// widths of its base font number `font`, for the move after a set.
pub fn parse_virtual_font(
    bytes: &[u8],
    widths: &dyn Fn(usize) -> Option<TfmWidths>,
) -> Result<VirtualFont, String> {
    let mut r = Reader::new(bytes);
    if r.u(1)? != PRE || r.u(1)? != 202 {
        return Err("not a virtual font".into());
    }
    let comment = r.u(1)? as usize;
    r.offset += comment;
    r.u(4)?; // checksum
    r.u(4)?; // design size
    let mut font = VirtualFont::default();
    let mut numbers = HashMap::new();
    let mut packets = Vec::new();
    while !r.done() {
        let op = r.u(1)?;
        if (243..=246).contains(&op) {
            let k = r.u((op - 242) as usize)?;
            r.u(4)?; // checksum
            let scale = r.fix()?;
            r.u(4)?; // design size
            let area = r.u(1)? as usize;
            let name = r.u(1)? as usize;
            r.offset += area;
            numbers.insert(k, font.fonts.len());
            font.fonts.push(VirtualFontRef {
                name: r.text(name)?,
                scale,
            });
            continue;
        }
        if op == POST {
            break;
        }
        let (length, code) = if op == LONG_CHAR {
            let length = r.u(4)? as usize;
            let code = r.u(4)? as u32;
            r.u(4)?;
            (length, code)
        } else if op < LONG_CHAR {
            let code = r.u(1)? as u32;
            r.u(3)?;
            (op as usize, code)
        } else {
            return Err(format!("unexpected virtual font command {op}"));
        };
        let program = bytes
            .get(r.offset..r.offset + length)
            .ok_or("the font file ends early")?;
        r.offset += length;
        packets.push((code, program));
    }
    // The base fonts' widths are asked for once all of them are known.
    let base_widths: Vec<Option<TfmWidths>> = (0..font.fonts.len()).map(widths).collect();
    for (code, program) in packets {
        match run_packet(program, &font.fonts, &numbers, &base_widths) {
            Some(parts) => {
                font.chars.insert(code, parts);
            }
            None => {
                font.unsupported.insert(code);
            }
        }
    }
    Ok(font)
}

/// One character's DVI program as parts; `None` when it holds a \special.
fn run_packet(
    program: &[u8],
    fonts: &[VirtualFontRef],
    numbers: &HashMap<u64, usize>,
    widths: &[Option<TfmWidths>],
) -> Option<Vec<VirtualPart>> {
    let mut r = Reader::new(program);
    let mut parts = Vec::new();
    let mut font: Option<usize> = (!fonts.is_empty()).then_some(0);
    let (mut h, mut v, mut w, mut x, mut y, mut z) = (0., 0., 0., 0., 0., 0.);
    let mut stack: Vec<[f64; 6]> = Vec::new();
    let advance = |font: Option<usize>, char: u32| -> f64 {
        font.map_or(0., |font| {
            widths
                .get(font)
                .and_then(Option::as_ref)
                .and_then(|widths| widths.get(&char))
                .copied()
                .unwrap_or(0.)
                * fonts.get(font).map_or(1., |font| font.scale)
        })
    };
    let fix = |r: &mut Reader, n: usize| -> Option<f64> {
        Some(r.s(n).ok()? as f64 / f64::from(1 << 20))
    };
    while !r.done() {
        let op = r.u(1).ok()?;
        let mut set = |char: u32, mv: bool, h: &mut f64| {
            if let Some(font) = font {
                parts.push(VirtualPart::Char {
                    font,
                    char,
                    h: *h,
                    v,
                });
            }
            if mv {
                *h += advance(font, char);
            }
        };
        match op {
            0..=127 => set(op as u32, true, &mut h),
            128..=131 => {
                let char = r.u((op - 127) as usize).ok()? as u32;
                set(char, true, &mut h);
            }
            132 | 137 => {
                let height = fix(&mut r, 4)?;
                let width = fix(&mut r, 4)?;
                if height > 0. && width > 0. {
                    parts.push(VirtualPart::Rule {
                        h,
                        v,
                        width,
                        height,
                    });
                }
                if op == 132 {
                    h += width;
                }
            }
            133..=136 => {
                let char = r.u((op - 132) as usize).ok()? as u32;
                set(char, false, &mut h);
            }
            138 => {}
            141 => stack.push([h, v, w, x, y, z]),
            142 => {
                if let Some(saved) = stack.pop() {
                    [h, v, w, x, y, z] = saved;
                }
            }
            143..=146 => h += fix(&mut r, (op - 142) as usize)?,
            147 => h += w,
            148..=151 => {
                w = fix(&mut r, (op - 147) as usize)?;
                h += w;
            }
            152 => h += x,
            153..=156 => {
                x = fix(&mut r, (op - 152) as usize)?;
                h += x;
            }
            157..=160 => v += fix(&mut r, (op - 156) as usize)?,
            161 => v += y,
            162..=165 => {
                y = fix(&mut r, (op - 161) as usize)?;
                v += y;
            }
            166 => v += z,
            167..=170 => {
                z = fix(&mut r, (op - 166) as usize)?;
                v += z;
            }
            171..=234 => font = numbers.get(&(op - 171)).copied(),
            235..=238 => {
                let k = r.u((op - 234) as usize).ok()?;
                font = numbers.get(&k).copied();
            }
            // xxx (a \special) or anything stranger.
            _ => return None,
        }
    }
    Some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fix_word(value: f64) -> [u8; 4] {
        ((value * f64::from(1 << 20)) as i32).to_be_bytes()
    }

    /// A virtual font of two characters: `A` sets base character 65 and
    /// moves by its width, then a rule; `B` (code 66) holds a \special.
    fn sample() -> Vec<u8> {
        let mut vf = vec![247, 202, 0];
        vf.extend([0; 8]);
        // fnt_def1 0: scale 1.0, name "base"
        vf.extend([243, 0]);
        vf.extend([0; 4]);
        vf.extend(fix_word(1.));
        vf.extend([0; 4]);
        vf.extend([0, 4]);
        vf.extend(b"base");
        // A: set_char_65, set_rule 0.1 × 0.5
        let mut program = vec![65, 132];
        program.extend(fix_word(0.1));
        program.extend(fix_word(0.5));
        vf.push(program.len() as u8);
        vf.push(b'A');
        vf.extend([0; 3]);
        vf.extend(&program);
        // B: xxx1
        vf.extend([2, b'B', 0, 0, 0, 239, 0]);
        vf.push(248);
        vf
    }

    #[test]
    fn character_programs_run_into_parts() {
        let widths = |_: usize| Some(TfmWidths::from([(65, 0.75)]));
        let font = parse_virtual_font(&sample(), &widths).unwrap();
        assert_eq!(
            font.fonts,
            [VirtualFontRef {
                name: "base".into(),
                scale: 1.
            }]
        );
        let parts = &font.chars[&u32::from(b'A')];
        assert_eq!(
            parts[0],
            VirtualPart::Char {
                font: 0,
                char: 65,
                h: 0.,
                v: 0.
            }
        );
        let VirtualPart::Rule {
            h, width, height, ..
        } = parts[1]
        else {
            panic!("a rule");
        };
        assert_eq!(h, 0.75);
        assert!((width - 0.5).abs() < 1e-6 && (height - 0.1).abs() < 1e-6);
        assert!(font.unsupported.contains(&u32::from(b'B')));
    }

    #[test]
    fn something_else_is_not_a_virtual_font() {
        assert!(parse_virtual_font(b"%PDF-1.5", &|_| None).is_err());
    }

    /// Times in T1, as `\usepackage{times}` selects it, from the TeX tree.
    #[test]
    fn the_tex_trees_times_is_virtual_over_its_base_encoding() {
        let find = |name: &str| {
            let output = std::process::Command::new("kpsewhich")
                .arg(name)
                .output()
                .ok()?;
            std::fs::read(String::from_utf8_lossy(&output.stdout).trim()).ok()
        };
        let (Some(vf), Some(tfm)) = (find("ptmr8t.vf"), find("ptmr8r.tfm")) else {
            return;
        };
        let widths = parse_tfm(&tfm).unwrap();
        assert!(
            widths
                .get(&u32::from(b'A'))
                .is_some_and(|width| *width > 0.5)
        );
        let font = parse_virtual_font(&vf, &|_| Some(widths.clone())).unwrap();
        assert_eq!(font.fonts[0].name, "ptmr8r");
        assert!(font.chars.contains_key(&u32::from(b'A')));
    }
}
