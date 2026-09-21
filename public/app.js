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

function renderDayPicker(container) {
  container.innerHTML = '';
  DAY_ORDER.forEach((value) => {
    const wrap = document.createElement('label');
    wrap.className = 'day-chip';
    wrap.innerHTML = `<input type="checkbox" value="${value}" /><span>${DAY_LABELS[value]}</span>`;
    container.appendChild(wrap);
  });
}

function getCheckedDays(container) {
  return Array.from(container.querySelectorAll('input:checked')).map((el) => Number(el.value));
}

// ---- Leg-day-picker: one row per active weekday, with There/Back checkboxes ----

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
    const thereLabel = times && times.there ? `There · ${formatTimeShort(times.there)}` : 'There';
    const backLabel = times && times.back ? `Back · ${formatTimeShort(times.back)}` : 'Back';
    const thereChecked = selThere.has(w);
    const backChecked = selBack.has(w);
    const row = document.createElement('div');
    row.className = 'leg-day-row';
    row.innerHTML = `
      <div class="leg-day-name">${FULL_DAY_LABELS[w]}</div>
      <div class="leg-day-checks">
        <label class="leg-check"><input type="checkbox" data-leg="there" data-weekday="${w}" ${thereChecked ? 'checked' : ''} /><span>${thereLabel}</span></label>
        <label class="leg-check"><input type="checkbox" data-leg="back" data-weekday="${w}" ${backChecked ? 'checked' : ''} /><span>${backLabel}</span></label>
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

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
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

function renderCalendarHeaderInto(container) {
  container.innerHTML = '';
  DAY_ORDER.forEach((d) => {
    const el = document.createElement('span');
    el.textContent = DAY_LABELS[d];
    container.appendChild(el);
  });
}

let childRowCounter = 0;

// One "same last name as mine" checkbox governs an entire child-list (rather
// than one per child) — a new row starts with its last-name field hidden or
// shown to match whatever that shared checkbox currently says.
function isSameLastNameChecked(key) {
  const checkbox = document.querySelector(`[data-same-lastname="${key}"]`);
  return checkbox ? checkbox.checked : true;
}

function addChildRow(container, key) {
  const row = document.createElement('div');
  row.className = 'child-row';
  const uid = childRowCounter++;
  const nameFieldId = `child-first-name-${uid}`;
  const lastNameFieldId = `child-last-name-${uid}`;
  const hideLastName = isSameLastNameChecked(key);
  row.innerHTML = `
    <div class="child-row-main">
      <input type="text" class="child-name-input" id="${nameFieldId}" name="${nameFieldId}" placeholder="Child's first name" autocomplete="off" autocapitalize="words" />
      <button type="button" class="remove-child-btn" aria-label="Remove child">×</button>
    </div>
    <input type="text" class="child-lastname-input${hideLastName ? ' hidden' : ''}" id="${lastNameFieldId}" name="${lastNameFieldId}" placeholder="Child's last name" autocomplete="off" autocapitalize="words" />
  `;
  row.querySelector('.remove-child-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function getChildEntries(container) {
  return Array.from(container.querySelectorAll('.child-row'))
    .map((row) => {
      const firstName = row.querySelector('.child-name-input').value.trim();
      const lastNameOverride = row.querySelector('.child-lastname-input').value.trim();
      return { firstName, lastNameOverride };
    })
    .filter((c) => c.firstName);
}

document.querySelectorAll('[data-add-child]').forEach((btn) => {
  const key = btn.dataset.addChild;
  const container = document.querySelector(`[data-childlist="${key}"]`);
  addChildRow(container, key); // start each list with one visible row
  btn.addEventListener('click', () => addChildRow(container, key));
});

document.querySelectorAll('[data-same-lastname]').forEach((checkbox) => {
  checkbox.addEventListener('change', () => {
    const key = checkbox.dataset.sameLastname;
    document.querySelectorAll(`[data-childlist="${key}"] .child-lastname-input`).forEach((input) => {
      input.classList.toggle('hidden', checkbox.checked);
      if (checkbox.checked) input.value = '';
    });
  });
});

function showError(el, message) {
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function saveIdentity(code, member) {
  sessionStorage.setItem(
    `carpool:${code}`,
    JSON.stringify({ id: member.id, name: member.name })
  );
}

const HISTORY_KEY = 'carpool:history';

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function rememberCarpool(code, carpoolName) {
  const history = getHistory().filter((h) => h.code !== code);
  history.unshift({ code, name: carpoolName });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function renderHistory() {
  const card = document.getElementById('recentCarpoolsCard');
  const list = document.getElementById('recentCarpoolsList');
  const history = getHistory();
  card.classList.toggle('hidden', history.length === 0);
  list.innerHTML = '';
  history.forEach((h) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-btn';
    btn.innerHTML = `<span class="code-badge" style="margin-right:10px;">${h.code}</span>${h.name}`;
    btn.addEventListener('click', () => goToDashboard(h.code));
    list.appendChild(btn);
  });
}

function goToDashboard(code) {
  window.location.href = `/dashboard.html?code=${encodeURIComponent(code)}`;
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
  const original = el.textContent;
  el.textContent = 'Copied!';
  setTimeout(() => {
    el.textContent = restoreText !== undefined ? restoreText : original;
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

document.querySelectorAll('[data-daypicker]').forEach(renderDayPicker);
renderHistory();

// ---- Screen navigation ----
const screens = document.querySelectorAll('.screen');
function showScreen(name) {
  screens.forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== name));
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
});

document.getElementById('goCreateBtn').addEventListener('click', () => showScreen('create-name'));
document.getElementById('goJoinBtn').addEventListener('click', () => showScreen('join-code'));

// ---- Join flow: step 1 (code) ----
let joinedCode = null;
let joinedCarpoolName = null;
let joinedActivityDates = [];
let joinedActivityTimes = { uniform: {}, perWeekday: {}, perDate: {} };
let joinedActiveWeekdays = [];

function joinedTimeResolver(weekday) {
  const date = joinedActivityDates.find((d) => new Date(d + 'T00:00:00').getDay() === weekday) || null;
  return resolveTimes(joinedActivityTimes, date, weekday);
}

async function loadMembersScreen(rawCode) {
  const errorEl = document.getElementById('joinCodeError');
  showError(errorEl, '');

  try {
    const carpool = await api(`/api/carpools/${encodeURIComponent(rawCode)}`);
    joinedCode = carpool.code;
    joinedCarpoolName = carpool.name;
    joinedActivityDates = carpool.activityDates || [];
    joinedActivityTimes = carpool.activityTimes || { uniform: {}, perWeekday: {}, perDate: {} };
    const weekdaySet = new Set(joinedActivityDates.map((d) => new Date(d + 'T00:00:00').getDay()));
    joinedActiveWeekdays = DAY_ORDER.filter((d) => weekdaySet.has(d));
    if (joinedActiveWeekdays.length === 0) joinedActiveWeekdays = DAY_ORDER.slice();

    document.getElementById('joinCarpoolTitle').textContent = carpool.name;
    const list = document.getElementById('joinMemberList');
    list.innerHTML = '';
    if (carpool.members.length === 0) {
      const p = document.createElement('p');
      p.className = 'subtitle';
      p.textContent = 'No members yet — be the first to join!';
      list.appendChild(p);
    }
    carpool.members.forEach((member) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'member-btn';
      btn.textContent = member.name;
      btn.addEventListener('click', () => {
        saveIdentity(joinedCode, member);
        rememberCarpool(joinedCode, joinedCarpoolName);
        goToDashboard(joinedCode);
      });
      list.appendChild(btn);
    });
    showScreen('join-members');
  } catch (err) {
    showScreen('join-code');
    if (rawCode) document.getElementById('joinCode').value = rawCode.toUpperCase();
    showError(errorEl, err.message);
  }
}

document.getElementById('joinCodeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('joinCode').value.trim();
  loadMembersScreen(code);
});

// ---- Join flow: step 3+, a multi-screen wizard (mirrors the create wizard) ----
const joinWizard = {
  firstName: '',
  lastName: '',
  address: '',
  seats: '',
  children: [],
  needsRideThereDays: [],
  needsRideBackDays: [],
  canDriveThereDays: [],
  canDriveBackDays: [],
};

document.getElementById('joinAsNewBtn').addEventListener('click', () => {
  showScreen('join-new-name');
});

document.querySelector('[data-step-form="join-new-name"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('joinNewNameError');
  const firstName = document.getElementById('joinNewFirstName').value.trim();
  const lastName = document.getElementById('joinNewLastName').value.trim();
  if (!firstName || !lastName) return showError(errorEl, 'Please enter your first and last name');
  showError(errorEl, '');
  joinWizard.firstName = firstName;
  joinWizard.lastName = lastName;
  showScreen('join-new-address');
});

document.querySelector('[data-step-form="join-new-address"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('joinNewAddressError');
  const address = document.getElementById('joinNewAddress').value.trim();
  if (!address) return showError(errorEl, 'Please enter your address');
  showError(errorEl, '');
  joinWizard.address = address;
  showScreen('join-new-seats');
});

document.querySelector('[data-step-form="join-new-seats"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('joinNewSeatsError');
  const seats = Number(document.getElementById('joinNewSeats').value);
  if (!Number.isInteger(seats) || seats < 0 || seats > 15) {
    return showError(errorEl, 'Enter a whole number of passengers between 0 and 15');
  }
  showError(errorEl, '');
  joinWizard.seats = seats;
  showScreen('join-new-children');
});

document.querySelector('[data-step-form="join-new-children"]').addEventListener('submit', (e) => {
  e.preventDefault();
  joinWizard.children = getChildEntries(document.querySelector('[data-childlist="joinNew"]'));
  goToJoinDaysStep();
});

function goToJoinDaysStep() {
  if (joinWizard.children.length > 0) {
    renderLegDayPicker(document.getElementById('joinNewRideList'), joinedActiveWeekdays, joinedTimeResolver, {
      thereDays: joinWizard.needsRideThereDays,
      backDays: joinWizard.needsRideBackDays,
    });
    showScreen('join-new-needsride');
  } else {
    renderLegDayPicker(document.getElementById('joinNewDriveList'), joinedActiveWeekdays, joinedTimeResolver, {
      thereDays: joinWizard.canDriveThereDays,
      backDays: joinWizard.canDriveBackDays,
    });
    showScreen('join-new-candrive');
  }
}

document.querySelector('[data-step-form="join-new-needsride"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const { thereDays, backDays } = getLegDaySelection(document.getElementById('joinNewRideList'));
  joinWizard.needsRideThereDays = thereDays;
  joinWizard.needsRideBackDays = backDays;
  renderLegDayPicker(
    document.getElementById('joinNewDriveList'),
    joinedActiveWeekdays,
    joinedTimeResolver,
    { thereDays: joinWizard.canDriveThereDays, backDays: joinWizard.canDriveBackDays }
  );
  showScreen('join-new-candrive');
});

document.getElementById('backFromJoinNeedsRide').addEventListener('click', () => {
  showScreen('join-new-children');
});

document.getElementById('backFromJoinCanDrive').addEventListener('click', () => {
  showScreen(joinWizard.children.length > 0 ? 'join-new-needsride' : 'join-new-children');
});

document.querySelector('[data-step-form="join-new-candrive"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('joinNewCanDriveError');
  const { thereDays, backDays } = getLegDaySelection(document.getElementById('joinNewDriveList'));
  showError(errorEl, '');
  joinWizard.canDriveThereDays = thereDays;
  joinWizard.canDriveBackDays = backDays;

  const children = joinWizard.children.map((c) => ({
    ...c,
    needsRideThereDays: joinWizard.needsRideThereDays,
    needsRideBackDays: joinWizard.needsRideBackDays,
  }));

  try {
    const data = await api(`/api/carpools/${encodeURIComponent(joinedCode)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: joinWizard.firstName,
        lastName: joinWizard.lastName,
        address: joinWizard.address,
        seats: joinWizard.seats,
        canDriveThereDays: joinWizard.canDriveThereDays,
        canDriveBackDays: joinWizard.canDriveBackDays,
        children,
      }),
    });
    saveIdentity(joinedCode, data.member);
    rememberCarpool(joinedCode, joinedCarpoolName);
    goToDashboard(joinedCode);
  } catch (err) {
    showError(errorEl, err.message);
  }
});

