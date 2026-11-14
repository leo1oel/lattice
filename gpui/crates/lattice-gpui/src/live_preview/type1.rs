//! Type 1 fonts (.pfb/.pfa) and pdftex.map entries, as glyph outlines by
//! character code (`src/live-preview/rtex-type1.ts`, adapted there from
//! realtime-tex-vsc-plugin's `src/type1.ts`, MIT License, Copyright (c) 2026
//! Henry Yang; see THIRD_PARTY_NOTICES.md).
//!
//! TFM fonts in rtex display lists carry only a character code (no glyph
//! index, no file); their outlines are found through the map file. Pure
//! module.

use std::collections::HashMap;

use regex::{Regex, bytes::Regex as BytesRegex};
use tiny_skia::{Path, PathBuilder};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MapEntry {
    pub tfm: String,
    pub font_file: Option<String>,
    pub enc_file: Option<String>,
    pub slant: Option<f64>,
    pub extend: Option<f64>,
}

/// Parse a pdftex.map (dvipdfm-style) map file.
pub fn parse_map_file(text: &str) -> HashMap<String, MapEntry> {
    let token = Regex::new(r#""([^"]*)"|(\S+)"#).expect("a valid pattern");
    let mut out = HashMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('%') || line.starts_with('#') {
            continue;
        }
        let tokens: Vec<(bool, &str)> = token
            .captures_iter(line)
            .filter_map(|captures| match (captures.get(1), captures.get(2)) {
                (Some(quoted), _) => Some((true, quoted.as_str())),
                (_, Some(bare)) => Some((false, bare.as_str())),
                _ => None,
            })
            .collect();
        let Some(((_, tfm), rest)) = tokens.split_first() else {
            continue;
        };
        let mut entry = MapEntry {
            tfm: tfm.to_string(),
            ..MapEntry::default()
        };
        for (quoted, value) in rest {
            if *quoted {
                let words: Vec<&str> = value.split_whitespace().collect();
                for pair in words.windows(2) {
                    match pair[1] {
                        "SlantFont" => entry.slant = pair[0].parse().ok(),
                        "ExtendFont" => entry.extend = pair[0].parse().ok(),
                        _ => {}
                    }
                }
            } else if let Some(file) = value.strip_prefix('<') {
                let file = file.trim_start_matches(['<', '[']);
                if file.is_empty() {
                    continue;
                }
                if file.to_ascii_lowercase().ends_with(".enc") {
                    entry.enc_file = Some(file.to_string());
                } else {
                    entry.font_file = Some(file.to_string());
                }
            }
        }
        out.entry(entry.tfm.clone()).or_insert(entry);
    }
    out
}

/// Glyph names of an .enc file (`/Name [ /a /b … ] def`), indexed by code.
pub fn parse_enc_file(text: &str) -> Vec<String> {
    let clean: String = text
        .lines()
        .map(|line| line.split('%').next().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let (Some(start), Some(end)) = (clean.find('['), clean.rfind(']')) else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }
    clean[start + 1..end]
        .split_whitespace()
        .filter_map(|token| token.strip_prefix('/'))
        .map(str::to_string)
        .collect()
}

/// A Type 1 font's outlines: font units per em and a path per character
/// code, in font units with y up.
pub struct Type1Outlines {
    pub upem: f64,
    pub glyphs: HashMap<u32, Path>,
}

