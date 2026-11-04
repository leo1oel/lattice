// The site's behaviour: the download resolves to the newest release, the film plays in place, the
// wash (and the ink a click on blank paper leaves) follows the chapter on screen, and, unless the
// reader prefers reduced motion, the page moves: the hero's title is typed into main.tex and set
// live, sections arrive as they scroll in, and each card plays its part of the film's take once it
// is in view. The interactions (the lightbox, the editable title, the questions, the ink) are in
// interactions.js and faq.js.

import { enableTitleEdit, setupInteractions } from './interactions.js?v=c4';
import { setupFaq } from './faq.js?v=c1';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;

/* ── Download: the newest installer and its version, from the GitHub API ─────────────────── */
// Release assets carry the version in their names, so no version or file name is written into
// the page: links start at the latest-release page and become the direct download once the API
// answers. On any API or network failure they stay put.
fetch('https://api.github.com/repos/leo1oel/lattice/releases/latest', {
  headers: { Accept: 'application/vnd.github+json' },
}).then(async (response) => {
  if (!response.ok) return;
  const release = await response.json();
  const installer = release.assets?.find((asset) =>
    /^Lattice_.+_aarch64\.dmg$/.test(asset.name) && asset.state === 'uploaded');
  if (!installer?.browser_download_url?.startsWith('https://github.com/leo1oel/lattice/releases/download/')) return;
  document.querySelectorAll('[data-download]').forEach((link) => { link.href = installer.browser_download_url; });
  const version = /^v(\d+(\.\d+)*)$/.exec(release.tag_name ?? '')?.[1];
  if (!version) return;
  root.dataset.latest = version;
  document.querySelectorAll('[data-requirements]').forEach((element) => { element.textContent = `Version ${version}, for Apple Silicon Macs with macOS 14 or later`; });
}).catch(() => {
  // Keep the latest-release page on network or malformed API errors.
});

/* ── The film plays in place ──────────────────────────────────────────────────────────────── */
const player = document.querySelector('[data-player]');
const film = player?.querySelector('[data-film]');
function playFilm() {
  player.classList.add('playing');
  film.controls = true;
  film.play().catch(() => {});
}
player?.querySelector('.shot')?.addEventListener('click', () => { if (!player.classList.contains('playing')) playFilm(); });
// "Watch the film" scrolls there and starts it in the same gesture (browsers allow sound only then).
document.querySelector('[data-film-link]')?.addEventListener('click', () => { if (player && !player.classList.contains('playing')) playFilm(); });

/* ── The wash follows the chapter in the middle of the screen (with or without motion) ───── */
// The chapter's ink, for the drop a click on blank paper leaves: the main ink of its wash.
const INKS = { hero: '--accent', film: '--second', write: '--blue', revise: '--accent', research: '--second', collaborate: '--accent', formats: '--second', download: '--accent' };
function followWash() {
  const layers = new Map([...document.querySelectorAll('.wash i')].map((layer) => [layer.dataset.w, layer]));
  const show = (name) => {
    layers.forEach((layer, key) => layer.classList.toggle('on', key === name));
    root.style.setProperty('--chapter-ink', `var(${INKS[name] ?? '--accent'})`);
  };
  show('hero');
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) show(entry.target.dataset.wash);
  }, { rootMargin: '-45% 0px -45% 0px' });
  document.querySelectorAll('[data-wash]').forEach((section) => io.observe(section));
}

followWash();
// The hero's window sits a fixed 56 px under its text column (lede, buttons, demo link), whose
// height depends on how the lede wraps; the stylesheet's --hero-col is its no-script default.
{
  const hero = document.querySelector('.hero');
  const column = hero?.querySelector('.hero-lede');
  if (column) new ResizeObserver(() => hero.style.setProperty('--hero-col', `${Math.ceil(column.offsetHeight)}px`)).observe(column);
}
setupInteractions({ reducedMotion });
setupFaq({ reducedMotion });
if (reducedMotion.matches) enableTitleEdit();
else startMotion();
// Turning reduced motion on mid-visit settles everything where it is.
reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  root.classList.remove('motion');
  document.querySelectorAll('.card video, .hero-loop').forEach((video) => video.pause());
  document.querySelector('.hero .window')?.classList.remove('playing');
  enableTitleEdit();
});

function startMotion() {
  root.classList.add('motion');
  document.querySelectorAll('.chips li, .index-cards li, .qa details').forEach((item) => {
    item.style.setProperty('--n', String([...item.parentElement.children].indexOf(item)));
  });
  typeHero();
  revealSections();
  playCards();
  playHero();
}

