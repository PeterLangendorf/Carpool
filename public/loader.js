// Side view of a car facing right, shared by every .road progress bar (the
// loader below, and the create/join step progress in app.js). Styled by the
// .car-* rules in style.css.
const CAR_SVG = `
  <svg class="road-car" viewBox="0 0 50 27" aria-hidden="true">
    <path class="car-body" d="M46 18 Q46 13 41 12 L35 11 L30 5 Q28.5 3.5 26 3.5 L18 3.5 Q15.5 3.5 14 5.5 L9.5 11 L7 11.7 Q4 12.6 4 16.5 L4 19 Q4 21 6 21 L44 21 Q46 21 46 19 Z" />
    <path class="car-window" d="M28.5 6.2 Q27.7 5.5 26.5 5.5 L21 5.5 L21 11 L32.4 11 Z" />
    <path class="car-window" d="M19 5.5 L18 5.5 Q16.4 5.5 15.4 6.8 L12.2 11 L19 11 Z" />
    <rect class="car-light" x="42.8" y="14.4" width="2.2" height="1.8" rx="0.8" />
    <rect class="car-taillight" x="4" y="16.6" width="1.6" height="1.8" rx="0.6" />
    <g class="car-wheel">
      <circle cx="14" cy="21" r="5" class="car-tire" />
      <circle cx="14" cy="21" r="2.2" class="car-hub" />
      <rect x="13.4" y="16.6" width="1.2" height="3" class="car-hub" />
    </g>
    <g class="car-wheel">
      <circle cx="36" cy="21" r="5" class="car-tire" />
      <circle cx="36" cy="21" r="2.2" class="car-hub" />
      <rect x="35.4" y="16.6" width="1.2" height="3" class="car-hub" />
    </g>
  </svg>
`;

// Page-open loading screen: a progress bar with a car riding its leading edge,
// shown for at least MIN_DURATION and until every <img> on the page has loaded
// (or failed), then faded out. Loaded as a plain (non-deferred) <script> at the
// very top of <body> so the overlay paints before the rest of the page.
(() => {
  const MIN_DURATION = 1000;

  const loader = document.createElement('div');
  loader.className = 'page-loader';
  loader.innerHTML = `
    <div class="page-loader-inner">
      <div class="road" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="road-fill"></div>
        ${CAR_SVG}
      </div>
      <p class="page-loader-text">Loading…</p>
    </div>`;
  document.body.prepend(loader);

  const bar = loader.querySelector('[role="progressbar"]');
  const start = performance.now();
  let total = 0;
  let done = 0;
  let finished = false;
  let shown = 0;

  // The page's <img> tags don't exist yet (this runs before the rest of
  // <body> is parsed), so start tracking them once the document is parsed.
  document.addEventListener('DOMContentLoaded', () => {
    const images = Array.from(document.images);
    total = images.length;
    done = images.filter((img) => img.complete).length;
    if (done >= total) finished = true;
    images.forEach((img) => {
      if (img.complete) return;
      const onSettle = () => {
        done++;
        if (done >= total) finished = true;
      };
      img.addEventListener('load', onSettle, { once: true });
      img.addEventListener('error', onSettle, { once: true });
    });
  }, { once: true });
  // Safety nets: never leave the loader up if an image event is missed or hangs.
  window.addEventListener('load', () => { finished = true; }, { once: true });
  setTimeout(() => { finished = true; }, 15000);

  function hide() {
    loader.classList.add('done');
    loader.addEventListener('animationend', () => loader.remove(), { once: true });
    setTimeout(() => loader.remove(), 600);
  }

  function frame(now) {
    // A frame's timestamp can be slightly earlier than `start`.
    const elapsed = Math.max(0, now - start);
    // Count finished images, and let each pending one creep toward (but never
    // reach) done so the bar keeps moving while large files download.
    const creep = 0.9 * (1 - Math.exp(-elapsed / 2500));
    const loaded = finished ? 1 : total ? (done + (total - done) * creep) / total : creep;
    // The bar can't get ahead of the minimum duration, so even an instant
    // load drives across over MIN_DURATION.
    const target = Math.min(loaded, elapsed / MIN_DURATION);
    shown += (target - shown) * 0.2;
    if (target === 1 && shown > 0.995) shown = 1;

    bar.style.setProperty('--progress', shown.toFixed(4));
    bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));

    if (shown === 1) hide();
    else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
