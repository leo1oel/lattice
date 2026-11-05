/** Self time per function, heaviest first, from a CDP CPU profile. */
export function profileSummary(profile, top = 25) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const interval = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index];
    interval.set(id, (interval.get(id) ?? 0) + (profile.timeDeltas[index + 1] ?? 0));
  }
  for (const [id, micros] of interval) {
    const { callFrame } = byId.get(id);
    const where = callFrame.url ? `${callFrame.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\?.*$/, "")}:${callFrame.lineNumber + 1}` : "";
    const key = `${callFrame.functionName || "(anonymous)"} ${where}`.trim();
    self.set(key, (self.get(key) ?? 0) + micros / 1000);
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${name}`);
}