// ---- Create flow: multi-screen wizard ----
const wizard = {
  carpoolName: '',
  firstName: '',
  lastName: '',
  address: '',
  seats: '',
  children: [],
  dateMode: null, // 'recurring' | 'specific'
  activityDates: [], // materialized dates for 'specific' mode; empty for 'recurring' (server materializes)
  activeWeekdays: [], // Sun-Sat sorted weekdays the activity is active on
  recurrence: null, // { weekdays, startDate, endDate } | null
  timesMode: null, // 'uniform' | 'different'
  activityTimes: { uniform: {}, perWeekday: {}, perDate: {} },
  lastTimesScreen: null,
  needsRideThereDays: [],
  needsRideBackDays: [],
  canDriveThereDays: [],
  canDriveBackDays: [],
};
let createdCode = null;

function wizardTimeResolver(weekday) {
  const date = wizard.activityDates.find((d) => new Date(d + 'T00:00:00').getDay() === weekday) || null;
  return resolveTimes(wizard.activityTimes, date, weekday);
}

function goToDaysStep() {
  if (wizard.children.length > 0) {
    renderLegDayPicker(document.getElementById('createNeedsRideList'), wizard.activeWeekdays, wizardTimeResolver, {
      thereDays: wizard.needsRideThereDays,
      backDays: wizard.needsRideBackDays,
    });
    showScreen('create-needsride');
  } else {
    renderLegDayPicker(document.getElementById('createCanDriveList'), wizard.activeWeekdays, wizardTimeResolver, {
      thereDays: wizard.canDriveThereDays,
      backDays: wizard.canDriveBackDays,
    });
    showScreen('create-candrive');
  }
}