struct Type1Font {
    font_matrix: Vec<f64>,
    encoding: Vec<Option<String>>,
    subrs: Vec<Option<Vec<u8>>>,
    char_strings: HashMap<String, Vec<u8>>,
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

fn decrypt(data: &[u8], key: u16, skip: usize) -> Vec<u8> {
    let mut r = key;
    let mut out = Vec::with_capacity(data.len().saturating_sub(skip));
    for (i, c) in data.iter().enumerate() {
        let plain = c ^ (r >> 8) as u8;
        r = (u16::from(*c).wrapping_add(r))
            .wrapping_mul(52845)
            .wrapping_add(22719);
        if i >= skip {
            out.push(plain);
        }
    }
    out
}

/// Split a .pfb/.pfa file into its cleartext and (still encrypted) eexec
/// parts.
fn split_font(file: &[u8]) -> (String, Vec<u8>) {
    if file.first() == Some(&0x80) {
        let mut clear = Vec::new();
        let mut binary: Vec<u8> = Vec::new();
        let mut i = 0;
        while i + 6 <= file.len() && file[i] == 0x80 {
            let kind = file[i + 1];
            if kind == 3 {
                break;
            }
            let len = u32::from_le_bytes([file[i + 2], file[i + 3], file[i + 4], file[i + 5]])
                as usize;
            let segment = &file[i + 6..(i + 6 + len).min(file.len())];
            if kind == 1 {
                // Only the cleartext before the binary part: the trailer's
                // zeros and cleartomark are not the font's.
                if binary.is_empty() {
                    clear.extend_from_slice(segment);
                }
            } else {
                binary.extend_from_slice(segment);
            }
            i += 6 + len;
        }
        return (latin1(&clear), binary);
    }
    // PFA: cleartext, `eexec`, then hex.
    let text = latin1(file);
    let Some(at) = text.find("eexec") else {
        return (text, Vec::new());
    };
    let hex: Vec<u8> = text[at + 5..]
        .bytes()
        .filter(u8::is_ascii_hexdigit)
        .collect();
    let encrypted = hex
        .chunks_exact(2)
        .filter_map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect();
    (text[..at + 5].to_string(), encrypted)
}

fn parse_type1(file: &[u8]) -> Type1Font {
    let (clear, encrypted) = split_font(file);
    let font_matrix = Regex::new(r"/FontMatrix\s*\[([^\]]*)\]")
        .expect("a valid pattern")
        .captures(&clear)
        .map(|captures| {
            captures[1]
                .split_whitespace()
                .filter_map(|value| value.parse().ok())
                .collect()
        })
        .unwrap_or_else(|| vec![0.001, 0., 0., 0.001, 0., 0.]);
    let encoding = if Regex::new(r"/Encoding\s+StandardEncoding")
        .expect("a valid pattern")
        .is_match(&clear)
    {
        standard_encoding()
    } else {
        let mut encoding = Vec::new();
        for captures in Regex::new(r"dup\s+(\d+)\s*/([^\s/]+)\s+put")
            .expect("a valid pattern")
            .captures_iter(&clear)
        {
            let Ok(code) = captures[1].parse::<usize>() else {
                continue;
            };
            if code < 256 {
                if encoding.len() <= code {
                    encoding.resize(code + 1, None);
                }
                encoding[code] = Some(captures[2].to_string());
            }
        }
        encoding
    };
    let private = decrypt(&encrypted, 55665, 4);
    // The private dictionary is binary between its tokens: match on bytes,
    // so an offset is the charstring's own.
    let len_iv: i64 = BytesRegex::new(r"(?-u)/lenIV\s+(-?\d+)")
        .expect("a valid pattern")
        .captures(&private)
        .and_then(|captures| std::str::from_utf8(&captures[1]).ok()?.parse().ok())
        .unwrap_or(4);
    let char_decrypt = |bytes: &[u8]| {
        if len_iv < 0 {
            bytes.to_vec()
        } else {
            decrypt(bytes, 4330, len_iv as usize)
        }
    };
    let find = |needle: &[u8]| private.windows(needle.len()).position(|window| window == needle);
    let number = |bytes: &[u8]| std::str::from_utf8(bytes).ok()?.parse::<usize>().ok();
    let subrs_at = find(b"/Subrs");
    let char_strings_at = find(b"/CharStrings");
    let mut subrs: Vec<Option<Vec<u8>>> = Vec::new();
    if let Some(at) = subrs_at {
        let pattern = BytesRegex::new(r"(?-u)dup\s+(\d+)\s+(\d+)\s+(\S+) ").expect("a valid pattern");
        let mut from = at;
        while let Some(captures) = pattern.captures_at(&private, from) {
            let whole = captures.get(0).expect("the whole match");
            if char_strings_at.is_some_and(|cs| whole.start() > cs) {
                break;
            }
            let (Some(index), Some(len)) = (number(&captures[1]), number(&captures[2])) else {
                break;
            };
            let Some(bytes) = private.get(whole.end()..whole.end() + len) else {
                break;
            };
            if index < 65_536 {
                if subrs.len() <= index {
                    subrs.resize(index + 1, None);
                }
                subrs[index] = Some(char_decrypt(bytes));
            }
            from = whole.end() + len;
        }
    }
    let mut char_strings = HashMap::new();
    if let Some(at) = char_strings_at {
        let pattern = BytesRegex::new(r"(?-u)/([^\s/\[\]{}()<>%]+)\s+(\d+)\s+(\S+) ")
            .expect("a valid pattern");
        let mut from = at + "/CharStrings".len();
        while let Some(captures) = pattern.captures_at(&private, from) {
            let whole = captures.get(0).expect("the whole match");
            let Some(len) = number(&captures[2]) else {
                break;
            };
            let Some(bytes) = private.get(whole.end()..whole.end() + len) else {
                break;
            };
            char_strings.insert(latin1(&captures[1]), char_decrypt(bytes));
            from = whole.end() + len;
        }
    }
    Type1Font {
        font_matrix,
        encoding,
        subrs,
        char_strings,
    }
}

/// A glyph's path, drawn as the charstring interpreter goes, in font units
/// with y up, at an offset (an accent of `seac`).
struct Pen {
    builder: PathBuilder,
    ox: f64,
    oy: f64,
}

impl Pen {
    fn point(&self, x: f64, y: f64) -> (f32, f32) {
        ((x + self.ox) as f32, (y + self.oy) as f32)
    }
}

struct Glyph<'a> {
    font: &'a Type1Font,
    stack: Vec<f64>,
    x: f64,
    y: f64,
    sbx: f64,
    open: bool,
    flexing: bool,
    done: bool,
}

