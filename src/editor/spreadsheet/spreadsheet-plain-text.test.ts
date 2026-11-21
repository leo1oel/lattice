import { describe, expect, it } from "vitest";
import { plainCellText, stripReservedControls } from "./spreadsheet-plain-text";

describe("plainCellText", () => {
  it("drops Univer's structure markers and keeps tabs and line breaks", () => {
    expect(plainCellText("TiMtiMMIT\x1f")).toBe("TiMtiMMIT");
    expect(plainCellText("\x1flink\x1e \bblock \x1atable\x0f \x00")).toBe("link block table ");
    expect(plainCellText("a\x1cb\x1dc\x0ed\x7f")).toBe("abcd");
    expect(plainCellText("TiMtiMMIT\uf702\uf703\uf72b")).toBe("TiMtiMMIT");
    expect(plainCellText("\ue000\uf6ff\uf900")).toBe("\ue000\uf6ff\uf900");
    expect(plainCellText("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
    expect(plainCellText("Kaiming He 何恺明")).toBe("Kaiming He 何恺明");
  });

  it("cleans every string value of a cell record and leaves the rest alone", () => {
    const cells = { 0: { 0: { v: "x\x1e", t: 1 }, 1: { v: 2 }, 2: null }, 1: "not a row" };
    stripReservedControls(cells);
    expect(cells).toEqual({ 0: { 0: { v: "x", t: 1 }, 1: { v: 2 }, 2: null }, 1: "not a row" });
  });
});