document.querySelector('[data-step-form="create-name"]').addEventListener('submit', (e) => {
  e.preventDefault();
  wizard.carpoolName = document.getElementById('createCarpoolName').value.trim();
  showScreen('create-yourname');
});

document.querySelector('[data-step-form="create-yourname"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createYourNameError');
  const firstName = document.getElementById('createFirstName').value.trim();
  const lastName = document.getElementById('createLastName').value.trim();
  if (!firstName || !lastName) return showError(errorEl, 'Please enter your first and last name');
  showError(errorEl, '');
  wizard.firstName = firstName;
  wizard.lastName = lastName;
  showScreen('create-address');
});

document.querySelector('[data-step-form="create-address"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createAddressError');
  const address = document.getElementById('createAddress').value.trim();
  if (!address) return showError(errorEl, 'Please enter your address');
  showError(errorEl, '');
  wizard.address = address;
  showScreen('create-seats');
});

document.querySelector('[data-step-form="create-seats"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createSeatsError');
  const seats = Number(document.getElementById('createSeats').value);
  if (!Number.isInteger(seats) || seats < 0 || seats > 15) {
    return showError(errorEl, 'Enter a whole number of passengers between 0 and 15');
  }
  showError(errorEl, '');
  wizard.seats = seats;
  showScreen('create-children');
});