impl<'a> Glyph<'a> {
    fn pop(&mut self) -> f64 {
        self.stack.pop().unwrap_or(0.)
    }

    fn take<const N: usize>(&mut self) -> [f64; N] {
        let mut values = [0.; N];
        let start = self.stack.len().saturating_sub(N);
        let taken = self.stack.split_off(start);
        values[N - taken.len()..].copy_from_slice(&taken);
        values
    }

    fn move_to(&mut self, pen: &mut Pen, x: f64, y: f64) {
        self.x = x;
        self.y = y;
        if self.open {
            pen.builder.close();
        }
        self.open = false;
    }

    fn ensure_open(&mut self, pen: &mut Pen) {
        if !self.open {
            let (x, y) = pen.point(self.x, self.y);
            pen.builder.move_to(x, y);
            self.open = true;
        }
    }

    fn line_to(&mut self, pen: &mut Pen, x: f64, y: f64) {
        self.ensure_open(pen);
        self.x = x;
        self.y = y;
        let (x, y) = pen.point(x, y);
        pen.builder.line_to(x, y);
    }

    #[allow(clippy::too_many_arguments)]
    fn curve_to(&mut self, pen: &mut Pen, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64) {
        self.ensure_open(pen);
        let (a, b) = pen.point(x1, y1);
        let (c, d) = pen.point(x2, y2);
        let (e, f) = pen.point(x3, y3);
        pen.builder.cubic_to(a, b, c, d, e, f);
        self.x = x3;
        self.y = y3;
    }

