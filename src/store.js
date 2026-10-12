const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { resolveActivityTimes } = require('../public/activity-times');
const { isValidTimeZone, todayKey, weekdayOf, addMonths, addDays, nextDay } = require('./dates');
const { computeSchedule, historySeed, childNameParts } = require('./normalize');

const STORE_NAME = 'carpool-db';
// Each carpool is its own blob, so saves in different carpools never touch
// the same data. Everything used to live in one blob under LEGACY_DB_KEY
// (see migrateLegacyDb).
const CARPOOL_PREFIX = 'carpools/';
// Each signed-in user's list of carpool codes (see getUserCarpoolCodes).
const USER_PREFIX = 'users/';
// Each signed-in user's notifications (see addNotification).
const INBOX_PREFIX = 'inbox/';
const LEGACY_DB_KEY = 'db';
const MIGRATED_KEY = 'meta/split-into-carpool-blobs';

function carpoolKey(code) {
  return CARPOOL_PREFIX + normalizeCode(code);
}

function userKey(userId) {
  return USER_PREFIX + encodeURIComponent(userId);
}

function inboxKey(userId) {
  return INBOX_PREFIX + encodeURIComponent(userId);
}

// LOCAL_DB_FILE (set by `npm run local`) swaps Netlify Blobs for a plain
// JSON file, so the app can run entirely offline on your own machine. It
// keeps the file's `{ carpools: {...} }` shape (other blobs go under
// `blobs`) and mimics the parts of the Blobs API the store uses, including
// conditional writes (one process and synchronous file I/O, so each
// check-and-write is atomic).
function getFileStore(file) {
  const fs = require('fs');
  const readDb = () => {
    const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    return { carpools: db.carpools || {}, blobs: db.blobs || {} };
  };
  const etagOf = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
  // Where a key lives in the file: [section, name].
  const locate = (key) => (key.startsWith(CARPOOL_PREFIX) ? ['carpools', key.slice(CARPOOL_PREFIX.length)] : ['blobs', key]);
  return {
    async getWithMetadata(key) {
      const [section, name] = locate(key);
      const value = readDb()[section][name];
      return value === undefined ? null : { data: value, etag: etagOf(value), metadata: {} };
    },
    async setJSON(key, value, { onlyIfMatch, onlyIfNew } = {}) {
      const [section, name] = locate(key);
      const db = readDb();
      const current = db[section][name];
      if (onlyIfNew && current !== undefined) return { modified: false };
      if (onlyIfMatch && (current === undefined || etagOf(current) !== onlyIfMatch)) return { modified: false };
      db[section][name] = value;
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
      return { modified: true, etag: etagOf(value) };
    },
    async list({ prefix }) {
      const db = readDb();
      const keys = [...Object.keys(db.carpools).map((code) => CARPOOL_PREFIX + code), ...Object.keys(db.blobs)];
      return { blobs: keys.filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

// Netlify Blobs is eventually consistent by default: a write can take up to a
// minute to show up in reads from other function invocations. That made a
// just-created carpool's dashboard say "Carpool not found", and stale reads
// would make the conditional saves in updateCarpool keep failing. So reads
// here are strongly consistent, which needs the Blobs "uncached edge URL".
//
// Native functions (monthly-email) get it in their Blobs context. The API
// function runs in Lambda compatibility mode, where Netlify sends it in the
// event (`url_uncached`) but connectLambda() drops it — so
// netlify/functions/api.js passes each event here as well.
let lambdaBlobs = null;

function useLambdaBlobsContext(event) {
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    lambdaBlobs = {
      siteID: event.headers['x-nf-site-id'],
      token: data.token,
      edgeURL: data.url,
      uncachedEdgeURL: data.url_uncached,
    };
  } catch {
    lambdaBlobs = null;
  }
}

function nativeContextHasUncachedURL() {
  try {
    const raw = globalThis.netlifyBlobsContext || process.env.NETLIFY_BLOBS_CONTEXT;
    return Boolean(raw && JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).uncachedEdgeURL);
  } catch {
    return false;
  }
}

function getDbStore() {
  if (process.env.LOCAL_DB_FILE) return getFileStore(process.env.LOCAL_DB_FILE);
  if (lambdaBlobs) {
    if (lambdaBlobs.uncachedEdgeURL && lambdaBlobs.siteID && lambdaBlobs.token) {
      return getStore({ name: STORE_NAME, consistency: 'strong', ...lambdaBlobs });
    }
  } else if (nativeContextHasUncachedURL()) {
    return getStore({ name: STORE_NAME, consistency: 'strong' });
  }
  // No uncached URL available: eventual consistency rather than failing every read.
  return getStore(STORE_NAME);
}

// One-time move from the single shared blob to one blob per carpool. Each
// carpool is copied only if it has no blob yet (so an old copy can never
// overwrite a carpool that's been changed since), then a marker records that
// it's done. The old blob is left in place, untouched, as a backup. Safe to
// run in several function instances at once; checked once per warm instance.
let migration = null;

function migrateLegacyDb() {
  if (process.env.LOCAL_DB_FILE) return Promise.resolve();
  if (!migration) {
    migration = (async () => {
      const blobs = getDbStore();
      if (await blobs.get(MIGRATED_KEY)) return;
      const legacy = await blobs.get(LEGACY_DB_KEY, { type: 'json' });
      for (const [code, carpool] of Object.entries((legacy && legacy.carpools) || {})) {
        await blobs.setJSON(carpoolKey(code), carpool, { onlyIfNew: true });
      }
      await blobs.set(MIGRATED_KEY, new Date().toISOString());
    })().catch((err) => {
      migration = null;
      throw err;
    });
  }
  return migration;
}

// A carpool whose last member left is kept as a `{ deleted: true }`
// tombstone rather than removed: Blobs deletes can't be made conditional,
// and the tombstone also stops its code being handed to a new carpool.
function isLive(carpool) {
  return Boolean(carpool && !carpool.deleted);
}

function notFoundError() {
  const err = new Error('Carpool not found');
  err.status = 404;
  return err;
}

const MAX_SAVE_ATTEMPTS = 8;

// Reads the latest copy of one JSON blob, runs `change(doc)` on it, and saves
// only if nobody else saved that blob in between (an ETag check, or "only if
// new" for a blob `create()` started). If someone did, it starts over from
// their version, so simultaneous saves are applied one after the other
// instead of the last one silently undoing the others. That means `change`
// may run more than once: it must only modify the doc it's given, and may
// throw to abort (e.g. a 403). The save is skipped if nothing changed.
// Resolves to whatever `change` returns. A missing blob is a 404 unless
// `create` is given.
async function updateBlob(key, change, { create } = {}) {
  const blobs = getDbStore();
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    const entry = await blobs.getWithMetadata(key, { type: 'json' });
    if (!entry && !create) throw notFoundError();
    const doc = entry ? entry.data : create();
    const before = entry ? JSON.stringify(doc) : null;
    const result = change(doc);
    if (entry && JSON.stringify(doc) === before) return result;
    const { modified } = await blobs.setJSON(key, doc, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (modified) return result;
    // Someone else saved first: wait a moment (with jitter) and redo it on their version.
    await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt * (0.5 + Math.random())));
  }
  const err = new Error('This carpool is busy right now. Please try again.');
  err.status = 503;
  throw err;
}

