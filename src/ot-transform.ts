/**
 * Operational transformation for Overleaf's text operations.
 *
 * When two people edit the same document at once, each side's operation was
 * written against a document the other has already changed. Transformation is
 * what rewrites one operation so it still means the same thing after the
 * other's edit landed — and it is the difference between two people typing in
 * one paragraph and two people corrupting it.
 *
 * The semantics here match ShareJS's `text` type, which is what Overleaf's
 * server applies, so an op transformed here lands exactly where the server
 * expects it. The property that matters is convergence: applying a then the
 * transformed b must give the same document as applying b then the transformed
 * a. `ot-transform.test.ts` checks that on thousands of random operations.
 */
import type { OtOp } from "./ot-ops";

/** Insert `text` into `source` at `position`. */
function inject(source: string, position: number, text: string): string {
  return source.slice(0, position) + text + source.slice(position);
}

/**
 * Add a component, merging it into the previous one when they are adjacent.
 *
 * Merging keeps operations compact, and more importantly keeps them in the
 * canonical shape the server produces, so a round trip does not reshuffle a
 * document's history.
 */
function append(op: OtOp[], component: OtOp): void {
  if (component.i === "" || component.d === "") return;
  const last = op[op.length - 1];
  if (!last) {
    op.push(component);
    return;
  }
  if (
    last.i != null && component.i != null
    && last.p <= component.p && component.p <= last.p + last.i.length
  ) {
    op[op.length - 1] = { p: last.p, i: inject(last.i, component.p - last.p, component.i) };
    return;
  }
  if (
    last.d != null && component.d != null
    && component.p <= last.p && last.p <= component.p + component.d.length
  ) {
    op[op.length - 1] = { p: component.p, d: inject(component.d, last.p - component.p, last.d) };
    return;
  }
  op.push(component);
}

/**
 * Where a position ends up after `component` is applied.
 *
 * `insertAfter` breaks the tie when an insert lands exactly on the position:
 * the two sides must disagree consistently, or concurrent inserts at the same
 * spot would be ordered differently on each machine and never converge.
 */
function transformPosition(position: number, component: OtOp, insertAfter: boolean): number {
  if (component.i != null) {
    if (component.p < position || (component.p === position && insertAfter)) {
      return position + component.i.length;
    }
    return position;
  }
  const deleted = component.d ?? "";
  if (position <= component.p) return position;
  if (position <= component.p + deleted.length) return component.p;
  return position - deleted.length;
}

/** Transform one component against one other, appending the result. */
function transformComponent(
  destination: OtOp[],
  component: OtOp,
  other: OtOp,
  side: "left" | "right",
): void {
  if (component.i != null) {
    append(destination, {
      p: transformPosition(component.p, other, side === "right"),
      i: component.i,
    });
    return;
  }

  const deleted = component.d ?? "";
  if (other.i != null) {
    // Our delete spans text the other side just split with an insert, so it
    // becomes two deletes — one each side of the inserted text, which is left
    // untouched because we never meant to remove it.
    let rest = deleted;
    if (component.p < other.p) {
      const head = rest.slice(0, other.p - component.p);
      append(destination, { p: component.p, d: head });
      rest = rest.slice(other.p - component.p);
    }
    if (rest !== "") {
      append(destination, { p: component.p + other.i.length, d: rest });
    }
    return;
  }

  const otherDeleted = other.d ?? "";
  if (component.p >= other.p + otherDeleted.length) {
    // Entirely after their delete: shift back by what they removed.
    append(destination, { p: component.p - otherDeleted.length, d: deleted });
    return;
  }
  if (component.p + deleted.length <= other.p) {
    // Entirely before their delete: unaffected.
    append(destination, component);
    return;
  }

  // The two deletes overlap. Whatever they already removed is gone, so only
  // the parts outside their range remain for us to delete.
  let remaining = "";
  if (component.p < other.p) {
    remaining = deleted.slice(0, other.p - component.p);
  }
  if (component.p + deleted.length > other.p + otherDeleted.length) {
    remaining += deleted.slice(other.p + otherDeleted.length - component.p);
  }
  if (remaining !== "") {
    append(destination, { p: transformPosition(component.p, other, false), d: remaining });
  }
}

/**
 * Rewrite `op` so it applies to a document that `other` has already changed.
 *
 * `side` must differ between the two peers ("left" for one, "right" for the
 * other) so concurrent inserts at the same position are ordered the same way
 * everywhere. Overleaf's server is authoritative, so a client transforms its
 * own pending work as "left" against updates arriving from the server.
 */
export function transformOps(op: OtOp[], other: OtOp[], side: "left" | "right"): OtOp[] {
  return side === "left" ? transformPair(op, other)[0] : transformPair(other, op)[1];
}

/**
 * Transform both operations against each other at once, returning each
 * rewritten to apply after the other.
 *
 * Doing both together is what makes multi-component operations correct: as
 * each of the left op's components is transformed, the right component has to
 * be carried forward transformed too, or every position after the first one is
 * measured against a document that no longer exists. A component can also
 * split in two (a delete straddling an insert), and then the remainder of the
 * work has to be transformed against both halves — hence the recursion.
 */
function transformPair(left: OtOp[], right: OtOp[]): [OtOp[], OtOp[]] {
  let leftOp = left;
  const newRightOp: OtOp[] = [];
  for (const original of right) {
    let rightComponent: OtOp | null = original;
    const newLeftOp: OtOp[] = [];
    let index = 0;
    while (index < leftOp.length) {
      const split: OtOp[] = [];
      transformComponent(newLeftOp, leftOp[index], rightComponent, "left");
      transformComponent(split, rightComponent, leftOp[index], "right");
      index += 1;
      if (split.length === 1) {
        rightComponent = split[0];
        continue;
      }
      if (split.length === 0) {
        // The right component vanished (fully deleted by the left op), so the
        // rest of the left op is unaffected by it.
        for (let rest = index; rest < leftOp.length; rest += 1) {
          append(newLeftOp, leftOp[rest]);
        }
        rightComponent = null;
        break;
      }
      const [restLeft, restRight] = transformPair(leftOp.slice(index), split);
      for (const item of restLeft) append(newLeftOp, item);
      for (const item of restRight) append(newRightOp, item);
      rightComponent = null;
      break;
    }
    if (rightComponent != null) append(newRightOp, rightComponent);
    leftOp = newLeftOp;
  }
  return [leftOp, newRightOp];
}

/** Combine two operations that apply one after the other into a single one. */
export function composeOps(first: OtOp[], second: OtOp[]): OtOp[] {
  const result = first.slice();
  for (const component of second) append(result, component);
  return result;
}