document.querySelector('[data-step-form="create-children"]').addEventListener('submit', (e) => {
  e.preventDefault();
  wizard.children = getChildEntries(document.querySelector('[data-childlist="create"]'));
  showScreen('create-datetype');
});

// ---- Create flow: activity date type ----

document.getElementById('chooseRecurringBtn').addEventListener('click', () => {
  const startInput = document.getElementById('createRecurringStart');
  if (!startInput.value) startInput.value = toDateKey(new Date());
  showScreen('create-dates-recurring');
});

document.getElementById('createRecurringEndless').addEventListener('change', (e) => {
  const endInput = document.getElementById('createRecurringEnd');
  endInput.disabled = e.target.checked;
  if (e.target.checked) endInput.value = '';
});

document.querySelector('[data-step-form="create-dates-recurring"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createRecurringError');
  const weekdays = getCheckedDays(document.querySelector('[data-daypicker="createRecurringWeekdays"]'));
  const startDate = document.getElementById('createRecurringStart').value;
  const endless = document.getElementById('createRecurringEndless').checked;
  const endDate = document.getElementById('createRecurringEnd').value;

  if (weekdays.length === 0) return showError(errorEl, 'Pick at least one weekday');
  if (!startDate) return showError(errorEl, 'Pick a start date');
  if (!endless && !endDate) return showError(errorEl, 'Pick an end date, or check "recurs endlessly"');
  if (!endless && endDate < startDate) return showError(errorEl, 'End date must be on or after the start date');
  showError(errorEl, '');

  wizard.dateMode = 'recurring';
  wizard.recurrence = { weekdays, startDate, endDate: endless ? null : endDate };
  wizard.activityDates = [];
  wizard.activeWeekdays = DAY_ORDER.filter((d) => weekdays.includes(d));
  showScreen('create-timesmode');
});

