const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6]; // Sunday -> Saturday
const DAY_LABELS = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
const FULL_DAY_LABELS = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

const params = new URLSearchParams(window.location.search);
const code = (params.get('code') || '').trim().toUpperCase();

if (!code) {
  window.location.href = '/';
}

const identityRaw = sessionStorage.getItem(`carpool:${code}`);
const identity = identityRaw ? JSON.parse(identityRaw) : null;

if (!identity) {
  window.location.href = `/?code=${encodeURIComponent(code)}&tab=members`;
}

let carpool = null;
let scheduleData = null;

function showError(el, message) {
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Briefly swaps an element's text to a "Copied!" confirmation, then restores it.
function flashCopiedFeedback(el, restoreText) {
  el.textContent = 'Copied!';
  setTimeout(() => {
    el.textContent = restoreText;
  }, 1200);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.errors && data.errors.join(', ')) || 'Something went wrong');
    throw err;
  }
  return data;
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeekSunday(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimeShort(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// Mirrors src/store.js's resolveActivityTimes: most-specific override wins
// (exact date, then weekday, then the uniform time for everything).
function resolveTimes(activityTimes, date, weekday) {
  const times = activityTimes || {};
  const perDate = (times.perDate && times.perDate[date]) || {};
  const perWeekday = (times.perWeekday && times.perWeekday[weekday]) || {};
  const uniform = times.uniform || {};
  return {
    there: perDate.there || perWeekday.there || uniform.there || null,
    back: perDate.back || perWeekday.back || uniform.back || null,
  };
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function renderCalendarHeader(container) {
  container.innerHTML = '';
  DAY_ORDER.forEach((d) => {
    const el = document.createElement('span');
    el.textContent = DAY_LABELS[d];
    container.appendChild(el);
  });
}

// ---- Leg-day-picker: one row per active weekday, with Drop off/Pick up checkboxes ----

function renderLegDayPicker(container, weekdays, timeResolver, selected) {
  container.innerHTML = '';
  if (!weekdays || !weekdays.length) {
    container.innerHTML = '<p class="subtitle">No active days yet.</p>';
    return;
  }
  const selThere = new Set((selected && selected.thereDays) || []);
  const selBack = new Set((selected && selected.backDays) || []);
  weekdays.forEach((w) => {
    const times = timeResolver ? timeResolver(w) : null;
    const thereLabel = times && times.there ? `Drop off · ${formatTimeShort(times.there)}` : 'Drop off';
    const backLabel = times && times.back ? `Pick up · ${formatTimeShort(times.back)}` : 'Pick up';
    const row = document.createElement('div');
    row.className = 'leg-day-row';
    row.innerHTML = `
      <div class="leg-day-name">${FULL_DAY_LABELS[w]}</div>
      <div class="leg-day-checks">
        <label class="leg-check"><input type="checkbox" data-leg="there" data-weekday="${w}" ${selThere.has(w) ? 'checked' : ''} /><span>${thereLabel}</span></label>
        <label class="leg-check"><input type="checkbox" data-leg="back" data-weekday="${w}" ${selBack.has(w) ? 'checked' : ''} /><span>${backLabel}</span></label>
      </div>
    `;
    container.appendChild(row);
  });
}

function getLegDaySelection(container) {
  const thereDays = Array.from(container.querySelectorAll('input[data-leg="there"]:checked')).map((el) => Number(el.dataset.weekday));
  const backDays = Array.from(container.querySelectorAll('input[data-leg="back"]:checked')).map((el) => Number(el.dataset.weekday));
  return { thereDays, backDays };
}

function getActiveWeekdays() {
  const weekdaySet = new Set((carpool.activityDates || []).map((d) => new Date(d + 'T00:00:00').getDay()));
  const list = DAY_ORDER.filter((d) => weekdaySet.has(d));
  return list.length ? list : DAY_ORDER.slice();
}

function dashboardTimeResolver(weekday) {
  const date = (carpool.activityDates || []).find((d) => new Date(d + 'T00:00:00').getDay() === weekday) || null;
  return resolveTimes(carpool.activityTimes, date, weekday);
}

// ---- Overlay helpers ----

// Reference-counted so a popup opened on top of another overlay (e.g. the
// time picker over the date editor) doesn't unlock scrolling when it alone closes.
let scrollLockCount = 0;
let savedScrollY = 0;

function lockBodyScroll() {
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';

    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      viewport.dataset.prevContent = viewport.getAttribute('content');
      viewport.setAttribute('content', `${viewport.dataset.prevContent}, user-scalable=no`);
    }
  }
  scrollLockCount++;
}

function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;

  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.overflow = '';
  window.scrollTo(0, savedScrollY);

  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && viewport.dataset.prevContent) {
    viewport.setAttribute('content', viewport.dataset.prevContent);
  }
}

['membersOverlay', 'leaveConfirmOverlay', 'dateEditorOverlay', 'routeOverlay', 'myChildrenOverlay', 'timePickerOverlay', 'myAddressesOverlay', 'detailsOverlay'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener(
    'touchmove',
    (e) => {
      if (e.target === el) e.preventDefault();
    },
    { passive: false }
  );
});

// ---- Main dashboard render ----

function renderStats() {
  const statsRow = document.getElementById('statsRow');
  statsRow.innerHTML = '';
  carpool.members.forEach((m) => {
    const pill = document.createElement('span');
    pill.className = 'stat-pill';
    const count = scheduleData.driveCounts[m.id] || 0;
    pill.innerHTML = `${m.id === identity.id ? 'You' : m.name}: <strong>${count}</strong> drive${count === 1 ? '' : 's'}`;
    statsRow.appendChild(pill);
  });
}

