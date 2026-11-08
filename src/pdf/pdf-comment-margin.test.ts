import { describe, expect, it } from "vitest";
import { layoutMarginCards } from "./pdf-comment-margin";

const tops = (map: Map<string, number>) => Object.fromEntries(map);

describe("the PDF's comment column", () => {
  it("stands each card level with its mark when they have room", () => {
    expect(tops(layoutMarginCards([
      { id: "b", anchor: 400, height: 60 },
      { id: "a", anchor: 120, height: 80 },
    ]))).toEqual({ a: 120, b: 400 });
  });

  it("moves a card down just clear of the one above it, in the marks' order down the pages", () => {
    expect(tops(layoutMarginCards([
      { id: "a", anchor: 100, height: 80 },
      { id: "b", anchor: 120, height: 40 },
      { id: "c", anchor: 130, height: 40 },
      { id: "d", anchor: 600, height: 40 },
    ], null, 8))).toEqual({ a: 100, b: 188, c: 236, d: 600 });
  });

  it("keeps the open card level with its mark, moving the cards before it up and after it down", () => {
    expect(tops(layoutMarginCards([
      { id: "a", anchor: 100, height: 80 },
      { id: "b", anchor: 120, height: 40 },
      { id: "c", anchor: 130, height: 40 },
    ], "b", 8))).toEqual({ a: 32, b: 120, c: 168 });
  });

  it("leaves the cards before the open one where they stand when it is far below them", () => {
    const cards = [
      { id: "a", anchor: 100, height: 80 },
      { id: "b", anchor: 110, height: 40 },
      { id: "c", anchor: 500, height: 40 },
    ];
    expect(tops(layoutMarginCards(cards, null, 8))).toEqual({ a: 100, b: 188, c: 500 });
    expect(tops(layoutMarginCards(cards, "c", 8))).toEqual({ a: 100, b: 188, c: 500 });
  });

  it("lays out from the top as usual when the open card is the first", () => {
    expect(tops(layoutMarginCards([
      { id: "a", anchor: 100, height: 80 },
      { id: "b", anchor: 120, height: 40 },
    ], "a", 8))).toEqual({ a: 100, b: 188 });
  });

  it("keeps two marks at one height in the order they were given", () => {
    expect(tops(layoutMarginCards([
      { id: "second", anchor: 50, height: 20 },
      { id: "first", anchor: 50, height: 20 },
    ], null, 4))).toEqual({ second: 50, first: 74 });
  });
});
