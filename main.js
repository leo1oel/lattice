const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let grainFrame = 0;
let divider;
const entrances = [];
let formatTimer;
let formatIndex = 0;
let formatReady = reducedMotion.matches;
let formatGeneration = 0;
const formatAnimations = [];
const formats = ['LaTeX', 'Markdown', 'PowerPoint', 'Canvas', 'Sheet'];
let wheelDelta = 0;
let lastWheelTime = 0;

// Resolve the current installer ahead of the click, never via a release page.
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

function finishEntrance() {
  cancelAnimationFrame(grainFrame);
  document.documentElement.classList.remove('grain-entering');
  divider?.style.removeProperty('opacity');
  entrances.forEach(({ element, displacement, offset, mark }) => {
    element.style.removeProperty('opacity');
    displacement?.setAttribute('scale', '0');
    offset?.setAttribute('dy', '0');
    mark?.style.removeProperty('opacity');
    mark?.querySelectorAll('path').forEach((path) => path.style.removeProperty('stroke-dashoffset'));
  });
  // Keep identity filters on the native glyphs. Removing the rendering layer
  // would reintroduce the rasterization handover this effect deliberately avoids.
  entrances.length = 0;
  formatReady = true;
  scheduleFormat();
}

function stopFormat() {
  clearTimeout(formatTimer);
  formatGeneration++;
  formatAnimations.splice(0).forEach((animation) => animation.cancel());
}

function scheduleFormat() {
  clearTimeout(formatTimer);
  if (!formatReady || reducedMotion.matches || document.hidden) return;
  formatTimer = setTimeout(rotateFormat, 2500);
}

function wheelPose(slot) {
  return {
    opacity: slot === 0 ? 1 : Math.abs(slot) === 1 ? .22 : 0,
    transform: `perspective(220px) translateY(${slot * 1.05}em) rotateX(${-slot * 32}deg)`,
  };
}

async function rotateFormat(direction = 1, manual = false) {
  if (!formatReady || (reducedMotion.matches && !manual) || document.hidden || formatAnimations.length) return;
  clearTimeout(formatTimer);
  const generation = ++formatGeneration;
  const labels = [...document.querySelectorAll('.format-label')];
  try {
    if (!reducedMotion.matches) labels.forEach((label) => {
      const slot = Number(label.dataset.slot);
      formatAnimations.push(label.animate([wheelPose(slot), wheelPose(slot - direction)], {
        duration: 800, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards',
      }));
    });
    await Promise.all(formatAnimations.map((animation) => animation.finished));
    if (generation !== formatGeneration) return;
    formatIndex = (formatIndex + direction + formats.length) % formats.length;
    // Recycle only the invisible back row. Visible rows retain their exact
    // end poses when the animation effects are removed.
    labels.forEach((label, index) => {
      label.dataset.slot = String((index - formatIndex + formats.length + 2) % formats.length - 2);
    });
  } catch {
    // Hidden tabs and reduced-motion changes cancel rather than finish mid-cycle.
  } finally {
    if (generation === formatGeneration) {
      formatAnimations.splice(0).forEach((animation) => animation.cancel());
      scheduleFormat();
    }
  }
}

// Accumulate trackpad micro-deltas, but never queue momentum behind an active
// step. Passive handling leaves normal page scrolling and pinch zoom intact.
document.addEventListener('wheel', (event) => {
  if (!event.target.closest?.('.format-wheel') || event.ctrlKey ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY || !formatReady) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
  if (event.timeStamp - lastWheelTime > 180 || Math.sign(delta) !== Math.sign(wheelDelta)) wheelDelta = 0;
  lastWheelTime = event.timeStamp;
  if (formatAnimations.length) { wheelDelta = 0; return; }
  wheelDelta += delta;
  if (Math.abs(wheelDelta) < 30) return;
  wheelDelta = 0;
  return rotateFormat(Math.sign(delta), true);
}, { passive: true });

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
document.addEventListener('visibilitychange', () => {
  stopFormat();
  scheduleFormat();
});
reducedMotion.addEventListener('change', () => {
  stopFormat();
  if (reducedMotion.matches) {
    finishEntrance();
    document.getAnimations().forEach((animation) => animation.finish());
    resetPointer();
  } else scheduleFormat();
});

if (!reducedMotion.matches) {
  divider = document.querySelector('.divider');
  divider.style.opacity = '0';
  const template = document.querySelector('#gather-template');
  ['.wordmark > span', '.description', '.actions'].forEach((selector, index) => {
    const element = document.querySelector(selector);
    const entry = { element, delay: index === 0 ? 0 : 1000,
      mark: index === 0 ? document.querySelector('.brand-mark') : null };
    element.style.opacity = '0';
    if (entry.mark) entry.mark.style.opacity = '0';
    if (index !== 2) {
      const filter = template.cloneNode(true);
      filter.id = `gather-${index}`;
      template.parentNode.append(filter);
      element.style.filter = `url('#${filter.id}')`;
      entry.displacement = filter.querySelector('feDisplacementMap');
      entry.offset = filter.querySelector('feOffset');
    }
    entrances.push(entry);
  });
  document.documentElement.classList.add('grain-entering');
  // Start only after font loading settles, so a late font swap cannot move
  // the glyphs halfway through their entrance.
  document.fonts.ready.then(() => {
    if (reducedMotion.matches || !document.documentElement.classList.contains('grain-entering')) return;
    let start;
    function reveal(time) {
      start ??= time;
      const elapsed = time - start;
      const rule = Math.max(0, Math.min((elapsed - 1200) / 500, 1));
      divider.style.opacity = String(rule * rule * (3 - 2 * rule));
      entrances.forEach(({ element, displacement, offset, delay, mark }) => {
        const progress = Math.max(0, Math.min((elapsed - delay) / 1200, 1));
        const eased = progress * progress * (3 - 2 * progress);
        element.style.opacity = String(displacement ? Math.min(progress * 6, 1) : eased);
        // Distort the real DOM glyphs, then converge to an identity transform.
        // There is no Canvas duplicate, opacity crossfade, or layer replacement.
        const remaining = (1 - progress) ** 3;
        displacement?.setAttribute('scale', String(80 * remaining));
        offset?.setAttribute('dy', String(48 * (1 - progress) ** 4));
        if (mark) {
          mark.style.opacity = String(Math.min(progress * 4, 1));
          mark.querySelectorAll('path').forEach((path, index) => {
            const stroke = Math.max(0, Math.min((progress - index * .04) / .8, 1));
            path.style.strokeDashoffset = String(1 - stroke * stroke * (3 - 2 * stroke));
          });
        }
      });
      if (elapsed < 2200) grainFrame = requestAnimationFrame(reveal);
      else finishEntrance();
    }
    grainFrame = requestAnimationFrame(reveal);
  });
  window.addEventListener('resize', () => {
    stopFormat();
    finishEntrance();
  });
}
