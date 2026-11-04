/** The public eight-column sprite layout, not a dependency on a desktop client. */
export type PetActivity = "idle" | "building" | "working" | "wave";

const ROWS: Record<PetActivity, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  building: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  working: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
  wave: { row: 3, durations: [140, 140, 140, 280] },
};

function spriteFrame(activity: PetActivity, elapsed: number, reduced: boolean): { column: number; row: number; remaining: number } {
  if (reduced) return { column: 0, row: 0, remaining: 0 };
  const { row, durations } = ROWS[activity];
  let time = Math.max(0, elapsed) % durations.reduce((sum, value) => sum + value, 0);
  for (let column = 0; column < durations.length; column++) {
    if (time < durations[column]) return { row, column, remaining: durations[column] - time };
    time -= durations[column];
  }
  return { row, column: 0, remaining: durations[0] };
}

export function paintSprite(element: HTMLElement, version: number, activity: PetActivity, elapsed: number, reduced: boolean) {
  const { column, row, remaining } = spriteFrame(activity, elapsed, reduced);
  const rows = version === 2 ? 11 : 9;
  element.style.backgroundSize = `800% ${rows * 100}%`;
  element.style.backgroundPosition = `${column * 100 / 7}% ${row * 100 / (rows - 1)}%`;
  return remaining;
}