const PROBLEMS_CAP = 4;
let problemsExpanded = false;

function renderProblems() {
  const card = document.getElementById('problemsCard');
  const list = document.getElementById('problemsList');

  // A solo carpool can't have driver-assignment problems worth surfacing —
  // there's no one else to reassign to.
  if (carpool.members.length <= 1) {
    card.classList.add('hidden');
    return;
  }

  const problems = [];
  scheduleData.schedule.forEach((e) => {
    if (e.there.noDriverAvailable || e.there.overCapacity) problems.push({ entry: e, legData: e.there, legLabel: 'drop off ride' });
    if (e.back.noDriverAvailable || e.back.overCapacity) problems.push({ entry: e, legData: e.back, legLabel: 'pick up ride' });
  });

  card.classList.toggle('hidden', problems.length === 0);
  list.innerHTML = '';

  const shown = problemsExpanded ? problems : problems.slice(0, PROBLEMS_CAP);

  shown.forEach(({ entry, legData, legLabel }) => {
    const message = legData.noDriverAvailable
      ? `No drivers are available for the ${legLabel}.`
      : `Not enough seats for the ${legLabel} — ${legData.strandedCount} more seat${legData.strandedCount === 1 ? '' : 's'} needed.`;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'problem-item';
    item.innerHTML = `<strong>${formatDate(entry.date)}</strong><div>${message}</div>`;
    item.addEventListener('click', () => {
      selectDay(entry.date);
      document.getElementById('dayDetails').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(item);
  });

  if (!problemsExpanded && problems.length > PROBLEMS_CAP) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'problem-item problem-more-btn';
    moreBtn.textContent = `...and ${problems.length - PROBLEMS_CAP} more`;
    moreBtn.addEventListener('click', () => {
      problemsExpanded = true;
      renderProblems();
    });
    list.appendChild(moreBtn);
  }
}

function renderDatesStatus() {
  const msgEl = document.getElementById('noDatesMessage');
  const addBtn = document.getElementById('addDatesBtn');
  const isOwner = identity.id === carpool.ownerId;
  const hasUpcoming = scheduleData.schedule.length > 0;

  if (hasUpcoming) {
    msgEl.classList.add('hidden');
    addBtn.classList.add('hidden');
    return;
  }
  msgEl.textContent = isOwner
    ? "You haven't added any carpool dates yet."
    : 'Waiting for the owner to add carpool dates.';
  msgEl.classList.remove('hidden');
  addBtn.classList.toggle('hidden', !isOwner);
}

const CALENDAR_DAYS_SHOWN = 28; // 4 weeks
let selectedDateKey = null;

function legStatus(leg) {
  if (!leg || leg.children.length === 0) return 'none';
  if (leg.noDriverAvailable) return 'no-driver';
  if (leg.drivers.some((d) => d.id === identity.id)) return 'mine';
  return 'not-mine';
}

const STATUS_PRIORITY = ['none', 'not-mine', 'mine', 'no-driver'];

function combineStatus(a, b) {
  return STATUS_PRIORITY[Math.max(STATUS_PRIORITY.indexOf(a), STATUS_PRIORITY.indexOf(b))];
}

function legLine(leg, arrow) {
  if (!leg || leg.children.length === 0) return '';
  let text;
  if (leg.noDriverAvailable) {
    text = '⚠';
  } else if (leg.drivers.some((d) => d.id === identity.id)) {
    text = 'You';
  } else {
    text = initials(leg.drivers[0].name) + (leg.drivers.length > 1 ? '+1' : '');
  }
  return `<span class="cal-leg">${arrow} ${text}</span>`;
}

function renderMainCalendar() {
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  const scheduleMap = new Map(scheduleData.schedule.map((e) => [e.date, e]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today);
  const weekStart = startOfWeekSunday(today);

  for (let i = 0; i < CALENDAR_DAYS_SHOWN; i++) {
    const date = new Date(weekStart);
    date.setDate(weekStart.getDate() + i);
    const dateKey = toDateKey(date);
    const entry = scheduleMap.get(dateKey);
    const isPast = dateKey < todayKey;
    const isToday = dateKey === todayKey;

    let stateClass;
    if (isPast) {
      stateClass = 'past';
    } else if (!entry) {
      stateClass = 'none';
    } else {
      stateClass = combineStatus(legStatus(entry.there), legStatus(entry.back));
    }

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `cal-cell ${stateClass}` + (isToday ? ' today' : '') + (dateKey === selectedDateKey ? ' active-day' : '');
    cell.dataset.date = dateKey;

    cell.innerHTML = `
      <span class="cal-daynum">${date.getDate()}</span>
      ${entry ? legLine(entry.there, '→') : ''}
      ${entry ? legLine(entry.back, '←') : ''}
    `;
    cell.addEventListener('click', () => selectDay(dateKey));
    grid.appendChild(cell);
  }
}

function renderChildrenSection(entry, isMine) {
  if (!entry.children.length) {
    return '<div class="riders">No riders scheduled this ride.</div>';
  }
  if (!isMine) {
    const list = entry.children.map((c) => `${c.name} (${c.parentName})`).join(', ');
    return `<div class="riders">Riders going: ${list}</div>`;
  }
  const items = entry.children
    .map((c) => {
      const whose = c.parentId === identity.id ? 'yours' : c.parentName;
      return `<li>${c.name} <span class="pickup-parent">(${whose})</span></li>`;
    })
    .join('');
  return `
    <div class="pickup-list">
      <div class="pickup-list-title">🧒 Riders you're driving</div>
      <ul class="pickup-items">${items}</ul>
    </div>
  `;
}

function renderChildToggles(children, entry) {
  const excluded = new Set(
    (carpool.dateOverrides && carpool.dateOverrides[entry.date] && carpool.dateOverrides[entry.date].excludedChildIds) || []
  );
  const rows = children
    .map((c) => {
      const attending = !excluded.has(c.id);
      return `
        <label class="child-toggle-row">
          <input type="checkbox" class="child-toggle-input" data-child-id="${c.id}" data-original-attending="${attending}" ${attending ? 'checked' : ''} />
          <span>${c.name} going this day</span>
        </label>
      `;
    })
    .join('');
  return `
    <div class="child-toggles">
      <div class="riders">Your riders for this day:</div>
      ${rows}
      <button type="button" id="saveChildTogglesBtn" class="hidden">Save changes</button>
      <p class="error hidden" id="childToggleError"></p>
    </div>
  `;
}

async function saveChildChanges(dateKey, changes) {
  await Promise.all(
    changes.map(({ childId, excluded }) =>
      api(`/api/carpools/${encodeURIComponent(code)}/dates/${dateKey}/child-exclusion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterId: identity.id, childId, excluded }),
      })
    )
  );
  // Must refresh `carpool` too, not just the schedule — the checkboxes are
  // re-rendered from carpool.dateOverrides, which would otherwise still show
  // the pre-save exclusion state and immediately re-check the box.
  await refreshCarpoolAndSchedule();
}

function wireChildToggles(dateKey) {
  const inputs = Array.from(document.querySelectorAll('.child-toggle-input'));
  const saveBtn = document.getElementById('saveChildTogglesBtn');
  if (!inputs.length || !saveBtn) return;

  const hasChanges = () => inputs.some((i) => String(i.checked) !== i.dataset.originalAttending);

  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      saveBtn.classList.toggle('hidden', !hasChanges());
    });
  });

  saveBtn.addEventListener('click', async () => {
    const changes = inputs
      .filter((i) => String(i.checked) !== i.dataset.originalAttending)
      .map((i) => ({ childId: i.dataset.childId, excluded: !i.checked }));
    if (!changes.length) return;

    saveBtn.disabled = true;
    const errorEl = document.getElementById('childToggleError');
    showError(errorEl, '');
    try {
      await saveChildChanges(dateKey, changes);
      renderStats();
      renderMainCalendar();
      renderProblems();
      selectDay(dateKey);
    } catch (err) {
      saveBtn.disabled = false;
      showError(errorEl, err.message);
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Which of a member's addresses a given ride uses: the one they picked for
// that leg + weekday, falling back to their first address.
function rideAddressFor(member, leg, weekday) {
  const addresses = (member && member.addresses) || [];
  const chosenId = member && member.rideAddresses && member.rideAddresses[leg] && member.rideAddresses[leg][weekday];
  const match = addresses.find((a) => a.id === chosenId) || addresses[0];
  return match ? match.address : null;
}

function mapsLink(address, text) {
  const url = `https://maps.apple.com/?address=${encodeURIComponent(address)}`;
  return `<a href="${url}" target="_blank" rel="noopener">${escapeHtml(text || address)}</a>`;
}

function activityStopHtml(title, note) {
  const location = carpool.activityLocation;
  const label = `🏁 ${location || 'Activity'}`;
  return `
    <div class="route-stop route-stop-final">
      <div class="route-address">${location ? mapsLink(location, label) : escapeHtml(label)}</div>
      <div class="route-kids">${escapeHtml(title)}${note ? ` — ${escapeHtml(note)}` : ''}</div>
    </div>
  `;
}

// Lists the stops in the order they're added, with an Apple Maps link for
// each — it doesn't reorder them into an optimized route.
function openRouteOverlay(entry, leg) {
  const legData = leg === 'there' ? entry.there : entry.back;
  const legLabel = leg === 'there' ? 'Drop off' : 'Pick up';
  document.getElementById('routeDateLabel').textContent = `${legLabel} · ${FULL_DAY_LABELS[entry.weekday]}, ${formatDateShort(entry.date)}`;

  const me = carpool.members.find((m) => m.id === identity.id);
  const myAddressCount = me && me.addresses ? me.addresses.length : 0;

  // Group riders by the address they're picked up from / dropped off at.
  const stops = new Map();
  legData.children.forEach((c) => {
    const member = carpool.members.find((m) => m.id === c.parentId);
    const address = rideAddressFor(member, leg, entry.weekday);
    // With a single address, your own riders start/end the trip with you at
    // home — only list them as a stop when you've got several addresses.
    if (c.parentId === identity.id && myAddressCount <= 1) return;
    const key = `${c.parentId}|${address || ''}`;
    if (!stops.has(key)) stops.set(key, { address, parentName: c.parentId === identity.id ? 'yours' : `${c.parentName}'s`, kids: [] });
    stops.get(key).kids.push(c.name);
  });

  const container = document.getElementById('routeStops');
  container.innerHTML = '';

  // The drop off ride ends at the activity, after all the pickups; the pick
  // up ride starts there instead.
  if (leg === 'back') container.innerHTML += activityStopHtml('First stop', 'pick up all riders here.');

  if (stops.size === 0) {
    container.innerHTML += '<p class="subtitle">No other stops — just your own riders today!</p>';
  } else {
    stops.forEach(({ address, parentName, kids }) => {
      container.innerHTML += `
        <div class="route-stop">
          <div class="route-address">${address ? mapsLink(address) : 'No address on file'}</div>
          <div class="route-kids">${leg === 'there' ? 'Pick up' : 'Drop off'}: ${kids.map(escapeHtml).join(', ')} (${escapeHtml(parentName)})</div>
        </div>
      `;
    });
  }

  if (leg === 'there') container.innerHTML += activityStopHtml('Last stop', 'drop off all riders here.');

  document.getElementById('routeOverlay').classList.remove('hidden');
  lockBodyScroll();
}

// Named differently from the #closeRouteOverlay button itself — an element
// with an id and a same-named global function/variable can collide (DOM
// clobbering), which is an unreliable pattern across browsers.
function dismissRouteOverlay() {
  document.getElementById('routeOverlay').classList.add('hidden');
  unlockBodyScroll();
}

document.getElementById('closeRouteOverlay').addEventListener('click', dismissRouteOverlay);

function renderLeg(entry, legData, time, label) {
  if (legData.children.length === 0) return '';
  const timeStr = time ? formatTimeShort(time) : '';
  const legKey = label === 'Drop off' ? 'there' : 'back';

  if (legData.noDriverAvailable) {
    return `
      <div class="leg-block">
        <div class="date-row"><strong>${label}</strong><span>${timeStr}</span></div>
        <div class="warning">⚠ No drivers are available for this ride.</div>
      </div>
    `;
  }

  const isMine = legData.drivers.some((d) => d.id === identity.id);
  const driverNames = legData.drivers.map((d) => (d.id === identity.id ? 'You' : d.name)).join(' & ');

  return `
    <div class="leg-block">
      <div class="date-row"><strong>${label}</strong><span>${timeStr}</span></div>
      <div class="driver-row">
        🚗 Driver${legData.drivers.length > 1 ? 's' : ''}: ${driverNames}
        ${isMine ? '<span class="you-tag">YOUR TURN</span>' : ''}
      </div>
      ${renderChildrenSection(legData, isMine)}
      ${legData.overCapacity ? `<div class="warning">⚠ Not enough seats for everyone on this ride (${legData.strandedCount} may need another ride).</div>` : ''}
      ${isMine ? `<button type="button" class="secondary start-route-btn" data-leg="${legKey}">🧭 Start route</button>` : ''}
    </div>
  `;
}

function selectDay(dateKey) {
  selectedDateKey = dateKey;
  document.querySelectorAll('#calendarGrid .cal-cell').forEach((cell) => {
    cell.classList.toggle('active-day', cell.dataset.date === dateKey);
  });

  const panel = document.getElementById('dayDetails');
  const entry = scheduleData.schedule.find((e) => e.date === dateKey);

  panel.classList.remove('hidden');
  panel.classList.remove('mine');

  if (!entry) {
    panel.innerHTML = `
      <div class="date-row"><strong>${formatDate(dateKey)}</strong></div>
      <div class="riders">No carpool scheduled this day.</div>
    `;
    return;
  }

  const isMine = entry.there.drivers.some((d) => d.id === identity.id) || entry.back.drivers.some((d) => d.id === identity.id);
  panel.classList.toggle('mine', isMine);

  const thereHtml = renderLeg(entry, entry.there, entry.thereTime, 'Drop off');
  const backHtml = renderLeg(entry, entry.back, entry.backTime, 'Pick up');

  const me = carpool.members.find((m) => m.id === identity.id);
  const myRelevantChildren = me
    ? me.children.filter((c) => c.needsRideThereDays.includes(entry.weekday) || c.needsRideBackDays.includes(entry.weekday))
    : [];
  const myChildrenToggles = myRelevantChildren.length ? renderChildToggles(myRelevantChildren, entry) : '';

  panel.innerHTML = `
    <div class="date-row"><strong>${FULL_DAY_LABELS[entry.weekday]}</strong><span>${formatDateShort(entry.date)}</span></div>
    ${!thereHtml && !backHtml ? '<div class="riders">No riders scheduled this day.</div>' : ''}
    ${thereHtml}
    ${backHtml}
    ${myChildrenToggles}
  `;
  wireChildToggles(entry.date);
  panel.querySelectorAll('.start-route-btn').forEach((btn) => {
    btn.addEventListener('click', () => openRouteOverlay(entry, btn.dataset.leg));
  });
}

function autoSelectDay() {
  const panel = document.getElementById('dayDetails');
  if (!scheduleData.schedule.length) {
    panel.classList.add('hidden');
    return;
  }
  const mine = scheduleData.schedule.find(
    (e) =>
      (e.there.drivers && e.there.drivers.some((d) => d.id === identity.id)) ||
      (e.back.drivers && e.back.drivers.some((d) => d.id === identity.id))
  );
  selectDay((mine || scheduleData.schedule[0]).date);
}

function sortDays(days) {
  return days.slice().sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

function renderMembers() {
  const list = document.getElementById('memberList');
  list.innerHTML = '';
  carpool.members.forEach((m) => {
    const isOwnerRow = m.id === carpool.ownerId;
    const isMe = m.id === identity.id;
    const childCount = (m.children || []).length;
    const label = `${m.name}${isMe ? ' (you)' : ''}${isOwnerRow ? ' · owner' : ''} — ${childCount} ${childCount === 1 ? 'rider' : 'riders'}`;

    const row = document.createElement('div');
    row.className = 'member-row';
    row.textContent = label;
    list.appendChild(row);
  });
}

function openMembersOverlay() {
  renderMembers();
  document.getElementById('membersOverlay').classList.remove('hidden');
  lockBodyScroll();
}

// Named differently from the #closeMembersOverlay button itself — see the
// note on dismissRouteOverlay above.
function dismissMembersOverlay() {
  document.getElementById('membersOverlay').classList.add('hidden');
  unlockBodyScroll();
}

document.getElementById('codeBadge').addEventListener('click', async () => {
  const el = document.getElementById('codeBadge');
  if (await copyTextToClipboard(carpool.code)) flashCopiedFeedback(el, carpool.code);
});

document.getElementById('membersBtn').addEventListener('click', openMembersOverlay);
document.getElementById('closeMembersOverlay').addEventListener('click', dismissMembersOverlay);
document.getElementById('myChildrenBtn').addEventListener('click', openMyChildrenOverlay);
document.getElementById('editDatesBtn').addEventListener('click', openDateEditor);

// ---- My children overlay ----

async function refreshCarpoolAndSchedule() {
  [carpool, scheduleData] = await Promise.all([fetchCarpool(), fetchSchedule()]);
}

function renderMyChildren() {
  const me = carpool.members.find((m) => m.id === identity.id);
  const list = document.getElementById('myChildrenList');
  list.innerHTML = '';

  if (!me.children.length) {
    list.innerHTML = '<p class="subtitle">No riders added yet.</p>';
    return;
  }

  const activeWeekdays = getActiveWeekdays();

  me.children.forEach((child) => {
    const originalFirstName = child.name.split(' ')[0];
    const row = document.createElement('div');
    row.className = 'my-child-row';
    row.innerHTML = `
      <div class="field">
        <label>Name</label>
        <input type="text" class="my-child-name-input" value="${originalFirstName}" />
      </div>
      <div class="field">
        <label>Rides needed</label>
        <div data-my-child-legdays></div>
      </div>
      <div class="my-child-row-actions">
        <button type="button" class="secondary save-child-btn">Save</button>
        <button type="button" class="ghost remove-child-link">Remove</button>
      </div>
    `;
    renderLegDayPicker(row.querySelector('[data-my-child-legdays]'), activeWeekdays, dashboardTimeResolver, {
      thereDays: child.needsRideThereDays,
      backDays: child.needsRideBackDays,
    });
    row.querySelector('.save-child-btn').addEventListener('click', () => saveMyChild(child.id, row, originalFirstName));
    row.querySelector('.remove-child-link').addEventListener('click', () => removeMyChild(child.id, child.name));
    list.appendChild(row);
  });
}

async function saveMyChild(childId, row, originalFirstName) {
  const newFirstName = row.querySelector('.my-child-name-input').value.trim();
  const { thereDays, backDays } = getLegDaySelection(row.querySelector('[data-my-child-legdays]'));
  const errorEl = document.getElementById('myChildrenError');
  showError(errorEl, '');

  const body = { requesterId: identity.id, needsRideThereDays: thereDays, needsRideBackDays: backDays };
  if (newFirstName && newFirstName !== originalFirstName) body.firstName = newFirstName;

  try {
    await api(`/api/carpools/${encodeURIComponent(code)}/members/${identity.id}/children/${childId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await refreshCarpoolAndSchedule();
    renderAll();
    renderMyChildren();
  } catch (err) {
    showError(errorEl, err.message);
  }
}

async function removeMyChild(childId, name) {
  if (!window.confirm(`Remove ${name} from this carpool?`)) return;
  const errorEl = document.getElementById('myChildrenError');
  showError(errorEl, '');
  try {
    await api(`/api/carpools/${encodeURIComponent(code)}/members/${identity.id}/children/${childId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id }),
    });
    await refreshCarpoolAndSchedule();
    renderAll();
    renderMyChildren();
  } catch (err) {
    showError(errorEl, err.message);
  }
}

document.getElementById('addMyChildBtn').addEventListener('click', async () => {
  const firstName = window.prompt("New rider's first name?");
  if (!firstName || !firstName.trim()) return;
  const errorEl = document.getElementById('myChildrenError');
  showError(errorEl, '');
  try {
    await api(`/api/carpools/${encodeURIComponent(code)}/members/${identity.id}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id, firstName: firstName.trim(), needsRideThereDays: [], needsRideBackDays: [] }),
    });
    await refreshCarpoolAndSchedule();
    renderAll();
    renderMyChildren();
  } catch (err) {
    showError(errorEl, err.message);
  }
});

function openMyChildrenOverlay() {
  showError(document.getElementById('myChildrenError'), '');
  renderMyChildren();
  document.getElementById('myChildrenOverlay').classList.remove('hidden');
  lockBodyScroll();
}

function closeMyChildrenOverlay() {
  document.getElementById('myChildrenOverlay').classList.add('hidden');
  unlockBodyScroll();
}

document.getElementById('closeMyChildren').addEventListener('click', closeMyChildrenOverlay);

function renderAll() {
  document.getElementById('carpoolName').textContent = carpool.name;
  const activityEl = document.getElementById('activitySummary');
  activityEl.textContent = [carpool.activityName, carpool.activityLocation].filter(Boolean).join(' · ');
  activityEl.classList.toggle('hidden', !activityEl.textContent);
  document.getElementById('codeBadge').textContent = carpool.code;
  document.getElementById('whoami').textContent = `Signed in as ${identity.name}`;
  document.getElementById('editDatesBtn').classList.toggle('hidden', identity.id !== carpool.ownerId);
  document.getElementById('editDetailsBtn').classList.toggle('hidden', identity.id !== carpool.ownerId);
  renderStats();
  renderProblems();
  renderDatesStatus();
  renderCalendarHeader(document.getElementById('calendarHeader'));
  renderMainCalendar();
  autoSelectDay();
  renderMembers();
}

async function fetchCarpool() {
  const res = await fetch(`/api/carpools/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error('Carpool not found');
  return res.json();
}

async function fetchSchedule() {
  const res = await fetch(`/api/carpools/${encodeURIComponent(code)}/schedule`);
  if (!res.ok) throw new Error('Could not load schedule');
  return res.json();
}

async function loadAll() {
  const errorEl = document.getElementById('loadError');
  try {
    [carpool, scheduleData] = await Promise.all([fetchCarpool(), fetchSchedule()]);
    renderAll();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

// ---- Owner: activity date editor ----

let editorSelectedDates = new Set();
let editorPastDates = [];
let editorActivityTimes = { uniform: {}, perWeekday: {}, perDate: {} };
let editorViewDate = null; // first-of-month Date currently shown
let timePickerContext = null; // { dateKey, isNew, weekday }

const MAX_MONTHS_AHEAD = 12;

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function renderEditorMonth() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  document.getElementById('editorMonthLabel').textContent = editorViewDate.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  document.getElementById('editorPrevMonth').disabled = editorViewDate.getTime() <= currentMonthStart.getTime();
  const maxMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + MAX_MONTHS_AHEAD, 1);
  document.getElementById('editorNextMonth').disabled = editorViewDate.getTime() >= maxMonthStart.getTime();

  renderCalendarHeader(document.getElementById('editorCalendarHeader'));

  const grid = document.getElementById('editorCalendarGrid');
  grid.innerHTML = '';

  const firstWeekday = editorViewDate.getDay(); // Sunday-first grid, no offset needed
  for (let b = 0; b < firstWeekday; b++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-blank';
    grid.appendChild(blank);
  }

  const numDays = daysInMonth(editorViewDate.getFullYear(), editorViewDate.getMonth());
  for (let day = 1; day <= numDays; day++) {
    const date = new Date(editorViewDate.getFullYear(), editorViewDate.getMonth(), day);
    const dateKey = toDateKey(date);
    const weekday = date.getDay();
    const isPast = dateKey < todayKey;
    const selected = editorSelectedDates.has(dateKey);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell' + (selected ? ' selected' : '');
    cell.disabled = isPast;
    const resolved = selected ? resolveTimes(editorActivityTimes, dateKey, weekday) : null;
    cell.innerHTML = `
      <span class="cal-daynum">${day}</span>
      ${resolved && resolved.there ? `<span class="cal-time">${formatTimeShort(resolved.there)}</span>` : ''}
      ${resolved && resolved.back ? `<span class="cal-time">${formatTimeShort(resolved.back)}</span>` : ''}
    `;
    if (!isPast) {
      cell.addEventListener('click', () => {
        const isNew = !editorSelectedDates.has(dateKey);
        if (isNew) editorSelectedDates.add(dateKey);
        openTimePicker(dateKey, isNew);
      });
    }
    grid.appendChild(cell);
  }
}

function openTimePicker(dateKey, isNew) {
  const weekday = new Date(dateKey + 'T00:00:00').getDay();
  timePickerContext = { dateKey, isNew, weekday };

  document.getElementById('timePickerDateLabel').textContent = `${FULL_DAY_LABELS[weekday]}, ${formatDateShort(dateKey)}`;
  const resolved = resolveTimes(editorActivityTimes, dateKey, weekday);
  document.getElementById('timePickerThereInput').value = resolved.there || '';
  document.getElementById('timePickerBackInput').value = resolved.back || '';
  showError(document.getElementById('timePickerError'), '');

  const sameWeekdayCount = Array.from(editorSelectedDates).filter(
    (d) => new Date(d + 'T00:00:00').getDay() === weekday
  ).length;
  const weekdayBtn = document.getElementById('saveTimeWeekday');
  weekdayBtn.textContent = `Save for all ${FULL_DAY_LABELS[weekday]}s`;
  weekdayBtn.classList.toggle('hidden', sameWeekdayCount < 2);
  document.getElementById('saveTimeAllDates').classList.toggle('hidden', editorSelectedDates.size < 2);

  document.getElementById('timePickerOverlay').classList.remove('hidden');
  lockBodyScroll();
}

function closeTimePicker() {
  document.getElementById('timePickerOverlay').classList.add('hidden');
  unlockBodyScroll();
  timePickerContext = null;
}

function applyTime(scope) {
  const there = document.getElementById('timePickerThereInput').value;
  const back = document.getElementById('timePickerBackInput').value;
  if (!there || !back) return showError(document.getElementById('timePickerError'), 'Enter both a start and end time');

  const { dateKey, weekday } = timePickerContext;
  if (scope === 'day') {
    editorActivityTimes.perDate[dateKey] = { there, back };
  } else if (scope === 'weekday') {
    editorActivityTimes.perWeekday[weekday] = { there, back };
  } else if (scope === 'all') {
    editorActivityTimes.uniform = { there, back };
  }
  closeTimePicker();
  renderEditorMonth();
}

document.getElementById('saveTimeJustDay').addEventListener('click', () => applyTime('day'));
document.getElementById('saveTimeWeekday').addEventListener('click', () => applyTime('weekday'));
document.getElementById('saveTimeAllDates').addEventListener('click', () => applyTime('all'));

document.getElementById('removeThisDateBtn').addEventListener('click', () => {
  editorSelectedDates.delete(timePickerContext.dateKey);
  delete editorActivityTimes.perDate[timePickerContext.dateKey];
  closeTimePicker();
  renderEditorMonth();
});

document.getElementById('cancelTimePicker').addEventListener('click', () => {
  if (timePickerContext && timePickerContext.isNew) {
    editorSelectedDates.delete(timePickerContext.dateKey);
  }
  closeTimePicker();
  renderEditorMonth();
});

document.getElementById('editorPrevMonth').addEventListener('click', () => {
  editorViewDate = new Date(editorViewDate.getFullYear(), editorViewDate.getMonth() - 1, 1);
  renderEditorMonth();
});

document.getElementById('editorNextMonth').addEventListener('click', () => {
  editorViewDate = new Date(editorViewDate.getFullYear(), editorViewDate.getMonth() + 1, 1);
  renderEditorMonth();
});

function openDateEditor() {
  const today = new Date();
  const todayKey = toDateKey(today);
  editorPastDates = (carpool.activityDates || []).filter((d) => d < todayKey);
  editorSelectedDates = new Set((carpool.activityDates || []).filter((d) => d >= todayKey));
  const times = carpool.activityTimes || {};
  editorActivityTimes = {
    uniform: { ...(times.uniform || {}) },
    perWeekday: JSON.parse(JSON.stringify(times.perWeekday || {})),
    perDate: JSON.parse(JSON.stringify(times.perDate || {})),
  };
  editorViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
  showError(document.getElementById('dateEditorError'), '');
  renderEditorMonth();
  document.getElementById('dateEditorOverlay').classList.remove('hidden');
  lockBodyScroll();
}

// Named differently from the #closeDateEditor button itself — see the note
// on dismissRouteOverlay above.
function dismissDateEditor() {
  unlockBodyScroll();
  document.getElementById('dateEditorOverlay').classList.add('hidden');
}

document.getElementById('closeDateEditor').addEventListener('click', dismissDateEditor);
document.getElementById('addDatesBtn').addEventListener('click', openDateEditor);

document.getElementById('saveDatesBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('dateEditorError');
  showError(errorEl, '');
  try {
    const dates = [...editorPastDates, ...Array.from(editorSelectedDates)];
    // `recurrence` is intentionally omitted so the server keeps the carpool's
    // existing recurrence rule (if any) unchanged and just diffs these dates
    // against it to track which occurrences were manually removed.
    carpool = await api(`/api/carpools/${encodeURIComponent(code)}/activity-dates`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id, dates, times: editorActivityTimes }),
    });
    scheduleData = await fetchSchedule();
    dismissDateEditor();
    renderAll();
  } catch (err) {
    showError(errorEl, err.message);
  }
});

// ---- My addresses overlay ----

// Working copy while the overlay is open: rides point at address rows by
// index (the same shape the API takes), so adding/removing rows only has to
// shift those indexes.
let addressDraft = []; // [{ id, address }]
let rideAddressDraft = { there: {}, back: {} }; // leg -> weekday -> index into addressDraft

function myRides() {
  const me = carpool.members.find((m) => m.id === identity.id);
  const rides = [];
  ['there', 'back'].forEach((leg) => {
    const days = new Set();
    (me.children || []).forEach((c) => (leg === 'there' ? c.needsRideThereDays : c.needsRideBackDays).forEach((d) => days.add(d)));
    sortDays(Array.from(days)).forEach((weekday) => rides.push({ leg, weekday }));
  });
  return rides.sort((a, b) => a.weekday - b.weekday || (a.leg === 'there' ? -1 : 1));
}

function renderMyRideAddresses() {
  const section = document.getElementById('myRideAddressesSection');
  const list = document.getElementById('myRideAddressesList');
  const filled = addressDraft.map((a, i) => ({ ...a, index: i })).filter((a) => a.address.trim());
  const rides = myRides();
  section.classList.toggle('hidden', filled.length < 2 || rides.length === 0);
  list.innerHTML = '';
  rides.forEach(({ leg, weekday }) => {
    const chosen = rideAddressDraft[leg][weekday] || 0;
    const row = document.createElement('div');
    row.className = 'ride-address-row';
    row.innerHTML = `
      <span>${FULL_DAY_LABELS[weekday]} · ${leg === 'there' ? 'Drop off' : 'Pick up'}</span>
      <select>${filled
        .map((a) => `<option value="${a.index}" ${a.index === chosen ? 'selected' : ''}>${escapeHtml(a.address)}</option>`)
        .join('')}</select>
    `;
    row.querySelector('select').addEventListener('change', (e) => {
      rideAddressDraft[leg][weekday] = Number(e.target.value);
    });
    list.appendChild(row);
  });
}

function renderMyAddresses() {
  const list = document.getElementById('myAddressesList');
  list.innerHTML = '';
  addressDraft.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'child-row';
    row.innerHTML = `
      <div class="child-row-main">
        <input type="text" class="child-name-input" placeholder="e.g. 123 Main St" autocomplete="street-address" />
        <button type="button" class="remove-child-btn" aria-label="Remove address">×</button>
      </div>
    `;
    const input = row.querySelector('input');
    input.value = a.address;
    input.addEventListener('input', () => {
      a.address = input.value;
    });
    input.addEventListener('change', renderMyRideAddresses);
    row.querySelector('.remove-child-btn').addEventListener('click', () => removeDraftAddress(i));
    list.appendChild(row);
  });
  renderMyRideAddresses();
}

function removeDraftAddress(index) {
  addressDraft.splice(index, 1);
  ['there', 'back'].forEach((leg) => {
    Object.keys(rideAddressDraft[leg]).forEach((w) => {
      const i = rideAddressDraft[leg][w];
      if (i === index) rideAddressDraft[leg][w] = 0;
      else if (i > index) rideAddressDraft[leg][w] = i - 1;
    });
  });
  if (!addressDraft.length) addressDraft.push({ id: null, address: '' });
  renderMyAddresses();
}

function openMyAddressesOverlay() {
  const me = carpool.members.find((m) => m.id === identity.id);
  addressDraft = (me.addresses || []).map((a) => ({ id: a.id, address: a.address }));
  if (!addressDraft.length) addressDraft.push({ id: null, address: '' });
  rideAddressDraft = { there: {}, back: {} };
  ['there', 'back'].forEach((leg) => {
    Object.entries((me.rideAddresses && me.rideAddresses[leg]) || {}).forEach(([w, id]) => {
      const index = addressDraft.findIndex((a) => a.id === id);
      if (index !== -1) rideAddressDraft[leg][w] = index;
    });
  });
  showError(document.getElementById('myAddressesError'), '');
  renderMyAddresses();
  document.getElementById('myAddressesOverlay').classList.remove('hidden');
  lockBodyScroll();
}

function dismissMyAddressesOverlay() {
  document.getElementById('myAddressesOverlay').classList.add('hidden');
  unlockBodyScroll();
}

document.getElementById('myAddressesBtn').addEventListener('click', openMyAddressesOverlay);
document.getElementById('closeMyAddresses').addEventListener('click', dismissMyAddressesOverlay);
document.getElementById('addMyAddressBtn').addEventListener('click', () => {
  addressDraft.push({ id: null, address: '' });
  renderMyAddresses();
  const inputs = document.querySelectorAll('#myAddressesList input');
  inputs[inputs.length - 1].focus();
});

document.getElementById('saveMyAddressesBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('myAddressesError');
  showError(errorEl, '');

  // Drop blank rows, remapping ride indexes to the compacted list.
  const indexMap = new Map();
  const addresses = [];
  addressDraft.forEach((a, i) => {
    if (!a.address.trim()) return;
    indexMap.set(i, addresses.length);
    addresses.push({ id: a.id, address: a.address.trim() });
  });
  const rideAddresses = { there: {}, back: {} };
  ['there', 'back'].forEach((leg) => {
    Object.entries(rideAddressDraft[leg]).forEach(([w, i]) => {
      if (indexMap.has(i)) rideAddresses[leg][w] = indexMap.get(i);
    });
  });

  const btn = document.getElementById('saveMyAddressesBtn');
  btn.disabled = true;
  try {
    const data = await api(`/api/carpools/${encodeURIComponent(code)}/members/${identity.id}/addresses`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id, addresses, rideAddresses }),
    });
    carpool = data.carpool;
    dismissMyAddressesOverlay();
    renderAll();
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Owner: edit carpool/activity details overlay ----

