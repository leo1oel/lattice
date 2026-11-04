// The questions open and close with their height animated (details/summary keep the keyboard
// and screen-reader behaviour; only the click is taken over). With reduced motion they simply
// open and close.

export function setupFaq({ reducedMotion }) {
  for (const details of document.querySelectorAll('[data-faq] details')) {
    const summary = details.querySelector('summary');
    const answer = details.querySelector('.answer');
    let running = null;
    summary.addEventListener('click', (event) => {
      if (reducedMotion.matches) return;
      event.preventDefault();
      const from = running ? answer.getBoundingClientRect().height : null;
      running?.cancel();
      if (!details.open || details.dataset.closing) {
        delete details.dataset.closing;
        details.open = true;
        const to = answer.scrollHeight;
        running = answer.animate([
          { height: `${from ?? 0}px`, opacity: from ? 1 : 0 },
          { height: `${to}px`, opacity: 1 },
        ], { duration: 460, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      } else {
        details.dataset.closing = '1';
        running = answer.animate([
          { height: `${from ?? answer.offsetHeight}px`, opacity: 1 },
          { height: '0px', opacity: 0 },
        ], { duration: 340, easing: 'cubic-bezier(.65, 0, .35, 1)' });
        running.onfinish = () => { details.open = false; delete details.dataset.closing; };
      }
      running.addEventListener('finish', () => { running = null; });
    });
  }
}
