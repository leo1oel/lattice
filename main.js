// Motion belongs to the page's typography and construction lines, rather than
// a separate illustration. There is no animation loop running while idle.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let grainFrame = 0;
let divider;
const entrances = [];

function finishEntrance() {
  cancelAnimationFrame(grainFrame);
  document.documentElement.classList.remove('grain-entering');
  divider?.style.removeProperty('opacity');
  entrances.forEach(({ element, canvas, label, mark }) => {
    element.style.removeProperty('opacity');
    label?.style.removeProperty('opacity');
    mark?.style.removeProperty('opacity');
    mark?.querySelectorAll('path').forEach((path) => path.style.removeProperty('stroke-dashoffset'));
    canvas?.remove();
  });
  entrances.length = 0;
}

// The HTML link is a working DMG even without JS or when GitHub rate-limits us.
// Resolve the current release ahead of the click, never through a release page.
fetch('https://api.github.com/repos/leo1oel/lattice/releases/latest', {
  headers: { Accept: 'application/vnd.github+json' },
}).then(async (response) => {
  if (!response.ok) return;
  const release = await response.json();
  const installer = release.assets?.find((asset) =>
    /^Lattice_.+_aarch64\.dmg$/.test(asset.name) && asset.state === 'uploaded');
  if (installer?.browser_download_url?.startsWith('https://github.com/leo1oel/lattice/releases/download/')) {
    document.querySelector('.download').href = installer.browser_download_url;
  }
}).catch(() => {
  // Preserve the known-good direct download on network or malformed API errors.
});

document.addEventListener('pointermove', (event) => {
  document.documentElement.classList.toggle('has-mouse', event.pointerType === 'mouse');
});
function resetPointer() {
  document.documentElement.classList.remove('has-mouse');
}
document.documentElement.addEventListener('pointerleave', resetPointer);
document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') resetPointer();
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) {
    cancelAnimationFrame(grainFrame);
    finishEntrance();
    document.getAnimations().forEach((animation) => animation.finish());
    resetPointer();
  }
});

