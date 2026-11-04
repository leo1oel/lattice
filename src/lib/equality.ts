/** Whether two arrays hold the same items in the same order, each compared with `===`. */
export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Whether two plain JSON values serialize the same: key order counts, as it does on disk. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether two names are the same once case is set aside (`left` may be missing). */
export function sameIgnoringCase(left: string | undefined, right: string): boolean {
  return left?.toLocaleLowerCase() === right.toLocaleLowerCase();
}
