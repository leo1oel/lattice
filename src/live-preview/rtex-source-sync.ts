// Adapted from realtime-tex-vsc-plugin (https://github.com/HenryXiaoYang/realtime-tex-vsc-plugin),
// src/edits.ts, MIT License, Copyright (c) 2026 Henry Yang; see THIRD_PARTY_NOTICES.md.
//
// Keeping rtex's copy of each project file in step with Lattice's: text changes
// (UTF-16 offsets) become rtex edits (UTF-8 byte offsets). Lattice hands over
// whole texts, not the editor's change list, so `SourceSync` finds the changed
// range itself. Pure module.
import type { Command } from "./rtex-protocol";

/** One text change: `rangeLength` UTF-16 units at `rangeOffset` replaced by `text`. */
export interface TextChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** An edit in rtex terms: replace bytes [start, end) with `text`. */
export interface ByteEdit {
  start: number;
  end: number;
  text: string;
}

const BLOCK = 4096;

/** UTF-8 length of `s[from, to)` counted per UTF-16 unit (a surrogate unit counts 2 bytes, so a
 * pair counts 4 and the count is additive across any split point). */
export function utf8Length(s: string, from = 0, to = s.length): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) n += 2;
    else n += 3;
  }
  return n;
}

/**
 * A copy of a document's text with cached UTF-16 → UTF-8 offset checkpoints.
 *
 * Checkpoint k holds the byte offset of UTF-16 offset k·BLOCK. An edit only invalidates the
 * checkpoints after it, and typing happens in one place, so each keystroke costs O(BLOCK).
 */
export class ShadowText {
  private cps: number[] = [0];

  constructor(private textValue: string) {}

  get text(): string {
    return this.textValue;
  }

  get length(): number {
    return this.textValue.length;
  }

  reset(text: string): void {
    this.textValue = text;
    this.cps = [0];
  }

  /** Byte offset of UTF-16 offset `off`. */
  byteOffset(off: number): number {
    off = Math.max(0, Math.min(off, this.textValue.length));
    const k = Math.floor(off / BLOCK);
    this.ensure(k);
    const base = Math.min(k, this.cps.length - 1);
    return this.cps[base] + utf8Length(this.textValue, base * BLOCK, off);
  }

  /** UTF-16 offset of byte offset `b` (clamped to a character boundary at or before `b`). */
  utf16Offset(b: number): number {
    if (b <= 0) return 0;
    const lastK = Math.floor(this.textValue.length / BLOCK);
    this.ensure(lastK);
    // binary search the last checkpoint with byte offset <= b
    let lo = 0;
    let hi = this.cps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cps[mid] <= b) lo = mid;
      else hi = mid - 1;
    }
    let off = lo * BLOCK;
    let bytes = this.cps[lo];
    const s = this.textValue;
    while (off < s.length) {
      const c = s.charCodeAt(off);
      let w: number;
      let units = 1;
      if (c < 0x80) w = 1;
      else if (c < 0x800) w = 2;
      else if (c >= 0xd800 && c <= 0xdbff && off + 1 < s.length) {
        w = 4;
        units = 2;
      } else if (c >= 0xd800 && c <= 0xdfff) w = 2; // half of a pair split by a checkpoint
      else w = 3;
      if (bytes + w > b) break;
      bytes += w;
      off += units;
    }
    return off;
  }

  /** Apply changes in order (VS Code applies an event's changes sequentially) and return the
   * equivalent byte edits, each relative to the text left by the previous one. */
  apply(changes: readonly TextChange[]): ByteEdit[] {
    const out: ByteEdit[] = [];
    for (const ch of changes) {
      const start = this.byteOffset(ch.rangeOffset);
      const end = start + utf8Length(this.textValue, ch.rangeOffset, ch.rangeOffset + ch.rangeLength);
      out.push({ start, end, text: ch.text });
      this.textValue =
        this.textValue.slice(0, ch.rangeOffset) + ch.text + this.textValue.slice(ch.rangeOffset + ch.rangeLength);
      // checkpoints at or before the change start stay valid
      const keep = Math.floor(ch.rangeOffset / BLOCK) + 1;
      if (this.cps.length > keep) this.cps.length = keep;
    }
    return out;
  }

  private ensure(k: number): void {
    const s = this.textValue;
    const maxK = Math.floor(s.length / BLOCK);
    k = Math.min(k, maxK);
    while (this.cps.length <= k) {
      const j = this.cps.length;
      this.cps.push(this.cps[j - 1] + utf8Length(s, (j - 1) * BLOCK, j * BLOCK));
    }
  }
}

/**
 * The one change that turns `before` into `after`: their common start and end
 * set aside, never splitting a surrogate pair. Typing changes one place, so
 * this is the keystroke itself; a paste or an external rewrite is one wider
 * change.
 */
export function textChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // keep a pair whole: back off from between its halves
  if (start > 0 && isLowSurrogate(before.charCodeAt(start)) && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(before.charCodeAt(before.length - end)) && isHighSurrogate(before.charCodeAt(before.length - end - 1))) end--;
  return { rangeOffset: start, rangeLength: before.length - end - start, text: after.slice(start, after.length - end) };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * rtex's copy of each file it has been sent, as commands that bring it to a
 * new text. A file rtex loaded itself is known by its text on disk, which
 * the caller supplies the first time it names the file.
 */
export class SourceSync {
  private readonly shadows = new Map<string, ShadowText>();

  /** Whether rtex's copy of `path` is known. */
  knows(path: string): boolean {
    return this.shadows.has(path);
  }

  /** The commands that make rtex's `path` read `text`; `base` is its text when not yet known. */
  update(path: string, text: string, base: string): Command[] {
    let shadow = this.shadows.get(path);
    if (!shadow) {
      shadow = new ShadowText(base);
      this.shadows.set(path, shadow);
    }
    const change = textChange(shadow.text, text);
    if (!change) return [];
    // A rewrite of most of the file is cheaper to send whole than to diff in rtex.
    if (change.rangeLength > 4096 && change.rangeLength > shadow.length / 2) {
      shadow.reset(text);
      return [{ cmd: "set_document", path, text }];
    }
    return shadow.apply([change]).map((edit) => ({ cmd: "edit", path, start: edit.start, end: edit.end, text: edit.text }));
  }

  /** Record what rtex read of `path` from disk, unless its copy is already known. */
  seed(path: string, text: string): void {
    if (!this.shadows.has(path)) this.shadows.set(path, new ShadowText(text));
  }

  /** The command that replaces rtex's `path` with `text`, unless it already reads that. */
  replace(path: string, text: string): Command | null {
    const shadow = this.shadows.get(path);
    if (shadow?.text === text) return null;
    if (shadow) shadow.reset(text);
    else this.shadows.set(path, new ShadowText(text));
    return { cmd: "set_document", path, text };
  }
}
