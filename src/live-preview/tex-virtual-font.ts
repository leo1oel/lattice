/**
 * TeX virtual fonts (.vf) and the character widths of their base fonts (.tfm).
 *
 * rtex's display lists name a TFM font such as `ptmr8t` (Times in the T1
 * encoding, what `\usepackage{times}` selects under LuaLaTeX) by name only.
 * pdftex.map has no outline for it because it is virtual: each of its
 * characters is a short DVI program that sets characters of real fonts
 * (`ptmr8r`, Times in TeX's base encoding) and moves between them. This
 * module runs those programs once per font into parts the renderer draws.
 *
 * Formats: Knuth's VFtoVP and TFtoPL (TeX Live's texk/web2c). Every length
 * here is a fraction of the font's size, as the files store them.
 */
/* eslint-disable lingui/no-unlocalized-strings -- parse errors are logged, never shown */

/** One piece of a virtual character: a character of base font `font` at (h, v), or a rule. */
type VirtualPart =
  | { font: number; char: number; h: number; v: number }
  | { rule: true; h: number; v: number; width: number; height: number };

/** A base font a virtual font draws from, at `scale` times the virtual font's size. */
type VirtualFontRef = { name: string; scale: number };

export type VirtualFont = {
  fonts: VirtualFontRef[];
  /** Each character's parts, by character code. */
  chars: Map<number, VirtualPart[]>;
  /** Packets that need something this renderer cannot draw (a \special). */
  unsupported: Set<number>;
};

/** Character widths of a TFM font, as fractions of its size, by character code. */
export type TfmWidths = Map<number, number>;

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done() {
    return this.offset >= this.bytes.length;
  }
  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i += 1) value = value * 256 + this.bytes[this.offset++];
    return value;
  }
  s(n: number): number {
    const value = this.u(n);
    const top = 2 ** (8 * n);
    return value >= top / 2 ? value - top : value;
  }
  /** A fix_word: a signed 32-bit number with 20 fraction bits. */
  fix(): number {
    return this.s(4) / 2 ** 20;
  }
  text(n: number): string {
    const value = String.fromCharCode(...this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return value;
  }
}

/** The widths of a .tfm file's characters. */
export function parseTfm(bytes: Uint8Array): TfmWidths {
  const r = new Reader(bytes);
  r.u(2); // lf
  const lh = r.u(2);
  const bc = r.u(2);
  const ec = r.u(2);
  const nw = r.u(2);
  r.offset = 24 + lh * 4;
  const infos: number[] = [];
  for (let code = bc; code <= ec; code += 1) {
    infos.push(r.u(1));
    r.offset += 3;
  }
  const widths: number[] = [];
  for (let i = 0; i < nw; i += 1) widths.push(r.fix());
  const out: TfmWidths = new Map();
  infos.forEach((index, i) => {
    if (index > 0) out.set(bc + i, widths[index] ?? 0);
  });
  return out;
}

const PRE = 247;
const POST = 248;
const LONG_CHAR = 242;

/**
 * Run a .vf file's character programs. `widths(font)` gives the character
 * widths of its base font number `font`, for the move after a set.
 */
export function parseVirtualFont(bytes: Uint8Array, widths: (font: number) => TfmWidths | undefined): VirtualFont {
  const r = new Reader(bytes);
  if (r.u(1) !== PRE || r.u(1) !== 202) throw new Error("not a virtual font");
  const comment = r.u(1);
  r.offset += comment;
  r.u(4); // checksum
  r.u(4); // design size
  const fonts: VirtualFontRef[] = [];
  const numbers = new Map<number, number>();
  const chars = new Map<number, VirtualPart[]>();
  const unsupported = new Set<number>();
  while (!r.done) {
    const op = r.u(1);
    if (op >= 243 && op <= 246) {
      const k = r.u(op - 242);
      r.u(4); // checksum
      const scale = r.fix();
      r.u(4); // design size
      const area = r.u(1);
      const name = r.u(1);
      r.offset += area;
      numbers.set(k, fonts.length);
      fonts.push({ name: r.text(name), scale });
      continue;
    }
    if (op === POST) break;
    let length: number;
    let code: number;
    if (op === LONG_CHAR) {
      length = r.u(4);
      code = r.u(4);
      r.u(4);
    } else if (op < LONG_CHAR) {
      length = op;
      code = r.u(1);
      r.u(3);
    } else {
      throw new Error(`unexpected virtual font command ${op}`);
    }
    const program = bytes.subarray(r.offset, r.offset + length);
    r.offset += length;
    const parts = runPacket(program, fonts, numbers, widths);
    if (parts) chars.set(code, parts);
    else unsupported.add(code);
  }
  return { fonts, chars, unsupported };
}

/** One character's DVI program as parts; null when it holds a \special. */
function runPacket(
  program: Uint8Array, fonts: VirtualFontRef[], numbers: Map<number, number>, widths: (font: number) => TfmWidths | undefined,
): VirtualPart[] | null {
  const r = new Reader(program);
  const parts: VirtualPart[] = [];
  let font = fonts.length ? 0 : -1;
  let [h, v, w, x, y, z] = [0, 0, 0, 0, 0, 0];
  const stack: number[][] = [];
  const setChar = (char: number, move: boolean) => {
    parts.push({ font, char, h, v });
    if (move) h += (widths(font)?.get(char) ?? 0) * (fonts[font]?.scale ?? 1);
  };
  const rule = (move: boolean) => {
    const height = r.s(4) / 2 ** 20;
    const width = r.s(4) / 2 ** 20;
    if (height > 0 && width > 0) parts.push({ rule: true, h, v, width, height });
    if (move) h += width;
  };
  const fix = (n: number) => r.s(n) / 2 ** 20;
  while (!r.done) {
    const op = r.u(1);
    if (op < 128) setChar(op, true);
    else if (op <= 131) setChar(r.u(op - 127), true);
    else if (op === 132) rule(true);
    else if (op <= 136) setChar(r.u(op - 132), false);
    else if (op === 137) rule(false);
    else if (op === 138) continue;
    else if (op === 141) stack.push([h, v, w, x, y, z]);
    else if (op === 142) [h, v, w, x, y, z] = stack.pop() ?? [h, v, w, x, y, z];
    else if (op <= 146) h += fix(op - 142);
    else if (op === 147) h += w;
    else if (op <= 151) h += (w = fix(op - 147));
    else if (op === 152) h += x;
    else if (op <= 156) h += (x = fix(op - 152));
    else if (op <= 160) v += fix(op - 156);
    else if (op === 161) v += y;
    else if (op <= 165) v += (y = fix(op - 161));
    else if (op === 166) v += z;
    else if (op <= 170) v += (z = fix(op - 166));
    else if (op <= 234) font = numbers.get(op - 171) ?? -1;
    else if (op <= 238) font = numbers.get(r.u(op - 234)) ?? -1;
    else return null; // xxx (a \special) or anything stranger
  }
  return parts;
}