// ---- Create flow: specific dates calendar ----

const SPECIFIC_MAX_MONTHS_AHEAD = 12;
let specificSelectedDates = new Set();
let specificViewDate = null;

function renderSpecificMonth() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  document.getElementById('specificMonthLabel').textContent = specificViewDate.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  document.getElementById('specificPrevMonth').disabled = specificViewDate.getTime() <= currentMonthStart.getTime();
  const maxMonthStart = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() + SPECIFIC_MAX_MONTHS_AHEAD, 1);
  document.getElementById('specificNextMonth').disabled = specificViewDate.getTime() >= maxMonthStart.getTime();

  renderCalendarHeaderInto(document.getElementById('specificCalendarHeader'));

  const grid = document.getElementById('specificCalendarGrid');
  grid.innerHTML = '';

  const firstWeekday = specificViewDate.getDay(); // Sunday-first grid, no offset needed
  for (let b = 0; b < firstWeekday; b++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-blank';
    grid.appendChild(blank);
  }

  const numDays = daysInMonth(specificViewDate.getFullYear(), specificViewDate.getMonth());
  for (let day = 1; day <= numDays; day++) {
    const date = new Date(specificViewDate.getFullYear(), specificViewDate.getMonth(), day);
    const dateKey = toDateKey(date);
    const isPast = dateKey < todayKey;
    const selected = specificSelectedDates.has(dateKey);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell' + (selected ? ' selected' : '');
    cell.disabled = isPast;
    cell.innerHTML = `<span class="cal-daynum">${day}</span>`;
    if (!isPast) {
      cell.addEventListener('click', () => {
        if (specificSelectedDates.has(dateKey)) specificSelectedDates.delete(dateKey);
        else specificSelectedDates.add(dateKey);
        renderSpecificMonth();
      });
    }
    grid.appendChild(cell);
  }
}

document.getElementById('chooseSpecificBtn').addEventListener('click', () => {
  wizard.dateMode = 'specific';
  if (!specificViewDate) {
    const today = new Date();
    specificViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  renderSpecificMonth();
  showScreen('create-dates-specific');
});

document.getElementById('specificPrevMonth').addEventListener('click', () => {
  specificViewDate = new Date(specificViewDate.getFullYear(), specificViewDate.getMonth() - 1, 1);
  renderSpecificMonth();
});

document.getElementById('specificNextMonth').addEventListener('click', () => {
  specificViewDate = new Date(specificViewDate.getFullYear(), specificViewDate.getMonth() + 1, 1);
  renderSpecificMonth();
});

document.getElementById('specificDatesNextBtn').addEventListener('click', () => {
  const errorEl = document.getElementById('createSpecificError');
  if (specificSelectedDates.size === 0) return showError(errorEl, 'Pick at least one date');
  showError(errorEl, '');

  wizard.activityDates = Array.from(specificSelectedDates).sort();
  const weekdaySet = new Set(wizard.activityDates.map((d) => new Date(d + 'T00:00:00').getDay()));
  wizard.activeWeekdays = DAY_ORDER.filter((d) => weekdaySet.has(d));
  wizard.recurrence = null;
  showScreen('create-timesmode');
});

// ---- Create flow: times mode ----

document.getElementById('chooseSameTimeBtn').addEventListener('click', () => {
  wizard.timesMode = 'uniform';
  showScreen('create-times-uniform');
});

document.getElementById('chooseDifferentTimeBtn').addEventListener('click', () => {
  wizard.timesMode = 'different';
  if (wizard.dateMode === 'recurring') {
    renderPerWeekdayTimesForm();
    showScreen('create-times-perweekday');
  } else {
    renderPerDateTimesList();
    showScreen('create-times-perdate');
  }
});

document.getElementById('backFromTimesMode').addEventListener('click', () => {
  showScreen(wizard.dateMode === 'recurring' ? 'create-dates-recurring' : 'create-dates-specific');
});

document.querySelector('[data-step-form="create-times-uniform"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createUniformTimesError');
  const there = document.getElementById('createUniformThere').value;
  const back = document.getElementById('createUniformBack').value;
  if (!there || !back) return showError(errorEl, 'Enter both a start and end time');
  showError(errorEl, '');
  wizard.activityTimes = { uniform: { there, back }, perWeekday: {}, perDate: {} };
  wizard.lastTimesScreen = 'create-times-uniform';
  goToConfirmStep();
});

