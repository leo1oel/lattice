import { describe, expect, it } from "vitest";
import { parseTfm, parseVirtualFont } from "./tex-virtual-font";

const word = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const fix = (value: number) => word(Math.round(value * 2 ** 20) | 0);

/** A .vf file over one base font, `ptmr8r`, holding `packets` (code → DVI bytes). */
function virtualFont(packets: Record<number, number[]>): Uint8Array {
  const bytes = [247, 202, 0, ...word(0), ...fix(10)];
  bytes.push(243, 0, ...word(0), ...fix(1), ...fix(10), 0, 6, ..."ptmr8r".split("").map((c) => c.charCodeAt(0)));
  for (const [code, dvi] of Object.entries(packets)) bytes.push(dvi.length, Number(code), 0, 0, 0, ...dvi);
  bytes.push(248, 248, 248, 248);
  return new Uint8Array(bytes);
}

describe("TeX virtual fonts", () => {
  it("runs each character's program into base-font characters and moves", () => {
    const widths = new Map([[66, 0.5]]);
    const vf = parseVirtualFont(virtualFont({
      // T1 'A' is 8r 'A'
      65: [65],
      // a composite: B, then C half an em to the right, then a rule
      66: [141, 66, 142, 143, 0x40, 67, 132, ...fix(0.1), ...fix(0.2)],
      // a \special cannot be drawn
      67: [239, 1, 0],
    }), () => widths);
    expect(vf.fonts).toEqual([{ name: "ptmr8r", scale: 1 }]);
    expect(vf.chars.get(65)).toEqual([{ font: 0, char: 65, h: 0, v: 0 }]);
    const parts = vf.chars.get(66)!;
    expect(parts[0]).toEqual({ font: 0, char: 66, h: 0, v: 0 });
    // right1 0x40 is 64 / 2^20 of the size: tiny, but carried
    expect(parts[1]).toMatchObject({ font: 0, char: 67 });
    expect((parts[1] as { h: number }).h).toBeCloseTo(64 / 2 ** 20);
    expect(parts[2]).toMatchObject({ rule: true });
    expect((parts[2] as { height: number }).height).toBeCloseTo(0.1);
    expect((parts[2] as { width: number }).width).toBeCloseTo(0.2);
    expect(vf.unsupported.has(67)).toBe(true);
  });

  it("reads character widths from a TFM file", () => {
    // lf, lh=2, bc=65, ec=66, nw=3, then zeros; header of 2 words; two char_info words; three widths
    const head = [0, 0, 0, 2, 0, 65, 0, 66, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const bytes = new Uint8Array([...head, ...word(0), ...fix(10), 1, 0, 0, 0, 2, 0, 0, 0, ...fix(0), ...fix(0.25), ...fix(0.5)]);
    expect([...parseTfm(bytes)]).toEqual([[65, 0.25], [66, 0.5]]);
  });
});
