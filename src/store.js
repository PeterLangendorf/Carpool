const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'carpool-db';
const DB_KEY = 'db';

function getDbStore() {
  return getStore(STORE_NAME);
}

async function load() {
  const db = await getDbStore().get(DB_KEY, { type: 'json' });
  return db || { carpools: {} };
}

async function save(db) {
  await getDbStore().setJSON(DB_KEY, db);
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Excludes I, O, 0, 1 — characters commonly confused with each other (I/l, O/0).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

async function getCarpool(code) {
  const db = await load();
  const carpool = db.carpools[normalizeCode(code)] || null;
  if (!carpool) return null;
  if (materializeRecurrence(carpool)) await save(db);
  return carpool;
}

function getCarpoolOrThrow(db, code) {
  const carpool = db.carpools[normalizeCode(code)];
  if (!carpool) {
    const err = new Error('Carpool not found');
    err.status = 404;
    throw err;
  }
  return carpool;
}

const TIME_RE = /^\d{2}:\d{2}$/;

function cleanLegTimes(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  if (TIME_RE.test(value.there)) out.there = value.there;
  if (TIME_RE.test(value.back)) out.back = value.back;
  return out;
}

function cleanActivityTimes(times, validDates) {
  const dateSet = new Set(validDates);
  const cleaned = { uniform: {}, perWeekday: {}, perDate: {} };
  if (!times || typeof times !== 'object') return cleaned;

  cleaned.uniform = cleanLegTimes(times.uniform);

  Object.entries(times.perWeekday || {}).forEach(([weekday, legTimes]) => {
    const w = Number(weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) return;
    const clean = cleanLegTimes(legTimes);
    if (clean.there || clean.back) cleaned.perWeekday[w] = clean;
  });

  Object.entries(times.perDate || {}).forEach(([date, legTimes]) => {
    if (!dateSet.has(date)) return;
    const clean = cleanLegTimes(legTimes);
    if (clean.there || clean.back) cleaned.perDate[date] = clean;
  });

  return cleaned;
}

// Resolves the effective {there, back} times for a date, falling back from
// the most specific override (exact date) to the least (uniform for all days).
function resolveActivityTimes(activityTimes, date, weekday) {
  const times = activityTimes || {};
  const perDate = (times.perDate && times.perDate[date]) || {};
  const perWeekday = (times.perWeekday && times.perWeekday[weekday]) || {};
  const uniform = times.uniform || {};
  return {
    there: perDate.there || perWeekday.there || uniform.there || null,
    back: perDate.back || perWeekday.back || uniform.back || null,
  };
}

function cleanRecurrence(recurrence) {
  if (!recurrence || typeof recurrence !== 'object') return null;
  const weekdays = Array.from(
    new Set((recurrence.weekdays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
  ).sort();
  if (!weekdays.length) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recurrence.startDate)) return null;
  const endDate = recurrence.endDate && /^\d{4}-\d{2}-\d{2}$/.test(recurrence.endDate) ? recurrence.endDate : null;
  return { weekdays, startDate: recurrence.startDate, endDate };
}

const MATERIALIZE_MONTHS_AHEAD = 12;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d;
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Keeps a rolling window of a carpool's recurring occurrences materialized
// into `activityDates` so "recur endlessly" never runs out, without needing
// a background job — this runs opportunistically whenever the carpool is read.
// Returns true if it changed anything (caller is responsible for saving).
function materializeRecurrence(carpool) {
  const recurrence = carpool.recurrence;
  if (!recurrence) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toDateKey(today);
  if (recurrence.endDate && recurrence.endDate < todayKey) return false;

  const horizon = new Date(today);
  horizon.setMonth(horizon.getMonth() + MATERIALIZE_MONTHS_AHEAD);
  const horizonKey = recurrence.endDate ? (recurrence.endDate < toDateKey(horizon) ? recurrence.endDate : toDateKey(horizon)) : toDateKey(horizon);

  const rangeStart = recurrence.startDate > todayKey ? recurrence.startDate : todayKey;
  if (rangeStart > horizonKey) return false;

  const existing = new Set(carpool.activityDates || []);
  const excluded = new Set(carpool.recurrenceExcludedDates || []);
  const weekdaySet = new Set(recurrence.weekdays);

  let changed = false;
  let cursor = new Date(rangeStart + 'T00:00:00');
  const end = new Date(horizonKey + 'T00:00:00');
  while (cursor.getTime() <= end.getTime()) {
    const key = toDateKey(cursor);
    if (weekdaySet.has(cursor.getDay()) && !existing.has(key) && !excluded.has(key)) {
      existing.add(key);
      changed = true;
    }
    cursor = addDays(key, 1);
  }

  if (changed) {
    carpool.activityDates = Array.from(existing).sort();
  }
  return changed;
}

function applyActivityDates(carpool, dates, times, recurrence) {
  const cleanedDates = Array.from(new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();

  const recurrenceUnchanged = recurrence === undefined;
  const newRecurrence = recurrenceUnchanged ? carpool.recurrence : cleanRecurrence(recurrence);

  // A freshly set/changed recurrence rule starts with no exclusions — it has
  // no prior materialized occurrences to diff against yet (materializing
  // right after this will fill the whole window in). Only diff previous vs.
  // requested dates when the caller is editing dates under an existing,
  // unchanged rule (e.g. the dashboard's date editor), so manually removed
  // occurrences don't get silently re-added on the next materialization.
  if (newRecurrence && !recurrenceUnchanged) {
    carpool.recurrenceExcludedDates = [];
  } else if (newRecurrence) {
    const dateSet = new Set(cleanedDates);
    const prevExcluded = new Set(carpool.recurrenceExcludedDates || []);
    const weekdaySet = new Set(newRecurrence.weekdays);
    const todayKey = new Date().toISOString().slice(0, 10);
    const horizon = new Date();
    horizon.setMonth(horizon.getMonth() + MATERIALIZE_MONTHS_AHEAD);
    const horizonKey = toDateKey(horizon);
    const rangeStart = newRecurrence.startDate > todayKey ? newRecurrence.startDate : todayKey;
    const rangeEndKey = newRecurrence.endDate && newRecurrence.endDate < horizonKey ? newRecurrence.endDate : horizonKey;

    let cursor = new Date(rangeStart + 'T00:00:00');
    const end = new Date(rangeEndKey + 'T00:00:00');
    while (cursor.getTime() <= end.getTime()) {
      const key = toDateKey(cursor);
      if (weekdaySet.has(cursor.getDay())) {
        if (dateSet.has(key)) prevExcluded.delete(key);
        else prevExcluded.add(key);
      }
      cursor = addDays(key, 1);
    }
    carpool.recurrenceExcludedDates = Array.from(prevExcluded).sort();
  } else {
    carpool.recurrenceExcludedDates = [];
  }

  carpool.activityDates = cleanedDates;
  carpool.activityTimes = cleanActivityTimes(times, cleanedDates);
  carpool.recurrence = newRecurrence;

  materializeRecurrence(carpool);
}

async function setActivityDates(code, dates, times, recurrence) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  applyActivityDates(carpool, dates, times, recurrence);
  await save(db);
  return carpool;
}

function generateChildId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function composeChildName(firstName, lastNameOverride, parentLastName) {
  const lastName = (lastNameOverride || parentLastName || '').trim();
  return `${String(firstName).trim()} ${lastName}`.trim();
}

function buildMember(member) {
  const lastName = (member.lastName || '').trim();
  return {
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: member.name.trim(),
    lastName,
    address: (member.address || '').trim(),
    seats: Number(member.seats),
    canDriveThereDays: Array.from(new Set((member.canDriveThereDays || []).map(Number))).sort(),
    canDriveBackDays: Array.from(new Set((member.canDriveBackDays || []).map(Number))).sort(),
    children: (member.children || []).map((child) => ({
      id: generateChildId(),
      name: composeChildName(child.firstName, child.lastNameOverride, lastName),
      needsRideThereDays: Array.from(new Set((child.needsRideThereDays || []).map(Number))).sort(),
      needsRideBackDays: Array.from(new Set((child.needsRideBackDays || []).map(Number))).sort(),
    })),
  };
}

// Creates a carpool and its first (owner) member in a single load/save round
// trip. Netlify Blobs' default eventual consistency means a create followed
// immediately by a separate read/write against the same key can miss the
// prior write, so anything that must see its own just-created data has to
// happen within one load/save cycle rather than a load(); save(); load()...
// chain across multiple store calls.
async function createCarpoolWithOwner(name, memberInput, activityDatesInput) {
  const db = await load();
  let code;
  do {
    code = generateCode();
  } while (db.carpools[code]);

  const member = buildMember(memberInput);
  const carpool = {
    code,
    name: name && name.trim() ? name.trim() : code,
    createdAt: new Date().toISOString(),
    ownerId: member.id,
    activityDates: [],
    activityTimes: { uniform: {}, perWeekday: {}, perDate: {} },
    recurrence: null,
    recurrenceExcludedDates: [],
    dateOverrides: {},
    members: [member],
  };
  db.carpools[code] = carpool;
  if (activityDatesInput) {
    applyActivityDates(carpool, activityDatesInput.dates, activityDatesInput.times, activityDatesInput.recurrence);
  }
  await save(db);
  return { carpool, member };
}

async function addMember(code, member) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const newMember = buildMember(member);
  carpool.members.push(newMember);
  await save(db);
  return newMember;
}