// ---- Create flow: per-weekday times (recurring + different) ----

function renderPerWeekdayTimesForm() {
  const list = document.getElementById('perWeekdayTimesList');
  list.innerHTML = '';
  wizard.activeWeekdays.forEach((w) => {
    const existing = (wizard.activityTimes.perWeekday && wizard.activityTimes.perWeekday[w]) || {};
    const row = document.createElement('div');
    row.className = 'child-row';
    row.dataset.weekday = w;
    row.innerHTML = `
      <div class="child-row-main"><strong>${FULL_DAY_LABELS[w]}</strong></div>
      <div class="field">
        <label>Start time (drop-off)</label>
        <input type="time" class="pw-there" value="${existing.there || ''}" />
      </div>
      <div class="field">
        <label>End time (pickup)</label>
        <input type="time" class="pw-back" value="${existing.back || ''}" />
      </div>
    `;
    list.appendChild(row);
  });
}

document.querySelector('[data-step-form="create-times-perweekday"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createPerWeekdayError');
  const perWeekday = {};
  let ok = true;
  document.querySelectorAll('#perWeekdayTimesList .child-row').forEach((row) => {
    const w = Number(row.dataset.weekday);
    const there = row.querySelector('.pw-there').value;
    const back = row.querySelector('.pw-back').value;
    if (!there || !back) ok = false;
    perWeekday[w] = { there, back };
  });
  if (!ok) return showError(errorEl, 'Enter a start and end time for every day');
  showError(errorEl, '');
  wizard.activityTimes = { uniform: {}, perWeekday, perDate: {} };
  wizard.lastTimesScreen = 'create-times-perweekday';
  goToConfirmStep();
});

// ---- Create flow: per-date times (specific + different) ----

let perDateEditingDate = null;

function renderPerDateTimesList() {
  const list = document.getElementById('perDateTimesList');
  list.innerHTML = '';
  document.getElementById('perDateEditorCard').classList.add('hidden');
  wizard.activityDates.forEach((d) => {
    const weekday = new Date(d + 'T00:00:00').getDay();
    const resolved = resolveTimes(wizard.activityTimes, d, weekday);
    const status = resolved.there && resolved.back ? `${formatTimeShort(resolved.there)} / ${formatTimeShort(resolved.back)}` : 'Not set';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-btn';
    btn.textContent = `${FULL_DAY_LABELS[weekday]}, ${formatDateShort(d)} — ${status}`;
    btn.addEventListener('click', () => openPerDateEditor(d));
    list.appendChild(btn);
  });
}