/* ── Hero: the title typed into main.tex, each word set in the headline as it is finished ── */
// The source's text as tokens: line numbers (n) appear with their line; the rest is typed.
function typer(pre, tokens, { cps = 24, onType = () => {} } = {}) {
  const typed = tokens.filter((t) => t.cls !== 'n').map((t) => t.text).join('');
  const caret = '<span class="tcaret"></span>';
  const render = (count) => {
    let left = count;
    let html = '';
    for (const token of tokens) {
      if (token.cls === 'n') { if (left > 0 || html === '') html += `<span class="n">${token.text}</span>`; continue; }
      if (left <= 0) break;
      const part = token.text.slice(0, left);
      left -= part.length;
      html += token.cls ? `<span class="${token.cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
    }
    pre.innerHTML = html + caret;
  };
  return new Promise((resolve) => {
    let count = 0;
    render(0);
    const step = () => {
      count += 1;
      // A new line arrives with its indentation, as the editor's auto-indent puts it.
      if (typed[count - 1] === '\n') while (typed[count] === ' ') count += 1;
      render(count);
      onType(count, typed);
      if (count >= typed.length) { resolve(); return; }
      const ch = typed[count - 1];
      // A typist's rhythm: quicker inside a word, a beat at spaces, a longer one at a new line.
      setTimeout(step, 1000 / cps * (ch === ' ' ? 1.7 : ch === '\n' ? 3.2 : 0.7 + Math.random() * 0.6));
    };
    setTimeout(step, 1000 / cps);
  });
}
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function typeHero() {
  const hero = document.querySelector('.hero');
  const pre = hero.querySelector('[data-type-source]');
  const headline = hero.querySelector('[data-headline]');
  const words = [...headline.querySelectorAll('.w')];
  const caret = headline.querySelector('.caret');
  const tokens = [
    { cls: 'n', text: '12' }, { cls: 'cmd', text: '\\title' }, { text: '{A workspace for\n' },
    { cls: 'n', text: '13' }, { text: '       your research}' },
  ];
  // Where each headline word ends in the typed text.
  const typed = tokens.filter((t) => t.cls !== 'n').map((t) => t.text).join('');
  let from = 0;
  const ends = words.map((word) => { const at = typed.indexOf(word.textContent, from) + word.textContent.length; from = at; return at; });
  words[0].before(caret);
  document.fonts.ready.then(() => {
    hero.classList.add('typing');
    setTimeout(() => typer(pre, tokens, {
      onType: (count) => words.forEach((word, i) => {
        if (count >= ends[i] && !word.classList.contains('on')) { word.classList.add('on'); word.after(caret); }
      }),
    }).then(() => {
      hero.classList.add('done');
      enableTitleEdit();
    }), 450);
  });
}

/* ── Sections arrive as they scroll in ────────────────────────────────────────────────────── */
function revealSections() {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      io.unobserve(entry.target);
      // Once the cards have landed, hover and replays use the short timings.
      setTimeout(() => entry.target.querySelectorAll('.card, .index-cards li').forEach((el) => el.classList.add('settled')), 1600);
    }
  }, { threshold: 0.18 });
  document.querySelectorAll('.stage:not(.hero), .more, .faq, .download').forEach((section) => io.observe(section));
  const end = document.querySelector('.source-end [data-type-source]');
  const download = document.querySelector('.download');
  const endObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    endObserver.disconnect();
    setTimeout(() => typer(end, [
      { cls: 'n', text: '47' }, { text: 'Thanks for reading.\n' }, { cls: 'n', text: '48' }, { cls: 'cmd', text: '\\end' }, { text: '{document}' },
    ], { cps: 20 }), 500);
  }, { threshold: 0.4 });
  if (end && download) endObserver.observe(download);
}

/* ── Cards play their part of the take once, when they are in view ────────────────────────── */
function playCards() {
  const io = new IntersectionObserver((entries) => {
    for (const { target: video, isIntersecting, intersectionRatio } of entries) {
      if (isIntersecting && intersectionRatio >= 0.6) {
        if (!video.src) video.src = video.dataset.src;
        // Back in view after it finished: play it again from the start.
        if (video.dataset.seen === 'ended') { video.currentTime = 0; delete video.dataset.seen; }
        clearTimeout(video.waitTimer);
        // Let the card land first.
        video.waitTimer = setTimeout(() => { if (!reducedMotion.matches) video.play().catch(() => {}); }, 700);
      } else if (!isIntersecting) {
        clearTimeout(video.waitTimer);
        video.pause();
        if (video.ended) video.dataset.seen = 'ended';
      }
    }
  }, { threshold: [0, 0.6] });
  document.querySelectorAll('.card video[data-src]').forEach((video) => io.observe(video));
}

/* ── Hero: the window as a loop (an animation of the app, rendered to video) ───────────── */
// The still under it is the loop's poster frame, so the loop starts from that moment and nothing
// jumps when it takes over. It plays only while the window is on screen.
function playHero() {
  const figure = document.querySelector('.hero .window');
  const video = figure?.querySelector('.hero-loop');
  if (!video) return;
  const start = () => {
    if (!video.src) {
      video.src = video.dataset.src;
      video.addEventListener('loadedmetadata', () => { video.currentTime = Number(video.dataset.start) || 0; }, { once: true });
      video.addEventListener('playing', () => figure.classList.add('playing'), { once: true });
    }
    if (!reducedMotion.matches) video.play().catch(() => {});
  };
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) start();
    else video.pause();
  }, { threshold: 0.15 }).observe(figure);
}
