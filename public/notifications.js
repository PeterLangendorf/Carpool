// The notifications bell, on the home screen and every carpool page: a
// button with the unread count that opens a sheet listing the signed-in
// user's notifications (GET /api/notifications). Opening the sheet marks
// them read. Load after auth.js; it mounts itself into #notifBell, if the
// page has one and someone is signed in.
(() => {
  const BELL_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4L6 16.5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  const REFRESH_MS = 60 * 1000;

  let items = [];
  let countEl;
  let overlay;
  let listEl;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function timeAgo(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Only same-site paths, in case a link ever came from somewhere odd.
  function safeLink(link) {
    return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : '/';
  }

  function renderCount() {
    const unread = items.filter((n) => !n.read).length;
    countEl.textContent = unread > 9 ? '9+' : String(unread);
    countEl.classList.toggle('hidden', unread === 0);
  }

  function renderList() {
    if (!items.length) {
      listEl.innerHTML = '<p class="subtitle">Nothing yet. You\'ll see join requests, schedule changes and more here.</p>';
      return;
    }
    listEl.innerHTML = items
      .map(
        (n) => `
        <a class="notif-item${n.read ? '' : ' unread'}" href="${escapeHtml(safeLink(n.link))}">
          <span class="notif-text">${escapeHtml(n.text)}</span>
          <span class="notif-meta">${escapeHtml(n.carpoolName || '')}${n.carpoolName ? ' · ' : ''}${escapeHtml(timeAgo(n.createdAt))}</span>
        </a>`
      )
      .join('');
  }

  async function refresh() {
    try {
      const res = await auth.fetch('/api/notifications');
      if (!res.ok) return;
      items = (await res.json()).notifications || [];
      renderCount();
      if (!overlay.classList.contains('hidden')) renderList();
    } catch {
      // Offline or signed out: keep what's shown.
    }
  }

  // The list is drawn with the unread ones highlighted, then they're marked
  // read, so the count clears but the highlight stays while it's open.
  async function open() {
    renderList();
    overlay.classList.remove('hidden');
    if (!items.some((n) => !n.read)) return;
    items.forEach((n) => {
      n.read = true;
    });
    renderCount();
    try {
      await auth.fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      // They'll show as unread again next time; no harm done.
    }
  }

  function close() {
    overlay.classList.add('hidden');
  }

  function build(container) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bell-btn';
    button.setAttribute('aria-label', 'Notifications');
    button.innerHTML = `${BELL_ICON}<span class="bell-count hidden"></span>`;
    countEl = button.querySelector('.bell-count');
    button.addEventListener('click', open);
    container.appendChild(button);

    overlay = document.createElement('div');
    overlay.className = 'overlay hidden';
    overlay.innerHTML = `
      <div class="overlay-card">
        <div class="header-row">
          <h2>Notifications</h2>
          <button type="button" class="ghost overlay-close-btn">Close</button>
        </div>
        <div class="notif-list"></div>
      </div>`;
    listEl = overlay.querySelector('.notif-list');
    overlay.querySelector('.overlay-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.body.appendChild(overlay);
  }

  async function mount() {
    const container = document.getElementById('notifBell');
    if (!container || !(await auth.currentUser())) return;
    build(container);
    await refresh();
    setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  mount();
})();