function openPerDateEditor(d) {
  perDateEditingDate = d;
  const weekday = new Date(d + 'T00:00:00').getDay();
  const resolved = resolveTimes(wizard.activityTimes, d, weekday);
  document.getElementById('perDateEditorLabel').textContent = `${FULL_DAY_LABELS[weekday]}, ${formatDateShort(d)}`;
  document.getElementById('perDateThere').value = resolved.there || '';
  document.getElementById('perDateBack').value = resolved.back || '';
  showError(document.getElementById('perDateEditorError'), '');

  const sameWeekdayCount = wizard.activityDates.filter((dd) => new Date(dd + 'T00:00:00').getDay() === weekday).length;
  const weekdayBtn = document.getElementById('perDateSaveWeekday');
  weekdayBtn.textContent = `Save for all ${FULL_DAY_LABELS[weekday]}s`;
  weekdayBtn.classList.toggle('hidden', sameWeekdayCount < 2);
  document.getElementById('perDateSaveAll').classList.toggle('hidden', wizard.activityDates.length < 2);

  const card = document.getElementById('perDateEditorCard');
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function savePerDateTime(scope) {
  const there = document.getElementById('perDateThere').value;
  const back = document.getElementById('perDateBack').value;
  if (!there || !back) return showError(document.getElementById('perDateEditorError'), 'Enter both times');

  const weekday = new Date(perDateEditingDate + 'T00:00:00').getDay();
  if (scope === 'day') {
    wizard.activityTimes.perDate[perDateEditingDate] = { there, back };
  } else if (scope === 'weekday') {
    wizard.activityTimes.perWeekday[weekday] = { there, back };
  } else if (scope === 'all') {
    wizard.activityTimes.uniform = { there, back };
  }
  document.getElementById('perDateEditorCard').classList.add('hidden');
  renderPerDateTimesList();
}

document.getElementById('perDateSaveDay').addEventListener('click', () => savePerDateTime('day'));
document.getElementById('perDateSaveWeekday').addEventListener('click', () => savePerDateTime('weekday'));
document.getElementById('perDateSaveAll').addEventListener('click', () => savePerDateTime('all'));
document.getElementById('perDateCancel').addEventListener('click', () => {
  document.getElementById('perDateEditorCard').classList.add('hidden');
});

document.getElementById('perDateTimesNextBtn').addEventListener('click', () => {
  const errorEl = document.getElementById('createPerDateError');
  const allSet = wizard.activityDates.every((d) => {
    const weekday = new Date(d + 'T00:00:00').getDay();
    const resolved = resolveTimes(wizard.activityTimes, d, weekday);
    return resolved.there && resolved.back;
  });
  if (!allSet) return showError(errorEl, 'Set a time for every date');
  showError(errorEl, '');
  wizard.lastTimesScreen = 'create-times-perdate';
  goToConfirmStep();
});

// ---- Create flow: confirmation screen + "complete" popup ----

function renderWizardSummary() {
  const container = document.getElementById('createSummaryContent');
  const parts = [];
  parts.push(`<h2>${wizard.carpoolName || '(unnamed carpool)'}</h2>`);
  parts.push(
    `<div class="riders"><strong>You:</strong> ${wizard.firstName} ${wizard.lastName} · ${wizard.address} · drives up to ${wizard.seats} passengers</div>`
  );
  if (wizard.children.length) {
    parts.push(`<div class="riders"><strong>Children:</strong> ${wizard.children.map((c) => c.firstName).join(', ')}</div>`);
  }

  let scheduleText;
  if (wizard.dateMode === 'recurring') {
    const dayNames = wizard.activeWeekdays.map((w) => FULL_DAY_LABELS[w]).join(', ');
    const range = wizard.recurrence.endDate
      ? `${formatDateShort(wizard.recurrence.startDate)} through ${formatDateShort(wizard.recurrence.endDate)}`
      : `starting ${formatDateShort(wizard.recurrence.startDate)}, with no end date`;
    scheduleText = `Every ${dayNames}, ${range}`;
  } else {
    scheduleText = `${wizard.activityDates.length} date${wizard.activityDates.length === 1 ? '' : 's'}: ${wizard.activityDates
      .map(formatDateShort)
      .join(', ')}`;
  }
  parts.push(`<div class="riders"><strong>Schedule:</strong> ${scheduleText}</div>`);

  let timesText;
  if (wizard.timesMode === 'uniform') {
    timesText = `${formatTimeShort(wizard.activityTimes.uniform.there)} there / ${formatTimeShort(wizard.activityTimes.uniform.back)} back, every day`;
  } else if (wizard.dateMode === 'recurring') {
    timesText = wizard.activeWeekdays
      .map((w) => {
        const t = wizard.activityTimes.perWeekday[w] || {};
        return `${FULL_DAY_LABELS[w]}: ${t.there ? formatTimeShort(t.there) : '?'} / ${t.back ? formatTimeShort(t.back) : '?'}`;
      })
      .join('; ');
  } else {
    timesText = 'Custom time set for each date';
  }
  parts.push(`<div class="riders"><strong>Times:</strong> ${timesText}</div>`);

  container.innerHTML = parts.join('');
}

function goToConfirmStep() {
  renderWizardSummary();
  showScreen('create-confirm');
}

function showCompletePopupThen(callback) {
  const overlay = document.getElementById('completePopupOverlay');
  overlay.classList.remove('hidden');
  setTimeout(() => {
    overlay.classList.add('hidden');
    callback();
  }, 3000);
}

document.getElementById('confirmBackBtn').addEventListener('click', () => {
  showScreen(wizard.lastTimesScreen);
});

document.getElementById('confirmContinueBtn').addEventListener('click', () => {
  showCompletePopupThen(() => goToDaysStep());
});

// ---- Create flow: ride/driving days (constrained to active weekdays) ----

document.querySelector('[data-step-form="create-needsride"]').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createNeedsRideError');
  const { thereDays, backDays } = getLegDaySelection(document.getElementById('createNeedsRideList'));
  if (thereDays.length === 0 && backDays.length === 0) return showError(errorEl, 'Pick at least one ride');
  showError(errorEl, '');
  wizard.needsRideThereDays = thereDays;
  wizard.needsRideBackDays = backDays;
  renderLegDayPicker(
    document.getElementById('createCanDriveList'),
    wizard.activeWeekdays,
    wizardTimeResolver,
    { thereDays: wizard.canDriveThereDays, backDays: wizard.canDriveBackDays }
  );
  showScreen('create-candrive');
});