// The only way carpools are changed: updateBlob on the carpool's blob.
// Throws a 404 for a missing or deleted carpool.
async function updateCarpool(code, change) {
  await migrateLegacyDb();
  return updateBlob(carpoolKey(code), (carpool) => {
    if (!isLive(carpool)) throw notFoundError();
    return change(carpool);
  });
}

// ---- Each user's carpool list ----
// `users/<userId>` holds `{ codes, complete }`: the codes of the carpools a
// user is in, so their "Carpools" list doesn't have to read every carpool.
// It's only `complete` once built from a full scan (getUserCarpools in
// src/auth.js does that the first time). Codes are added before the user
// joins and removed after they leave, so it never misses a carpool; a
// leftover code (a join that failed, a request still waiting) is harmless,
// since readers check membership.

async function addUserCarpool(userId, code) {
  if (!userId) return;
  await updateBlob(
    userKey(userId),
    (index) => {
      const c = normalizeCode(code);
      if (!index.codes.includes(c)) index.codes.push(c);
    },
    { create: () => ({ codes: [], complete: false }) }
  );
}

async function removeUserCarpool(userId, code) {
  if (!userId) return;
  try {
    await updateBlob(userKey(userId), (index) => {
      index.codes = index.codes.filter((c) => c !== normalizeCode(code));
    });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// The user's carpool codes, or null if their list hasn't been built yet.
async function getUserCarpoolCodes(userId) {
  const entry = await getDbStore().getWithMetadata(userKey(userId), { type: 'json' });
  return entry && entry.data.complete ? entry.data.codes : null;
}

// Records the result of a full scan: the list is complete from now on.
async function setUserCarpoolCodes(userId, codes) {
  await updateBlob(
    userKey(userId),
    (index) => {
      codes.map(normalizeCode).forEach((c) => {
        if (!index.codes.includes(c)) index.codes.push(c);
      });
      index.complete = true;
    },
    { create: () => ({ codes: [], complete: false }) }
  );
}

// ---- Notifications ----
// `inbox/<userId>` holds `{ items }`, newest first, at most MAX_NOTIFICATIONS.
// Kept per user rather than per carpool so someone waiting to join (not a
// member yet) can be told they were approved or declined. See
// src/notifications.js for what's sent when.
const MAX_NOTIFICATIONS = 50;

// `notification`: { type, text, carpoolCode, carpoolName, link }.
async function addNotification(userId, notification) {
  if (!userId) return;
  await updateBlob(
    inboxKey(userId),
    (inbox) => {
      inbox.items.unshift({
        id: 'n_' + crypto.randomBytes(8).toString('hex'),
        createdAt: new Date().toISOString(),
        read: false,
        ...notification,
      });
      inbox.items = inbox.items.slice(0, MAX_NOTIFICATIONS);
    },
    { create: () => ({ items: [] }) }
  );
}

async function getNotifications(userId) {
  const entry = await getDbStore().getWithMetadata(inboxKey(userId), { type: 'json' });
  return entry ? entry.data.items : [];
}

// Marks the given notifications (or all of them) read.
async function markNotificationsRead(userId, ids) {
  try {
    await updateBlob(inboxKey(userId), (inbox) => {
      inbox.items.forEach((n) => {
        if (!ids || ids.includes(n.id)) n.read = true;
      });
    });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// The carpools with these codes (refreshed like getCarpool), skipping any
// that no longer exist.
async function getCarpools(codes) {
  const carpools = await Promise.all(codes.map((code) => getCarpool(code)));
  return carpools.filter(Boolean);
}

// Runs updateCarpool on every carpool that `filter` keeps, a few at a time,
// skipping any deleted along the way. Resolves to `change`'s results.
async function updateAllCarpools(change, filter = () => true) {
  await migrateLegacyDb();
  const { blobs } = await getDbStore().list({ prefix: CARPOOL_PREFIX });
  const codes = blobs.map((b) => b.key.slice(CARPOOL_PREFIX.length));
  const results = [];
  const BATCH_SIZE = 10;
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = await Promise.all(
      codes.slice(i, i + BATCH_SIZE).map((code) =>
        updateCarpool(code, (carpool) => (filter(carpool) ? { value: change(carpool) } : null)).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        })
      )
    );
    batch.forEach((r) => r && results.push(r.value));
  }
  return results;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Excludes I, O, 0, 1 — characters commonly confused with each other (I/l, O/0).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// A join code is all it takes to ask to join, so it comes from a
// cryptographic random source rather than Math.random (whose output can be
// predicted from earlier values).
function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

// Upkeep run whenever a carpool is read: rolls recurring dates forward,
// records drives on dates that have passed and locks in the coming week.
function refreshCarpool(carpool) {
  materializeRecurrence(carpool);
  recordPastDrives(carpool);
  lockUpcomingDrives(carpool);
  return carpool;
}

// How many days ahead (from today) drivers are locked in.
const LOCK_DAYS = 7;

// Locks the drivers of every date in the coming week, so a family joining,
// someone changing their days or a rider marked absent can't hand a ride
// that's only days away to someone else. A locked ride only changes when
// someone says they can't make it or volunteers (setRideOverride), or when
// its drivers no longer have enough seats, in which case the fairest of the
// others are added. Anyone added is locked in too.
function lockUpcomingDrives(carpool) {
  const today = todayKey(carpool.timeZone);
  const until = addDays(today, LOCK_DAYS);
  const { schedule } = computeSchedule(carpool, today);
  schedule
    .filter((entry) => entry.date < until)
    .forEach((entry) => {
      if (!carpool.lockedDrives) carpool.lockedDrives = {};
      const lock = carpool.lockedDrives[entry.date] || { there: [], back: [] };
      ['there', 'back'].forEach((leg) => {
        entry[leg].drivers.forEach((d) => {
          if (!lock[leg].includes(d.id)) lock[leg].push(d.id);
        });
      });
      carpool.lockedDrives[entry.date] = lock;
    });
}

// Saves who drove each date once it's in the past, so the schedule carries on
// from what actually happened instead of everyone starting from zero again
// at today, which reshuffled future drives whenever a date went by. Recording
// starts the first time a carpool is read (`driveHistory.since`); older
// dates are never back-filled, since today's members and riders may not
// match who was in the carpool then.
function recordPastDrives(carpool) {
  const today = todayKey(carpool.timeZone);
  if (!carpool.driveHistory) {
    carpool.driveHistory = { since: today, dates: {} };
    return;
  }
  computeSchedule(carpool, today).past.forEach((entry) => {
    carpool.driveHistory.dates[entry.date] = {
      there: entry.there.drivers.map((d) => d.id),
      back: entry.back.drivers.map((d) => d.id),
    };
  });
  Object.keys(carpool.lockedDrives || {}).forEach((date) => {
    if (date < today) delete carpool.lockedDrives[date];
  });
}

// Rolls recurring dates forward and records past drives (saving if that
// changed anything). A carpool without a time zone yet takes `timeZone` (the
// requester's browser zone) if it's a valid one.
async function getCarpool(code, { timeZone } = {}) {
  try {
    return await updateCarpool(code, (carpool) => {
      if (!carpool.timeZone && isValidTimeZone(timeZone)) carpool.timeZone = timeZone;
      return refreshCarpool(carpool);
    });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
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

// Keeps a rolling window of a carpool's recurring occurrences materialized
// into `activityDates` so "recur endlessly" never runs out, without needing
// a background job — this runs opportunistically whenever the carpool is read.
// Returns true if it changed anything (caller is responsible for saving).
function materializeRecurrence(carpool) {
  const recurrence = carpool.recurrence;
  if (!recurrence) return false;

  const today = todayKey(carpool.timeZone);
  if (recurrence.endDate && recurrence.endDate < today) return false;

  const horizon = addMonths(today, MATERIALIZE_MONTHS_AHEAD);
  const horizonKey = recurrence.endDate && recurrence.endDate < horizon ? recurrence.endDate : horizon;

  const rangeStart = recurrence.startDate > today ? recurrence.startDate : today;
  if (rangeStart > horizonKey) return false;

  const existing = new Set(carpool.activityDates || []);
  const excluded = new Set(carpool.recurrenceExcludedDates || []);
  const weekdaySet = new Set(recurrence.weekdays);

  let changed = false;
  for (let key = rangeStart; key <= horizonKey; key = nextDay(key)) {
    if (weekdaySet.has(weekdayOf(key)) && !existing.has(key) && !excluded.has(key)) {
      existing.add(key);
      changed = true;
    }
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
    const today = todayKey(carpool.timeZone);
    const horizonKey = addMonths(today, MATERIALIZE_MONTHS_AHEAD);
    const rangeStart = newRecurrence.startDate > today ? newRecurrence.startDate : today;
    const rangeEndKey = newRecurrence.endDate && newRecurrence.endDate < horizonKey ? newRecurrence.endDate : horizonKey;

    for (let key = rangeStart; key <= rangeEndKey; key = nextDay(key)) {
      if (weekdaySet.has(weekdayOf(key))) {
        if (dateSet.has(key)) prevExcluded.delete(key);
        else prevExcluded.add(key);
      }
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
  return updateCarpool(code, (carpool) => {
    applyActivityDates(carpool, dates, times, recurrence);
    return carpool;
  });
}

function generateChildId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function composeChildName(firstName, lastNameOverride, parentLastName) {
  const lastName = (lastNameOverride || parentLastName || '').trim();
  return `${String(firstName).trim()} ${lastName}`.trim();
}

// A rider as stored: the parts of their name are kept as well as the full
// name, so editing one part can't mangle the other.
function buildChild(child, parentLastName) {
  const firstName = String(child.firstName).trim();
  const lastNameOverride = (child.lastNameOverride || '').trim();
  return {
    id: generateChildId(),
    name: composeChildName(firstName, lastNameOverride, parentLastName),
    firstName,
    lastNameOverride,
    needsRideThereDays: Array.from(new Set((child.needsRideThereDays || []).map(Number))).sort(),
    needsRideBackDays: Array.from(new Set((child.needsRideBackDays || []).map(Number))).sort(),
  };
}

// Secret per-member token for email unsubscribe links. Member IDs alone
// aren't enough — every member of the carpool can see them.
function generateUnsubscribeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generateAddressId() {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function buildMember(member) {
  const lastName = (member.lastName || '').trim();
  // `verified`: picked from the map suggestions (see src/app.js parseAddresses).
  const addresses = (member.addresses || []).map((a) => {
    const entry = typeof a === 'string' ? { address: a } : a;
    return { id: generateAddressId(), address: String(entry.address).trim(), ...(entry.verified ? { verified: true } : {}) };
  });
  // Input ride addresses reference addresses by position in the submitted
  // list; store them by ID so later edits to the list can't shift them.
  const rideAddresses = { there: {}, back: {} };
  ['there', 'back'].forEach((leg) => {
    Object.entries((member.rideAddresses && member.rideAddresses[leg]) || {}).forEach(([weekday, index]) => {
      if (addresses[index]) rideAddresses[leg][weekday] = addresses[index].id;
    });
  });
  return {
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    // The Clerk user this member belongs to (see src/auth.js).
    userId: member.userId || null,
    name: member.name.trim(),
    lastName,
    email: (member.email || '').trim(),
    unsubscribeToken: generateUnsubscribeToken(),
    // Kept alongside `addresses` (as the first one) for older readers of the blob.
    address: addresses[0] ? addresses[0].address : '',
    addresses,
    rideAddresses,
    seats: Number(member.seats),
    canDriveThereDays: Array.from(new Set((member.canDriveThereDays || []).map(Number))).sort(),
    canDriveBackDays: Array.from(new Set((member.canDriveBackDays || []).map(Number))).sort(),
    children: (member.children || []).map((child) => buildChild(child, lastName)),
  };
}

// Creates a carpool and its first (owner) member in one write, which only
// succeeds if no blob exists for the code yet (so two creates can't land on
// the same code); on a clash it tries another code. `details.timeZone` is the
// creator's browser time zone.
async function createCarpoolWithOwner(details, memberInput, activityDatesInput) {
  await migrateLegacyDb();
  const blobs = getDbStore();
  for (;;) {
    const code = generateCode();
    await addUserCarpool(memberInput.userId, code);
    const member = buildMember(memberInput);
    const carpool = {
      code,
      name: details.name && details.name.trim() ? details.name.trim() : code,
      activityName: (details.activityName || '').trim(),
      activityLocation: (details.activityLocation || '').trim(),
      activityLocationVerified: Boolean(details.activityLocationVerified),
      createdAt: new Date().toISOString(),
      timeZone: isValidTimeZone(details.timeZone) ? details.timeZone : null,
      joinRequests: [],
      ownerId: member.id,
      activityDates: [],
      activityTimes: { uniform: {}, perWeekday: {}, perDate: {} },
      recurrence: null,
      recurrenceExcludedDates: [],
      dateOverrides: {},
      members: [member],
    };
    carpool.driveHistory = { since: todayKey(carpool.timeZone), dates: {} };
    if (activityDatesInput) {
      applyActivityDates(carpool, activityDatesInput.dates, activityDatesInput.times, activityDatesInput.recurrence);
    }
    const { modified } = await blobs.setJSON(carpoolKey(code), carpool, { onlyIfNew: true });
    if (modified) return { carpool, member };
  }
}

// Adds a member to a carpool, starting level with the others: a member
// joining later gets the carpool's average drive count so far, rather than
// zero, which would have them drive every time until they'd caught up with
// drives done before they joined.
function admitMember(carpool, newMember) {
  refreshCarpool(carpool);
  const { counts } = historySeed(carpool);
  const average = carpool.members.reduce((sum, m) => sum + (counts[m.id] || 0), 0) / carpool.members.length;
  if (average >= 1) newMember.driveCredit = Math.round(average);
  else delete newMember.driveCredit;
  carpool.members.push(newMember);
}

// Asks to join a carpool: knowing the code isn't enough, so the member waits
// in `joinRequests` until the organizer approves (approveJoinRequest) or
// declines them. Asking again replaces an earlier request. Resolves to
// { member, carpool }.
async function addMember(code, member) {
  await addUserCarpool(member.userId, code);
  return updateCarpool(code, (carpool) => {
    if (member.userId && carpool.members.some((m) => m.userId === member.userId)) {
      const err = new Error("You're already in this carpool");
      err.status = 409;
      throw err;
    }
    const newMember = buildMember(member);
    carpool.joinRequests = (carpool.joinRequests || []).filter((r) => !member.userId || r.userId !== member.userId);
    carpool.joinRequests.push({ ...newMember, requestedAt: new Date().toISOString() });
    return { member: newMember, carpool };
  });
}

function findJoinRequest(carpool, memberId) {
  const request = (carpool.joinRequests || []).find((r) => r.id === memberId);
  if (!request) {
    const err = new Error('That request has already been answered');
    err.status = 404;
    throw err;
  }
  return request;
}

// Organizer only (checked by the route). Resolves to { member, carpool }.
async function approveJoinRequest(code, memberId) {
  return updateCarpool(code, (carpool) => {
    const { requestedAt, ...member } = findJoinRequest(carpool, memberId);
    carpool.joinRequests = carpool.joinRequests.filter((r) => r.id !== memberId);
    if (member.userId && carpool.members.some((m) => m.userId === member.userId)) return { member: null, carpool };
    admitMember(carpool, member);
    return { member, carpool, requestedAt };
  });
}

// Organizer only (checked by the route). Resolves to the declined request.
async function declineJoinRequest(code, memberId) {
  let declined = null;
  const carpool = await updateCarpool(code, (c) => {
    declined = findJoinRequest(c, memberId);
    c.joinRequests = c.joinRequests.filter((r) => r.id !== memberId);
    return c;
  });
  if (declined) await removeUserCarpool(declined.userId, code);
  return { request: declined, carpool };
}

// The signed-in user's waiting request to join, if any.
function findPendingRequest(carpool, userId) {
  return (carpool.joinRequests || []).find((r) => r.userId === userId) || null;
}

// Marks a member unable to make one ride (`can: false`) or not (`can: true`),
// or adds/removes them as a volunteer for it. Saying you can't make a ride
// also withdraws any offer to drive it and releases it if it was locked to
// you; withdrawing an offer releases it too. Only today onwards.
async function setRideOverride(code, date, leg, memberId, { unavailable, volunteer }) {
  return updateCarpool(code, (carpool) => {
    if (!(carpool.activityDates || []).includes(date) || date < todayKey(carpool.timeZone)) {
      const err = new Error('That date is not coming up in this carpool');
      err.status = 400;
      throw err;
    }
    const member = carpool.members.find((m) => m.id === memberId);
    if (volunteer && !(member && Number(member.seats) > 0)) {
      const err = new Error('You need at least one seat to drive');
      err.status = 400;
      throw err;
    }
    if (!carpool.dateOverrides) carpool.dateOverrides = {};
    const override = carpool.dateOverrides[date] || { excludedChildIds: [] };
    carpool.dateOverrides[date] = override;
    const listFor = (field) => {
      if (!override[field]) override[field] = { there: [], back: [] };
      if (!override[field][leg]) override[field][leg] = [];
      return override[field][leg];
    };
    const setIn = (list, on) => {
      const i = list.indexOf(memberId);
      if (on && i === -1) list.push(memberId);
      if (!on && i !== -1) list.splice(i, 1);
    };
    const release = () => {
      const lock = carpool.lockedDrives && carpool.lockedDrives[date];
      if (lock && lock[leg]) lock[leg] = lock[leg].filter((id) => id !== memberId);
    };
    if (unavailable !== undefined) {
      setIn(listFor('unavailableDriverIds'), unavailable);
      if (unavailable) {
        setIn(listFor('volunteers'), false);
        release();
      }
    }
    if (volunteer !== undefined) {
      setIn(listFor('volunteers'), volunteer);
      if (volunteer) setIn(listFor('unavailableDriverIds'), false);
      else release();
    }
    return carpool;
  });
}

// Returns the updated carpool, or null if removing the member left it empty
// and the whole carpool (dates, times, recurrence rule and all) was deleted
// (replaced by a tombstone, see isLive) rather than left behind as an
// orphaned, member-less shell.
async function removeMember(code, memberId) {
  let departingUserId = null;
  const result = await updateCarpool(code, (carpool) => {
    const departing = carpool.members.find((m) => m.id === memberId);
    departingUserId = departing ? departing.userId : null;
    carpool.members = carpool.members.filter((m) => m.id !== memberId);

    if (carpool.members.length === 0) {
      const carpoolCode = carpool.code;
      Object.keys(carpool).forEach((key) => delete carpool[key]);
      Object.assign(carpool, { code: carpoolCode, deleted: true, deletedAt: new Date().toISOString() });
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
    return carpool;
  });
  await removeUserCarpool(departingUserId, code);
  return result;
}

function findOwnMember(carpool, memberId, requesterId) {
  if (memberId !== requesterId) {
    const err = new Error('You can only manage your own riders');
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
  return updateCarpool(code, (carpool) => {
    const member = findOwnMember(carpool, memberId, requesterId);

    const newChild = buildChild(child, member.lastName);
    member.children = member.children || [];
    member.children.push(newChild);
    return { child: newChild, carpool };
  });
}

async function updateChild(code, memberId, requesterId, childId, updates) {
  return updateCarpool(code, (carpool) => {
    const member = findOwnMember(carpool, memberId, requesterId);
    const child = (member.children || []).find((c) => c.id === childId);
    if (!child) {
      const err = new Error('Rider not found');
      err.status = 404;
      throw err;
    }
    if (updates.firstName !== undefined || updates.lastNameOverride !== undefined) {
      // Whichever part isn't being changed keeps its current value.
      const current = childNameParts(child, member.lastName);
      child.firstName = updates.firstName !== undefined ? updates.firstName : current.firstName;
      child.lastNameOverride = updates.lastNameOverride !== undefined ? updates.lastNameOverride : current.lastNameOverride;
      child.name = composeChildName(child.firstName, child.lastNameOverride, member.lastName);
    }
    if (updates.needsRideThereDays !== undefined) {
      child.needsRideThereDays = Array.from(new Set(updates.needsRideThereDays.map(Number))).sort();
    }
    if (updates.needsRideBackDays !== undefined) {
      child.needsRideBackDays = Array.from(new Set(updates.needsRideBackDays.map(Number))).sort();
    }
    return { child, carpool };
  });
}

async function removeChild(code, memberId, requesterId, childId) {
  return updateCarpool(code, (carpool) => {
    const member = findOwnMember(carpool, memberId, requesterId);
    member.children = (member.children || []).filter((c) => c.id !== childId);
    // Drop any per-date exclusion pointing at this child so it doesn't linger
    // as orphaned data once the child no longer exists.
    Object.values(carpool.dateOverrides || {}).forEach((override) => {
      const idx = override.excludedChildIds.indexOf(childId);
      if (idx !== -1) override.excludedChildIds.splice(idx, 1);
    });
    return { member, carpool };
  });
}

async function setChildExclusion(code, date, requesterId, childId, excluded) {
  return updateCarpool(code, (carpool) => {
    const parent = carpool.members.find((m) => (m.children || []).some((c) => c.id === childId));
    if (!parent || parent.id !== requesterId) {
      const err = new Error('You can only manage your own riders');
      err.status = 403;
      throw err;
    }
    if (!carpool.dateOverrides) carpool.dateOverrides = {};
    if (!carpool.dateOverrides[date]) carpool.dateOverrides[date] = { excludedChildIds: [] };
    const list = carpool.dateOverrides[date].excludedChildIds;
    const idx = list.indexOf(childId);
    if (excluded && idx === -1) list.push(childId);
    if (!excluded && idx !== -1) list.splice(idx, 1);
    return carpool;
  });
}

async function updateCarpoolDetails(code, details) {
  return updateCarpool(code, (carpool) => {
    ['name', 'activityName', 'activityLocation'].forEach((key) => {
      if (details[key] !== undefined) carpool[key] = String(details[key]).trim();
    });
    if (details.monthlyEmail !== undefined) carpool.monthlyEmail = Boolean(details.monthlyEmail);
    if (details.activityLocationVerified !== undefined) carpool.activityLocationVerified = Boolean(details.activityLocationVerified);
    return carpool;
  });
}

// Replaces a member's address list. Entries that carry an existing address
// ID keep it; new entries get a fresh ID. `rideAddresses` is in the same
// index-based shape buildMember accepts.
async function setMemberAddresses(code, memberId, requesterId, addresses, rideAddresses) {
  return updateCarpool(code, (carpool) => {
    if (memberId !== requesterId) {
      const err = new Error('You can only edit your own addresses');
      err.status = 403;
      throw err;
    }
    const member = carpool.members.find((m) => m.id === memberId);
    if (!member) {
      const err = new Error('Member not found');
      err.status = 404;
      throw err;
    }
    if ((member.children || []).length && !addresses.length) {
      const err = new Error('At least one address is required while you have riders');
      err.status = 400;
      throw err;
    }

    const existingIds = new Set((member.addresses || []).map((a) => a.id));
    member.addresses = addresses.map((a) => ({
      id: a.id && existingIds.has(a.id) ? a.id : generateAddressId(),
      address: a.address,
      ...(a.verified ? { verified: true } : {}),
    }));
    member.address = member.addresses[0] ? member.addresses[0].address : '';
    member.rideAddresses = { there: {}, back: {} };
    ['there', 'back'].forEach((leg) => {
      Object.entries((rideAddresses && rideAddresses[leg]) || {}).forEach(([weekday, index]) => {
        if (member.addresses[index]) member.rideAddresses[leg][weekday] = member.addresses[index].id;
      });
    });
    return { member, carpool };
  });
}

// Loads carpools about to be emailed — one by code, or every carpool with
// the monthly email turned on — making sure recurring dates are
// materialized and every member with an email has an unsubscribe token
// (members from before tokens existed get one now).
//
// `claimUpdateSlot` enforces the owner's one-update-email-per-day limit in
// the same conditional save, so a double tap can't send two.
const UPDATE_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function prepareCarpoolForEmail(carpool) {
  refreshCarpool(carpool);
  carpool.members.forEach((m) => {
    if (m.email && !m.unsubscribeToken) m.unsubscribeToken = generateUnsubscribeToken();
  });
  return carpool;
}

async function prepareCarpoolsForEmail({ code, monthlyOnly, claimUpdateSlot } = {}) {
  if (!code) return updateAllCarpools(prepareCarpoolForEmail, (c) => !monthlyOnly || c.monthlyEmail);
  const carpool = await updateCarpool(code, (carpool) => {
    if (claimUpdateSlot) {
      const last = carpool.lastUpdateEmailAt ? Date.parse(carpool.lastUpdateEmailAt) : 0;
      if (Date.now() - last < UPDATE_EMAIL_INTERVAL_MS) {
        const err = new Error('You can email everyone once a day. Try again later.');
        err.status = 429;
        throw err;
      }
      carpool.lastUpdateEmailAt = new Date().toISOString();
    }
    return prepareCarpoolForEmail(carpool);
  });
  return [carpool];
}

// Gives the daily update-email slot back (e.g. every email failed), but only
// if no newer send has claimed it since.
async function releaseUpdateEmailSlot(code, claimedAt) {
  return updateCarpool(code, (carpool) => {
    if (carpool.lastUpdateEmailAt !== claimedAt) return carpool;
    carpool.lastUpdateEmailAt = null;
    return carpool;
  });
}

// Links members from before sign-in existed (no userId) to a signed-in user
// whose verified email matches the one they gave when joining. Looks at one
// carpool (by code) or all of them, never links a second member into a
// carpool the user is already in, and returns the carpools it looked at.
async function linkMembersByEmail(userId, verifiedEmails, code) {
  const emails = new Set(verifiedEmails.map((e) => e.toLowerCase()));
  const linked = [];
  const link = (carpool) => {
    refreshCarpool(carpool);
    if (carpool.members.some((m) => m.userId === userId)) return carpool;
    const match = carpool.members.find((m) => !m.userId && m.email && emails.has(m.email.toLowerCase()));
    if (match) {
      match.userId = userId;
      linked.push(carpool.code);
    }
    return carpool;
  };
  const carpools = code ? [await updateCarpool(code, link)] : await updateAllCarpools(link);
  for (const c of new Set(linked)) await addUserCarpool(userId, c);
  return carpools;
}

// Every carpool, for the signed-in user's "Your carpools" list, with recurring
// dates rolled forward like getCarpool() does.
async function getAllCarpools() {
  return updateAllCarpools(refreshCarpool);
}

function tokensMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Turns update/monthly emails off (or back on) for one member of one
// carpool. Requires the secret token from their email's unsubscribe link.
// The secret in a member's private calendar link (src/calendar.js), made the
// first time they ask for the link. `reset` replaces it, so a link that's
// been shared stops working.
async function getCalendarToken(code, memberId, { reset = false } = {}) {
  return updateCarpool(code, (carpool) => {
    const member = carpool.members.find((m) => m.id === memberId);
    if (!member) {
      const err = new Error('Member not found');
      err.status = 404;
      throw err;
    }
    if (reset || !member.calendarToken) member.calendarToken = generateUnsubscribeToken();
    return member.calendarToken;
  });
}

async function setEmailSubscription(code, memberId, token, subscribed) {
  return updateCarpool(code, (carpool) => {
    const member = carpool.members.find((m) => m.id === memberId);
    if (!member || !tokensMatch(member.unsubscribeToken, token)) {
      const err = new Error('This unsubscribe link is invalid or out of date');
      err.status = 404;
      throw err;
    }
    member.emailOptOut = !subscribed;
    return { carpool, member };
  });
}

module.exports = {
  useLambdaBlobsContext,
  addNotification,
  getNotifications,
  markNotificationsRead,
  getCarpools,
  getUserCarpoolCodes,
  setUserCarpoolCodes,
  approveJoinRequest,
  declineJoinRequest,
  findPendingRequest,
  setRideOverride,
  getCarpool,
  getAllCarpools,
  linkMembersByEmail,
  prepareCarpoolsForEmail,
  releaseUpdateEmailSlot,
  setEmailSubscription,
  getCalendarToken,
  tokensMatch,
  updateCarpoolDetails,
  setMemberAddresses,
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
