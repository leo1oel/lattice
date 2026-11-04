// Small responses to what a reader does. Each works with reduced motion too.
//   - main.tex in the hero: edit the title, and the headline is set from it as you type.
//   - Cards: open larger on click, Enter or Space; a chapter's points lift the cards they name.
//   - Collaborate: once, a co-author's caret types one of its points, as Overleaf presence does.
//   - ⌘S (Save and build, as in Lattice) or Return in the title: the Build button builds.
//   - Chips and the progress bars: go to the chapter, which arrives again.
//   - Chapter titles: link to themselves; a click copies the link.
//   - Download buttons: confirm the download.
//   - Blank paper: a click lets one soft drop of the chapter's ink spread under it and fade
//     (not with reduced motion).

const root = document.documentElement;
let reduced = { matches: false };
let build = () => {};

export function setupInteractions({ reducedMotion }) {
  reduced = reducedMotion;
  setupCards();
  setupPoints();
  setupPeer();
  build = setupBuild();
  setupChapterLinks();
  setupDownloads();
  setupInk();
}

/* ── main.tex: the title is yours to edit ────────────────────────────────────────────────── */
const ORIGINAL = 'your research';
let titleReady = false;
export function enableTitleEdit() {
  if (titleReady) return;
  titleReady = true;
  const source = document.querySelector('[data-source]');
  const pre = source.querySelector('[data-type-source]');
  const line2 = document.querySelector('[data-line2]');
  const caret = document.querySelector('.headline .caret');
  pre.removeAttribute('aria-hidden');
  pre.innerHTML = '<span aria-hidden="true"><span class="n">12</span><span class="cmd">\\title</span>{A workspace for\n<span class="n">13</span>       </span>'
    + '<input class="title-input" type="text" maxlength="18" spellcheck="false" autocomplete="off" aria-label="Edit the end of the headline">'
    + '<span aria-hidden="true">}</span>';
  const input = pre.querySelector('input');
  input.value = ORIGINAL;
  // The input is exactly as wide as its text plus room for the caret, measured in its own font,
  // so the closing brace sits right after the last letter, as in an editor, at any length.
  const measure = document.createElement('canvas').getContext('2d');
  const fit = () => {
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    input.style.width = `${Math.ceil(measure.measureText(input.value || ' ').width) + 2}px`;
  };
  // Sets the headline's second line from the text, each word revealed, all in the headline's roman.
  const set = (text) => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    line2.replaceChildren(...words.flatMap((word, i) => {
      const el = document.createElement('span');
      el.className = 'w on';
      el.textContent = word;
      return i ? [document.createTextNode(' '), el] : [el];
    }));
    if (caret) line2.append(caret);
  };
  input.addEventListener('input', () => { fit(); set(input.value); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { input.value = ORIGINAL; fit(); set(ORIGINAL); input.blur(); }
    if (event.key === 'Enter') { input.blur(); build(); }
  });
  input.addEventListener('blur', () => { if (!input.value.trim()) { input.value = ORIGINAL; fit(); set(ORIGINAL); } });
  // A click anywhere on the card puts the cursor at the end of the title.
  source.addEventListener('pointerdown', (event) => {
    if (event.target === input) return;
    event.preventDefault();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  fit();
  source.classList.add('editable');
}

/* ── Cards: open larger ───────────────────────────────────────────────────────────────────── */
function setupCards() {
  const dialog = document.querySelector('[data-lightbox]');
  const figure = dialog.querySelector('figure');
  const holder = dialog.querySelector('[data-lb-shot]');
  const caption = dialog.querySelector('[data-lb-caption]');
  let from = null;

  const labelOf = (card) => card.querySelector('[role="img"]')?.getAttribute('aria-label') ?? card.querySelector('img')?.alt ?? '';
  const flip = (rect) => {
    const last = figure.getBoundingClientRect();
    return `translate(${rect.left - last.left}px, ${rect.top - last.top}px) scale(${rect.width / last.width})`;
  };
  const open = (card) => {
    const media = card.querySelector('.shot video, .shot img');
    let clone;
    if (media.tagName === 'VIDEO') {
      clone = Object.assign(document.createElement('video'), { muted: true, playsInline: true, loop: true, autoplay: !reduced.matches, controls: reduced.matches, poster: media.poster, src: media.dataset.src ?? media.currentSrc });
    } else clone = Object.assign(document.createElement('img'), { src: media.currentSrc || media.src, alt: '' });
    figure.style.setProperty('--ar', String(media.width / media.height));
    holder.replaceChildren(clone);
    caption.textContent = labelOf(card);
    from = card;
    dialog.showModal();
    if (!reduced.matches) {
      figure.animate([{ transform: flip(card.querySelector('.shot').getBoundingClientRect()) }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    }
  };
  const close = () => {
    if (!dialog.open) return;
    const done = () => { dialog.close(); holder.replaceChildren(); };
    if (reduced.matches || !from) { done(); return; }
    const back = figure.animate([{ transform: 'none' }, { transform: flip(from.querySelector('.shot').getBoundingClientRect()) }], { duration: 380, easing: 'cubic-bezier(.65, 0, .35, 1)' });
    dialog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-in', fill: 'forwards' }).onfinish = (event) => event.target.cancel();
    back.onfinish = done;
  };
  dialog.querySelector('[data-lb-close]').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });

  for (const card of document.querySelectorAll('.card')) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open larger: ${labelOf(card)}`);
    card.addEventListener('click', () => open(card));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(card); }
    });

  }
}

/* ── A section arrives in reading order ───────────────────────────────────────────────────── */
// What style.css hides until its section is in. Each gets its delay (--d) from where it sits:
// top to bottom, and left to right along a row, one short step apart, so at any width nothing
// arrives before what is above it.
const ARRIVALS = '.progress, .ch-title span, .caption, .points, .byo-title, .body, .film-title, .player, .formats-title, .card, .credit, .more-title, .index-cards li, .faq-title, .faq-more, .qa details, .source-end, .download-title, .download-go';
export function arrive(section) {
  const items = [...section.querySelectorAll(ARRIVALS)]
    .map((el) => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ box }) => box.width && box.height)
    .sort((a, b) => a.box.top - b.box.top);
  // Items whose tops are within 12 px of a row's first share its row.
  const rows = [];
  for (const item of items) {
    const row = rows.at(-1);
    if (row && item.box.top - row[0].box.top < 12) row.push(item);
    else rows.push([item]);
  }
  let delay = 0;
  rows.forEach((row, r) => {
    if (r) delay += 60;
    row.sort((a, b) => a.box.left - b.box.left).forEach(({ el }, i) => {
      if (i) delay += 30;
      el.style.setProperty('--d', `${Math.min(delay, 600)}ms`);
    });
  });
  section.classList.add('in');
}

/* ── A short note at the foot of the screen ───────────────────────────────────────────────── */
function toast(text) {
  const el = document.querySelector('[data-toast]');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(el.timer);
  el.timer = setTimeout(() => el.classList.remove('on'), 1800);
}

function arriveAgain(section) {
  if (!root.classList.contains('motion') || !section.classList.contains('stage')) return;
  const replay = () => {
    section.querySelectorAll('.card, .index-cards li').forEach((el) => el.classList.remove('settled'));
    section.classList.remove('in');
    void section.offsetWidth;
    arrive(section);
    section.querySelectorAll('.card video[src]').forEach((video) => { video.currentTime = 0; });
    setTimeout(() => section.querySelectorAll('.card').forEach((el) => el.classList.add('settled')), 1600);
  };
  // After the scroll has landed (scrollend where there is one).
  let fired = false;
  const once = () => { if (!fired) { fired = true; replay(); } };
  addEventListener('scrollend', once, { once: true });
  setTimeout(once, 900);
}
function setupChapterLinks() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('.chips a, .progress a, [data-anchor]');
    if (!link) return;
    const section = document.querySelector(link.getAttribute('href'));
    if (!section) return;
    if (link.matches('[data-anchor]')) {
      const url = `${location.origin}${location.pathname}${link.getAttribute('href')}`;
      navigator.clipboard?.writeText(url).then(() => toast(`Link to ${link.textContent.trim()} copied`), () => {});
      return;
    }
    arriveAgain(section);
  });
}

/* ── A chapter's points and its cards ───────────────────────────────────────────────────────── */
// Each point names what one or more of the chapter's cards show (data-cards: their places in the
// collage). Pointing at a point, or focusing it, lifts those cards; pointing at a card marks its
// points; pressing a point opens its first card larger.
function setupPoints() {
  for (const list of document.querySelectorAll('.points')) {
    const cards = [...list.closest('section').querySelectorAll('.collage .card')];
    for (const point of list.querySelectorAll('button[data-cards]')) {
      const mine = point.dataset.cards.split(' ').map((at) => cards[Number(at)]).filter(Boolean);
      const lift = (on) => mine.forEach((card) => card.classList.toggle('lift', on));
      point.setAttribute('aria-haspopup', 'dialog');
      point.addEventListener('pointerenter', () => lift(true));
      point.addEventListener('pointerleave', () => lift(false));
      point.addEventListener('focus', () => lift(true));
      point.addEventListener('blur', () => lift(false));
      point.addEventListener('click', () => { lift(false); mine[0]?.click(); });
      for (const card of mine) {
        card.addEventListener('pointerenter', () => point.classList.add('on'));
        card.addEventListener('pointerleave', () => point.classList.remove('on'));
      }
    }
  }
}

/* ── Collaborate: a co-author types one of the points ────────────────────────────────────── */
// The first time the point is in view, with motion: its text is laid out but unwritten, and the
// co-author's caret (their colour, a dot, their name, as Lattice shows Overleaf presence) writes it
// at a typing pace, rests a moment and goes. The whole text stays in the page for reading and
// for assistive tech; reduced motion, or no script, shows it as it is.
function setupPeer() {
  const point = document.querySelector('[data-peer]');
  if (!point || reduced.matches) return;
  const text = point.textContent;
  point.setAttribute('aria-label', text);
  const written = document.createElement('span');
  const unwritten = Object.assign(document.createElement('span'), { className: 'unwritten', textContent: text });
  const caret = Object.assign(document.createElement('span'), { className: 'peer' });
  caret.setAttribute('aria-hidden', 'true');
  caret.append(Object.assign(document.createElement('i'), { textContent: point.dataset.peer }));
  point.replaceChildren(written, caret, unwritten);
  const finish = () => point.replaceChildren(text);
  const io = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    io.disconnect();
    let count = 0;
    const step = () => {
      if (reduced.matches) { finish(); return; }
      count += 1;
      written.textContent = text.slice(0, count);
      unwritten.textContent = text.slice(count);
      if (count < text.length) { setTimeout(step, (text[count - 1] === ' ' ? 140 : 55) + Math.random() * 50); return; }
      setTimeout(() => { caret.classList.add('gone'); setTimeout(finish, 450); }, 1400);
    };
    // After the points have come in.
    setTimeout(step, 1100);
  }, { threshold: 1 });
  io.observe(point);
}

/* ── ⌘S builds, as in Lattice ─────────────────────────────────────────────────────────────── */
// Lattice's Save and build is ⌘S. On the page it brings up the Build button as the app draws it:
// the play icon and Build, the loader for the 1.2 s the tutorial takes to build, then the check
// and the time. Return in main.tex's title does the same. Reduced motion shows the result.
function setupBuild() {
  let pill = null;
  let timers = [];
  const make = () => {
    pill = document.createElement('div');
    pill.className = 'build-pill';
    pill.setAttribute('role', 'status');
    // Two faces in one cell, each centred: play or the loader with "Build", then the check and the time.
    pill.innerHTML = '<span class="bp-face bp-go" aria-hidden="true"><span class="bp-icon">'
      + '<svg class="bp-play" viewBox="0 0 24 24"><path d="M6 3 20 12 6 21z"/></svg>'
      + '<svg class="bp-load" viewBox="0 0 100 100"><path transform="translate(10 10) scale(.8)" d="M24.3 30C11.4 30 5 43.3 5 50s6.4 20 19.3 20c19.3 0 32.1-40 51.4-40C88.6 30 95 43.3 95 50s-6.4 20-19.3 20C56.4 70 43.6 30 24.3 30z"/></svg>'
      + '</span>Build</span>'
      + '<span class="bp-face bp-done" aria-hidden="true"><span class="bp-icon"><svg class="bp-check" viewBox="0 0 24 24"><path pathLength="1" d="M20 6 9 17l-5-5"/></svg></span>1.2 s</span>'
      + '<span class="sr"></span>';
    document.body.append(pill);
    return pill;
  };
  const state = (name, said) => { pill.dataset.state = name; pill.querySelector('.sr').textContent = said; };
  const run = () => {
    if (!pill) make();
    timers.forEach(clearTimeout);
    timers = [];
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    if (reduced.matches) {
      state('done', 'Built in 1.2 seconds');
      pill.classList.add('on');
      later(2600, () => pill.classList.remove('on'));
      return;
    }
    state('idle', '');
    void pill.offsetWidth;
    pill.classList.add('on');
    later(240, () => state('building', 'Building'));
    later(1440, () => state('done', 'Built in 1.2 seconds'));
    later(3400, () => pill.classList.remove('on'));
  };
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    run();
  });
  return run;
}

/* ── Downloads say what they are doing ────────────────────────────────────────────────────── */
function setupDownloads() {
  for (const link of document.querySelectorAll('[data-download]')) {
    const label = link.querySelector('span');
    const text = label?.textContent;
    link.addEventListener('click', () => {
      link.classList.remove('pressed');
      void link.offsetWidth;
      link.classList.add('pressed');
      if (!label) return;
      const direct = link.href.endsWith('.dmg');
      label.textContent = direct ? `Downloading${root.dataset.latest ? ` ${root.dataset.latest}` : ''}…` : 'Opening releases…';
      clearTimeout(link.timer);
      link.timer = setTimeout(() => { label.textContent = text; link.classList.remove('pressed'); }, 2800);
    });
  }
}

/* ── Blank paper: a drop of the chapter's ink where it is clicked ─────────────────────────── */
// Only on the paper itself: not on anything that does something (links, controls, cards, the
// windows and the film), not on the letters of any text, and not when the click ends a text
// selection or clears one. One bloom under the page, in the wash: it spreads on one ease-out curve
// (no overshoot) and fades as it spreads, gone in just over a second.
const ACTIVE = 'a, button, input, textarea, select, label, summary, details, video, .card, .source, .window, .player, .index-cards li, .chips, .progress, .lightbox';
function onGlyph(x, y) {
  const hit = document.caretRangeFromPoint?.(x, y);
  const node = hit?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return false;
  const range = document.createRange();
  for (const at of [hit.startOffset - 1, hit.startOffset]) {
    if (at < 0 || at >= node.length) continue;
    range.setStart(node, at);
    range.setEnd(node, at + 1);
    for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}
function setupInk() {
  const wash = document.querySelector('.wash');
  if (!wash) return;
  // A press that starts with text selected is clearing it, not touching the paper.
  let clearing = false;
  document.addEventListener('pointerdown', () => { clearing = Boolean(getSelection()?.toString()); }, true);
  document.addEventListener('click', (event) => {
    if (reduced.matches || event.button !== 0 || !(event.target instanceof Element)) return;
    if (clearing || getSelection()?.toString()) return;
    if (event.target.closest(ACTIVE) || onGlyph(event.clientX, event.clientY)) return;
    const box = wash.getBoundingClientRect();
    const drop = document.createElement('span');
    drop.className = 'ink';
    drop.style.left = `${event.clientX - box.left}px`;
    drop.style.top = `${event.clientY - box.top}px`;
    wash.append(drop);
    drop.animate([{ scale: 0.3 }, { scale: 1 }], { duration: 1100, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    drop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1100, easing: 'cubic-bezier(.5, 0, .75, 0)' })
      .finished.then(() => drop.remove(), () => drop.remove());
  });
}