    fn run(&mut self, pen: &mut Pen, code: &[u8], depth: usize) {
        if depth > 12 {
            return;
        }
        let mut i = 0;
        while i < code.len() && !self.done {
            let v = code[i];
            i += 1;
            if v >= 32 {
                let value = match v {
                    32..=246 => f64::from(v) - 139.,
                    247..=250 => {
                        let w = f64::from(*code.get(i).unwrap_or(&0));
                        i += 1;
                        (f64::from(v) - 247.) * 256. + w + 108.
                    }
                    251..=254 => {
                        let w = f64::from(*code.get(i).unwrap_or(&0));
                        i += 1;
                        -(f64::from(v) - 251.) * 256. - w - 108.
                    }
                    _ => {
                        let bytes: [u8; 4] = code
                            .get(i..i + 4)
                            .and_then(|bytes| bytes.try_into().ok())
                            .unwrap_or([0; 4]);
                        i += 4;
                        f64::from(i32::from_be_bytes(bytes))
                    }
                };
                self.stack.push(value);
                continue;
            }
            match v {
                // hstem, vstem
                1 | 3 => self.stack.clear(),
                // vmoveto
                4 => {
                    if self.flexing {
                        let at = self.stack.len().saturating_sub(1);
                        self.stack.insert(at, 0.);
                        continue;
                    }
                    let dy = self.pop();
                    self.move_to(pen, self.x, self.y + dy);
                    self.stack.clear();
                }
                // rlineto
                5 => {
                    let [dx, dy] = self.take();
                    self.line_to(pen, self.x + dx, self.y + dy);
                    self.stack.clear();
                }
                // hlineto, vlineto
                6 => {
                    let dx = self.pop();
                    self.line_to(pen, self.x + dx, self.y);
                    self.stack.clear();
                }
                7 => {
                    let dy = self.pop();
                    self.line_to(pen, self.x, self.y + dy);
                    self.stack.clear();
                }
                // rrcurveto
                8 => {
                    let [a, b, c, d, e, f] = self.take();
                    let (x, y) = (self.x, self.y);
                    self.curve_to(pen, x + a, y + b, x + a + c, y + b + d, x + a + c + e, y + b + d + f);
                    self.stack.clear();
                }
                // closepath
                9 => {
                    if self.open {
                        pen.builder.close();
                    }
                    self.open = false;
                    self.stack.clear();
                }
                // callsubr
                10 => {
                    let index = self.pop();
                    let sub = (index >= 0.)
                        .then(|| self.font.subrs.get(index as usize))
                        .flatten()
                        .and_then(Option::as_ref)
                        .cloned();
                    if let Some(sub) = sub {
                        self.run(pen, &sub, depth + 1);
                    }
                }
                // return
                11 => return,
                // hsbw
                13 => {
                    let [sbx, _width] = self.take();
                    self.sbx = sbx;
                    self.x = sbx;
                    self.y = 0.;
                    self.stack.clear();
                }
                // endchar
                14 => self.done = true,
                // rmoveto: flex points stay on the stack
                21 => {
                    if self.flexing {
                        continue;
                    }
                    let [dx, dy] = self.take();
                    self.move_to(pen, self.x + dx, self.y + dy);
                    self.stack.clear();
                }
                // hmoveto
                22 => {
                    if self.flexing {
                        self.stack.push(0.);
                        continue;
                    }
                    let dx = self.pop();
                    self.move_to(pen, self.x + dx, self.y);
                    self.stack.clear();
                }
                // vhcurveto
                30 => {
                    let [dy1, dx2, dy2, dx3] = self.take();
                    let (x, y) = (self.x, self.y);
                    self.curve_to(pen, x, y + dy1, x + dx2, y + dy1 + dy2, x + dx2 + dx3, y + dy1 + dy2);
                    self.stack.clear();
                }
                // hvcurveto
                31 => {
                    let [dx1, dx2, dy2, dy3] = self.take();
                    let (x, y) = (self.x, self.y);
                    self.curve_to(pen, x + dx1, y, x + dx1 + dx2, y + dy2, x + dx1 + dx2, y + dy2 + dy3);
                    self.stack.clear();
                }
                12 => {
                    let op = *code.get(i).unwrap_or(&0);
                    i += 1;
                    self.escape(pen, op);
                }
                _ => self.stack.clear(),
            }
        }
    }