function openDetailsOverlay() {
  document.getElementById('detailsCarpoolName').value = carpool.name || '';
  document.getElementById('detailsActivityName').value = carpool.activityName || '';
  document.getElementById('detailsActivityLocation').value = carpool.activityLocation || '';
  showError(document.getElementById('detailsError'), '');
  document.getElementById('detailsOverlay').classList.remove('hidden');
  lockBodyScroll();
}

function dismissDetailsOverlay() {
  document.getElementById('detailsOverlay').classList.add('hidden');
  unlockBodyScroll();
}

document.getElementById('editDetailsBtn').addEventListener('click', openDetailsOverlay);
document.getElementById('closeDetailsOverlay').addEventListener('click', dismissDetailsOverlay);

document.getElementById('saveDetailsBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('detailsError');
  const name = document.getElementById('detailsCarpoolName').value.trim();
  const activityName = document.getElementById('detailsActivityName').value.trim();
  const activityLocation = document.getElementById('detailsActivityLocation').value.trim();
  if (!name || !activityName || !activityLocation) return showError(errorEl, 'Please fill in all three fields');
  showError(errorEl, '');

  const btn = document.getElementById('saveDetailsBtn');
  btn.disabled = true;
  try {
    carpool = await api(`/api/carpools/${encodeURIComponent(code)}/details`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id, name, activityName, activityLocation }),
    });
    dismissDetailsOverlay();
    renderAll();
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Bottom action bar ----

document.getElementById('homeBtn').addEventListener('click', () => {
  window.location.href = '/';
});

document.getElementById('leaveGroupBtn').addEventListener('click', () => {
  document.getElementById('leaveConfirmText').textContent =
    `You'll be removed from "${carpool.name}" along with any riders you've added. You'd need the join code to come back.`;
  showError(document.getElementById('leaveError'), '');
  document.getElementById('leaveConfirmOverlay').classList.remove('hidden');
  lockBodyScroll();
});

document.getElementById('cancelLeaveBtn').addEventListener('click', () => {
  document.getElementById('leaveConfirmOverlay').classList.add('hidden');
  unlockBodyScroll();
});

document.getElementById('confirmLeaveBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('leaveError');
  showError(errorEl, '');
  try {
    await api(`/api/carpools/${encodeURIComponent(code)}/members/${identity.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: identity.id }),
    });
    sessionStorage.removeItem(`carpool:${code}`);
    window.location.href = '/';
  } catch (err) {
    showError(errorEl, err.message);
  }
});

loadAll();