// Returns the updated carpool, or null if removing the member left it empty
// and the whole carpool (dates, times, recurrence rule and all) was deleted
// rather than left behind as an orphaned, member-less shell.
async function removeMember(code, memberId) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const departing = carpool.members.find((m) => m.id === memberId);
  carpool.members = carpool.members.filter((m) => m.id !== memberId);

  if (carpool.members.length === 0) {
    delete db.carpools[normalizeCode(code)];
    await save(db);
    return null;
  }

  // Drop any per-date exclusions for the departing member's own children so
  // they don't linger as orphaned data now that those children are gone too.
  const departingChildIds = new Set((departing && departing.children ? departing.children : []).map((c) => c.id));
  if (departingChildIds.size) {
    Object.values(carpool.dateOverrides || {}).forEach((override) => {
      override.excludedChildIds = override.excludedChildIds.filter((id) => !departingChildIds.has(id));
    });
  }

  if (carpool.ownerId === memberId) {
    carpool.ownerId = carpool.members[0] ? carpool.members[0].id : null;
  }
  await save(db);
  return carpool;
}

function findOwnMember(carpool, memberId, requesterId) {
  if (memberId !== requesterId) {
    const err = new Error('You can only manage your own children');
    err.status = 403;
    throw err;
  }
  const member = carpool.members.find((m) => m.id === memberId);
  if (!member) {
    const err = new Error('Member not found');
    err.status = 404;
    throw err;
  }
  return member;
}