    fn escape(&mut self, pen: &mut Pen, op: u8) {
        match op {
            // dotsection, vstem3, hstem3, setcurrentpoint
            0 | 1 | 2 | 33 => self.stack.clear(),
            // seac
            6 => {
                let [asb, adx, ady, bchar, achar] = self.take();
                self.stack.clear();
                let standard = standard_encoding();
                let named = |code: f64| {
                    standard
                        .get(code.max(0.) as usize)
                        .cloned()
                        .flatten()
                        .and_then(|name| self.font.char_strings.get(&name).cloned())
                };
                let (base, accent) = (named(bchar), named(achar));
                if self.open {
                    pen.builder.close();
                }
                self.open = false;
                if let Some(base) = base {
                    draw(self.font, &base, pen.ox, pen.oy, &mut pen.builder);
                }
                if let Some(accent) = accent {
                    draw(
                        self.font,
                        &accent,
                        pen.ox + adx + self.sbx - asb,
                        pen.oy + ady,
                        &mut pen.builder,
                    );
                }
                self.done = true;
            }
            // sbw
            7 => {
                let [sbx, sby, _wx, _wy] = self.take();
                self.sbx = sbx;
                self.x = sbx;
                self.y = sby;
                self.stack.clear();
            }
            // div
            12 => {
                let b = self.stack.pop().unwrap_or(1.);
                let a = self.pop();
                self.stack.push(a / b);
            }
            // callothersubr: flex (0, 1, 2) and hint replacement (3); other
            // arguments stay on the stack for the `pop`s that follow, which
            // are no-ops.
            16 => {
                let index = self.stack.pop().unwrap_or(-1.);
                let n = self.pop();
                if index == 1. && n == 0. {
                    self.flexing = true;
                } else if index == 0. && n == 3. && self.flexing {
                    let end_y = self.pop();
                    let end_x = self.pop();
                    self.pop(); // flex height
                    let start = self.stack.len().saturating_sub(14);
                    let points = self.stack.split_off(start);
                    self.flexing = false;
                    if points.len() == 14 {
                        let (mut cx, mut cy) = (self.x + points[0], self.y + points[1]);
                        let mut p = Vec::with_capacity(12);
                        for pair in points[2..].chunks_exact(2) {
                            cx += pair[0];
                            cy += pair[1];
                            p.extend([cx, cy]);
                        }
                        self.curve_to(pen, p[0], p[1], p[2], p[3], p[4], p[5]);
                        self.curve_to(pen, p[6], p[7], p[8], p[9], p[10], p[11]);
                    }
                    self.stack.extend([end_x, end_y]);
                }
            }
            // pop
            17 => {}
            _ => self.stack.clear(),
        }
    }
}

fn draw(font: &Type1Font, glyph: &[u8], ox: f64, oy: f64, builder: &mut PathBuilder) {
    let mut pen = Pen {
        builder: std::mem::take(builder),
        ox,
        oy,
    };
    let mut state = Glyph {
        font,
        stack: Vec::new(),
        x: 0.,
        y: 0.,
        sbx: 0.,
        open: false,
        flexing: false,
        done: false,
    };
    state.run(&mut pen, glyph, 0);
    if state.open {
        pen.builder.close();
    }
    *builder = pen.builder;
}

/// Outlines of all encoded glyphs of a Type 1 font. `encoding` overrides the
/// font's own.
pub fn type1_outlines(file: &[u8], encoding: Option<&[String]>) -> Type1Outlines {
    let font = parse_type1(file);
    let names: Vec<Option<String>> = match encoding {
        Some(encoding) if !encoding.is_empty() => {
            encoding.iter().map(|name| Some(name.clone())).collect()
        }
        _ => font.encoding.clone(),
    };
    let mut glyphs = HashMap::new();
    for (code, name) in names.iter().enumerate().take(256) {
        let Some(name) = name.as_deref().filter(|name| *name != ".notdef") else {
            continue;
        };
        let Some(char_string) = font.char_strings.get(name) else {
            continue;
        };
        let mut builder = PathBuilder::new();
        draw(&font, char_string, 0., 0., &mut builder);
        if let Some(path) = builder.finish() {
            glyphs.insert(code as u32, path);
        }
    }
    let upem = match font.font_matrix.first() {
        Some(scale) if *scale != 0. => (1. / scale).round(),
        _ => 1000.,
    };
    Type1Outlines { upem, glyphs }
}