document.getElementById('backFromNeedsRide').addEventListener('click', () => {
  showScreen('create-confirm');
});

document.getElementById('backFromCanDrive').addEventListener('click', () => {
  showScreen(wizard.children.length > 0 ? 'create-needsride' : 'create-confirm');
});

document.querySelector('[data-step-form="create-candrive"]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createCanDriveError');
  const { thereDays, backDays } = getLegDaySelection(document.getElementById('createCanDriveList'));
  if (thereDays.length === 0 && backDays.length === 0) return showError(errorEl, 'Pick at least one day/leg you can drive');
  showError(errorEl, '');
  wizard.canDriveThereDays = thereDays;
  wizard.canDriveBackDays = backDays;

  const children = wizard.children.map((c) => ({
    ...c,
    needsRideThereDays: wizard.needsRideThereDays,
    needsRideBackDays: wizard.needsRideBackDays,
  }));

  try {
    const data = await api('/api/carpools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        carpoolName: wizard.carpoolName,
        firstName: wizard.firstName,
        lastName: wizard.lastName,
        address: wizard.address,
        seats: wizard.seats,
        children,
        canDriveThereDays: wizard.canDriveThereDays,
        canDriveBackDays: wizard.canDriveBackDays,
      }),
    });
    createdCode = data.carpool.code;
    saveIdentity(createdCode, data.member);

    await api(`/api/carpools/${encodeURIComponent(createdCode)}/activity-dates`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requesterId: data.member.id,
        dates: wizard.activityDates,
        times: wizard.activityTimes,
        recurrence: wizard.recurrence,
      }),
    });

    rememberCarpool(createdCode, data.carpool.name);
    document.getElementById('createdCode').textContent = createdCode;
    showScreen('create-success');
  } catch (err) {
    showError(errorEl, err.message);
  }
});

document.getElementById('createdCode').addEventListener('click', async () => {
  const el = document.getElementById('createdCode');
  if (await copyTextToClipboard(createdCode)) flashCopiedFeedback(el, createdCode);
});

document.getElementById('continueToDashboardBtn').addEventListener('click', () => {
  goToDashboard(createdCode);
});

// ---- Deep-link support (e.g. a missing/cleared identity, or a recent-carpool tap) ----
const initialParams = new URLSearchParams(window.location.search);
const initialCode = initialParams.get('code');
const initialTab = initialParams.get('tab');

if (initialTab === 'members' && initialCode) {
  showScreen('join-code');
  document.getElementById('joinCode').value = initialCode.toUpperCase();
  loadMembersScreen(initialCode);
} else if (initialTab === 'join' || initialCode) {
  showScreen('join-code');
  if (initialCode) document.getElementById('joinCode').value = initialCode.toUpperCase();
} else {
  showScreen('home');
}