if (!reducedMotion.matches) {
  divider = document.querySelector('.divider');
  divider.style.opacity = '0';
  ['h1', '.description', '.actions'].forEach((selector, index) => {
    const element = document.querySelector(selector);
    element.style.opacity = '0';
    entrances.push({ element, delay: index === 0 ? 0 : 1000,
      label: index === 0 ? element.querySelector('.wordmark > span') : null,
      mark: index === 0 ? element.querySelector('.brand-mark') : null });
  });
  document.documentElement.classList.add('grain-entering');

  // Sample the actual laid-out glyphs, not an independently wrapped copy.
  // Each ink sample has a fixed destination and starts just below/around it.
  // The DOM remains selectable and takes over as the particles settle.
  Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]).then(() => {
    if (reducedMotion.matches || !document.documentElement.classList.contains('grain-entering')) return;
    try {
      entrances.forEach((entry) => {
        const { element } = entry;
        // Controls appear as one intact unit, with no particle treatment on text.
        if (element.matches('.actions')) return;
        const box = element.getBoundingClientRect();
        const padding = 32;
        const canvas = document.createElement('canvas');
        entry.canvas = canvas;
        canvas.className = 'entrance-particles';
        canvas.setAttribute('aria-hidden', 'true');
        const ratio = Math.min(devicePixelRatio || 1, 2);
        entry.ratio = ratio;
        // Align the backing store to device pixels, not fractional layout bounds.
        const left = Math.floor((box.left + scrollX - padding) * ratio) / ratio;
        const top = Math.floor((box.top + scrollY - padding) * ratio) / ratio;
        const width = Math.ceil(box.width + padding * 2);
        const height = Math.ceil(box.height + padding + 112);
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        canvas.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.scale(ratio, ratio);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.parentElement.closest('svg') || !node.textContent.trim()) continue;
          const style = getComputedStyle(node.parentElement);
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          context.fillStyle = style.color;
          // Read each glyph's laid-out position, including CSS spacing/wrapping.
          for (let i = 0; i < node.length; i++) {
            if (!node.textContent[i].trim()) continue;
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getBoundingClientRect();
            const metrics = context.measureText(node.textContent[i]);
            context.fillText(node.textContent[i], rect.left + scrollX - left,
              rect.top + scrollY - top + metrics.fontBoundingBoxAscent);
          }
        }
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        entry.particles = [];
        for (let py = 0; py < canvas.height; py += 1) {
          for (let px = 0; px < canvas.width; px += 1) {
            const offset = (py * canvas.width + px) * 4;
            if (pixels[offset + 3] === 0) continue;
            const x = px / ratio;
            const y = py / ratio;
            // Independent scatter and timing prevent a diagonal wave: using one
            // random value for all three makes one side rise before the other.
            const seed = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
            const verticalSeed = Math.sin(x * 269.5 + y * 183.3) * 43758.5453;
            const timingSeed = Math.sin(x * 419.2 + y * 371.9) * 43758.5453;
            const random = seed - Math.floor(seed);
            entry.particles.push({ x, y,
              dx: Math.max(1 - x, Math.min(width - x - 1, (random - .5) * 80)),
              dy: 26 + (verticalSeed - Math.floor(verticalSeed)) * 44,
              lag: (timingSeed - Math.floor(timingSeed)) * .18,
              alpha: pixels[offset + 3] / 255, shade: pixels[offset] });
          }
        }
        context.clearRect(0, 0, width, height);
        entry.context = context;
        // Both layers share an isolated transparent backdrop so plus-lighter
        // blends their coverage, rather than dimming overlapping glyphs.
        document.querySelector('main').append(canvas);
      });
    } catch {
      // Canvas/font support must never be a prerequisite for reading/downloads.
      finishEntrance();
      return;
    }
    let start;
    function reveal(time) {
      start ??= time;
      const elapsed = time - start;
      // Share the text clock, including its font wait. The rule follows the
      // fully resolved brand rather than starting while its particles gather.
      const ruleProgress = Math.max(0, Math.min((elapsed - 1200) / 500, 1));
      divider.style.opacity = String(ruleProgress * ruleProgress * (3 - 2 * ruleProgress));
      entrances.forEach(({ element, canvas, context, particles, delay, label, mark, ratio }) => {
        const progress = Math.max(0, Math.min((elapsed - delay) / 1200, 1));
        // Native and Canvas rasterizers can differ by a fraction of a pixel.
        // Blend into the fixed native glyphs while particles are still arriving,
        // not with a hard layer swap after the word is already fully formed.
        const ink = canvas ? Math.max(0, Math.min((progress - .7) / .3, 1)) : progress;
        element.style.opacity = String(ink * ink * (3 - 2 * ink));
        if (mark) {
          label.style.opacity = element.style.opacity;
          element.style.opacity = '1';
          mark.style.opacity = String(Math.min(progress * 4, 1));
          mark.querySelectorAll('path').forEach((path, index) => {
            const stroke = Math.max(0, Math.min((progress - index * .04) / .8, 1));
            path.style.strokeDashoffset = String(1 - stroke * stroke * (3 - 2 * stroke));
          });
        }
        if (!canvas) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (progress === 0 || progress === 1) return;
        particles.forEach(({ x, y, dx, dy, lag, alpha, shade }) => {
          const travel = Math.max(0, Math.min((progress - lag) / (1 - lag), 1));
          const remaining = 1 - travel * travel * (3 - 2 * travel);
          context.globalAlpha = alpha * Math.min(progress * 8, 1) * (1 - ink * ink * (3 - 2 * ink));
          context.fillStyle = `rgb(${shade} ${shade} ${shade})`;
          context.fillRect(x + dx * remaining, y + dy * remaining, 1 / ratio, 1 / ratio);
        });
      });
      if (elapsed < 2200) grainFrame = requestAnimationFrame(reveal);
      else finishEntrance();
    }
    grainFrame = requestAnimationFrame(reveal);
  });
  // A resize can change wrapping/targets; finish rather than fly to stale glyphs.
  window.addEventListener('resize', finishEntrance, { once: true });
}
