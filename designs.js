const params = new URLSearchParams(location.search);
const designNumber = Number(params.get('design') ?? '7');

const drawings = {
  1: `<path d="M42 86H310M42 98H190M42 110H248M1150 690h268m-148 12h148m-206 12h206"/><path class="strong" d="M42 74v48M1418 678v48"/>`,
  2: `<circle cx="-20" cy="360" r="190"/><circle cx="-20" cy="360" r="224"/><circle cx="1460" cy="360" r="190"/><circle cx="1460" cy="360" r="224"/><path class="strong" d="M0 136a224 224 0 0 1 0 448M1440 136a224 224 0 0 0 0 448"/>`,
  3: `<ellipse cx="720" cy="360" rx="665" ry="290"/><ellipse cx="720" cy="360" rx="610" ry="250"/><path class="strong" d="M55 360h88m1154 0h88"/><circle cx="143" cy="360" r="4"/><circle cx="1297" cy="360" r="4"/>`,
  4: `<path d="M0 112C170 22 305 200 468 96S760 12 900 102s324 82 540-22M0 142C180 52 310 230 480 126S770 42 910 132s318 82 530-22M0 172C190 82 315 260 492 156"/><path class="strong" d="M948 162c142 90 302 82 492-22"/>`,
  5: `<path d="M30 30h176v18H48v158H30zm1380 0h-176v18h158v158h18zM30 690h176v-18H48V514H30zm1380 0h-176v-18h158V514h18z"/><path class="strong" d="M66 30v54M30 66h54m1290-36v54m36-18h-54M66 690v-54m-36 18h54m1290 36v-54m36 18h-54"/>`,
  6: `<path d="M48 48v20m0 24v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v20M1392 48v20m0 24v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v12m0 28v20"/><path class="strong" d="M38 48h20M38 672h20m1324-624h20m-20 624h20"/><text x="66" y="57">00</text><text x="1350" y="57">01</text><text x="66" y="677">10</text><text x="1350" y="677">11</text>`,
  7: `<path stroke="#c4c4c4" stroke-linecap="round" d="M42 178V66Q42 54 54 54H290"/><path stroke="#c4c4c4" stroke-linecap="round" d="M1150 666H1386Q1398 666 1398 654V542"/>`,
  8: `<path d="M320 720 585 510M1120 720 855 510M80 720 510 510M1360 720 930 510M0 652h1440M0 596h1440M0 550h1440"/><path class="strong" d="M0 510h1440"/>`,
  9: `<path d="M0 532h405l34-22 42 42 46-66 58 46h270l54-34 48 34h483"/><path class="strong" d="M0 548h378m684 0h378"/><circle cx="720" cy="532" r="3"/>`,
  10: `<path d="M45 45h90m22 0h44m26 0h130M45 45v90m0 22v130M1395 675h-90m-22 0h-44m-26 0h-130m312 0v-90m0-22v-130M88 88h38v38H88zm1226 506h38v38h-38z"/><path class="strong" d="M175 45v40M45 175h40m1180 500v-40m130-90h-40"/>`,
};

function installDesign() {
  if (document.body.classList.contains('designs-page') || !Number.isInteger(designNumber) || !drawings[designNumber]) return;
  document.documentElement.classList.add('has-design', `design-${designNumber}`);
  if (params.get('still') === '1') document.documentElement.classList.add('design-still');
  const decoration = document.createElement('div');
  decoration.className = 'design-decoration';
  decoration.setAttribute('aria-hidden', 'true');
  decoration.innerHTML = `<svg viewBox="0 0 1440 720" preserveAspectRatio="none" focusable="false"><g>${drawings[designNumber]}</g></svg>`;
  document.body.prepend(decoration);
}

function installGallery() {
  const stage = document.querySelector('[data-design-stage]');
  if (!stage) return;
  const frame = stage.querySelector('iframe');
  const fullLink = stage.querySelector('a');
  const title = stage.querySelector('strong');
  const miniatures = document.querySelectorAll('.miniature');
  const sizeMiniatures = () => miniatures.forEach((miniature) => {
    miniature.style.setProperty('--preview-scale', String(miniature.clientWidth / 1440));
  });
  sizeMiniatures();
  new ResizeObserver(sizeMiniatures).observe(document.querySelector('.design-grid'));
  document.querySelectorAll('[data-design-choice]').forEach((choice) => {
    choice.addEventListener('click', () => {
      const number = choice.dataset.designChoice;
      frame.src = `./index.html?design=${number}`;
      fullLink.href = `./index.html?design=${number}`;
      title.textContent = `${number.padStart(2, '0')} · ${choice.querySelector('h2').textContent}`;
      document.querySelector('[data-design-choice][aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      choice.setAttribute('aria-pressed', 'true');
      stage.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { installDesign(); installGallery(); }, { once: true });
} else {
  installDesign();
  installGallery();
}
