/** `value` held between `minimum` and `maximum`. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
