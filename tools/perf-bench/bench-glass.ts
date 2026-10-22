/**
 * A browser has no vibrancy, so under `?glass=` the bench paints a stand-in
 * desktop behind the page: colour that shows through wherever the window is
 * translucent, as the real desktop would.
 */
export function paintStandInDesktop() {
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `
    .bench-desktop { position: fixed; inset: 0; z-index: -1; overflow: hidden; }
    .bench-desktop::before { content: ""; position: absolute; inset: -120px; filter: blur(56px) saturate(1.5);
      background: radial-gradient(40% 50% at 18% 30%, #ff7a59, transparent), radial-gradient(45% 55% at 70% 20%, #6d5dfc, transparent),
        radial-gradient(50% 50% at 80% 85%, #00b3a4, transparent), radial-gradient(40% 40% at 25% 85%, #ffc94d, transparent), #3b4b7a; }
    .bench-desktop::after { content: ""; position: absolute; inset: 0; background: rgb(244 244 246 / 0.64); }
    :root[data-theme="dark"] .bench-desktop::after { background: rgb(30 30 32 / 0.68); }`;
  document.body.prepend(Object.assign(document.createElement("div"), { className: "bench-desktop" }));
}