/// Adobe StandardEncoding (used by `seac` and by fonts declaring
/// `/Encoding StandardEncoding`).
fn standard_encoding() -> Vec<Option<String>> {
    const ASCII: &str = "space exclam quotedbl numbersign dollar percent ampersand quoteright \
        parenleft parenright asterisk plus comma hyphen period slash zero one two three four five \
        six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K \
        L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore \
        quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright \
        asciitilde";
    const HIGH: [(usize, &str); 61] = [
        (161, "exclamdown"), (162, "cent"), (163, "sterling"), (164, "fraction"), (165, "yen"),
        (166, "florin"), (167, "section"), (168, "currency"), (169, "quotesingle"),
        (170, "quotedblleft"), (171, "guillemotleft"), (172, "guilsinglleft"),
        (173, "guilsinglright"), (174, "fi"), (175, "fl"), (177, "endash"), (178, "dagger"),
        (179, "daggerdbl"), (180, "periodcentered"), (182, "paragraph"), (183, "bullet"),
        (184, "quotesinglbase"), (185, "quotedblbase"), (186, "quotedblright"),
        (187, "guillemotright"), (188, "ellipsis"), (189, "perthousand"), (191, "questiondown"),
        (193, "grave"), (194, "acute"), (195, "circumflex"), (196, "tilde"), (197, "macron"),
        (198, "breve"), (199, "dotaccent"), (200, "dieresis"), (202, "ring"), (203, "cedilla"),
        (205, "hungarumlaut"), (206, "ogonek"), (207, "caron"), (208, "emdash"), (225, "AE"),
        (227, "ordfeminine"), (232, "Lslash"), (233, "Oslash"), (234, "OE"),
        (235, "ordmasculine"), (241, "ae"), (245, "dotlessi"), (248, "lslash"), (249, "oslash"),
        (250, "oe"), (251, "germandbls"), (0, ""), (0, ""), (0, ""), (0, ""), (0, ""), (0, ""),
        (0, ""),
    ];
    let mut encoding = vec![None; 256];
    for (ix, name) in ASCII.split_whitespace().enumerate() {
        encoding[32 + ix] = Some(name.to_string());
    }
    for (code, name) in HIGH {
        if !name.is_empty() {
            encoding[code] = Some(name.to_string());
        }
    }
    encoding
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_entries_name_their_files_and_transforms() {
        let map = parse_map_file(
            "% comment\n\
             cmr10 CMR10 <cmr10.pfb\n\
             ptmr8r Times-Roman \"TeXBase1Encoding ReEncodeFont\" <8r.enc <utmr8a.pfb\n\
             ptmro8r Times-Roman \" .167 SlantFont TeXBase1Encoding ReEncodeFont \" <8r.enc <<utmr8a.pfb\n\
             cmr10 Duplicate <other.pfb\n",
        );
        assert_eq!(map["cmr10"].font_file.as_deref(), Some("cmr10.pfb"));
        assert_eq!(map["ptmr8r"].enc_file.as_deref(), Some("8r.enc"));
        assert_eq!(map["ptmro8r"].slant, Some(0.167));
        assert_eq!(map["ptmro8r"].font_file.as_deref(), Some("utmr8a.pfb"));
    }

    #[test]
    fn encodings_list_their_names_by_code() {
        let names = parse_enc_file("% the 8r encoding\n/TeXBase1Encoding [ /.notdef /dotaccent % 1\n/fi ] def\n");
        assert_eq!(names, [".notdef", "dotaccent", "fi"]);
    }

    #[test]
    fn decryption_inverts_the_eexec_cipher() {
        // Encrypt with the same cipher, then read it back.
        let plain = b"abcd/Subrs 0 array";
        let mut r: u16 = 55665;
        let cipher: Vec<u8> = plain
            .iter()
            .map(|p| {
                let c = p ^ (r >> 8) as u8;
                r = (u16::from(c).wrapping_add(r)).wrapping_mul(52845).wrapping_add(22719);
                c
            })
            .collect();
        assert_eq!(decrypt(&cipher, 55665, 4), plain[4..]);
    }

    /// A real Type 1 font from the TeX tree draws its letters.
    #[test]
    fn the_tex_trees_computer_modern_has_outlines() {
        let Ok(output) = std::process::Command::new("kpsewhich").arg("cmr10.pfb").output() else {
            return;
        };
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let Ok(bytes) = std::fs::read(&path) else {
            return;
        };
        let outlines = type1_outlines(&bytes, None);
        assert_eq!(outlines.upem, 1000.);
        let a = outlines.glyphs.get(&u32::from(b'A')).expect("an A");
        let bounds = a.bounds();
        assert!(bounds.width() > 500. && bounds.height() > 600., "{bounds:?}");
        assert!(outlines.glyphs.len() > 100);
    }
}