async function addChild(code, memberId, requesterId, child) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const member = findOwnMember(carpool, memberId, requesterId);

  const newChild = {
    id: generateChildId(),
    name: composeChildName(child.firstName, child.lastNameOverride, member.lastName),
    needsRideThereDays: Array.from(new Set((child.needsRideThereDays || []).map(Number))).sort(),
    needsRideBackDays: Array.from(new Set((child.needsRideBackDays || []).map(Number))).sort(),
  };
  member.children = member.children || [];
  member.children.push(newChild);
  await save(db);
  return { child: newChild, carpool };
}

async function updateChild(code, memberId, requesterId, childId, updates) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const member = findOwnMember(carpool, memberId, requesterId);
  const child = (member.children || []).find((c) => c.id === childId);
  if (!child) {
    const err = new Error('Child not found');
    err.status = 404;
    throw err;
  }
  if (updates.firstName !== undefined || updates.lastNameOverride !== undefined) {
    child.name = composeChildName(
      updates.firstName !== undefined ? updates.firstName : child.name.split(' ')[0],
      updates.lastNameOverride,
      member.lastName
    );
  }
  if (updates.needsRideThereDays !== undefined) {
    child.needsRideThereDays = Array.from(new Set(updates.needsRideThereDays.map(Number))).sort();
  }
  if (updates.needsRideBackDays !== undefined) {
    child.needsRideBackDays = Array.from(new Set(updates.needsRideBackDays.map(Number))).sort();
  }
  await save(db);
  return { child, carpool };
}

async function removeChild(code, memberId, requesterId, childId) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const member = findOwnMember(carpool, memberId, requesterId);
  member.children = (member.children || []).filter((c) => c.id !== childId);
  // Drop any per-date exclusion pointing at this child so it doesn't linger
  // as orphaned data once the child no longer exists.
  Object.values(carpool.dateOverrides || {}).forEach((override) => {
    const idx = override.excludedChildIds.indexOf(childId);
    if (idx !== -1) override.excludedChildIds.splice(idx, 1);
  });
  await save(db);
  return { member, carpool };
}

async function setChildExclusion(code, date, requesterId, childId, excluded) {
  const db = await load();
  const carpool = getCarpoolOrThrow(db, code);
  const parent = carpool.members.find((m) => (m.children || []).some((c) => c.id === childId));
  if (!parent || parent.id !== requesterId) {
    const err = new Error('You can only manage your own children');
    err.status = 403;
    throw err;
  }
  if (!carpool.dateOverrides) carpool.dateOverrides = {};
  if (!carpool.dateOverrides[date]) carpool.dateOverrides[date] = { excludedChildIds: [] };
  const list = carpool.dateOverrides[date].excludedChildIds;
  const idx = list.indexOf(childId);
  if (excluded && idx === -1) list.push(childId);
  if (!excluded && idx !== -1) list.splice(idx, 1);
  await save(db);
  return carpool;
}

module.exports = {
  getCarpool,
  createCarpoolWithOwner,
  addMember,
  removeMember,
  addChild,
  updateChild,
  removeChild,
  normalizeCode,
  setActivityDates,
  setChildExclusion,
  resolveActivityTimes,
  cleanRecurrence,
};
