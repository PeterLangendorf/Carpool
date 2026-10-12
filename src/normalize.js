// Read-side helpers shared by the API and the email jobs: upgrade older
// stored data shapes and compute the live schedule.
const { buildSchedule } = require('./scheduler');
const { todayKey } = require('./dates');

// Carpools created before ownership tracking existed have no stored
// ownerId — fall back to the first member (always the creator).
function getEffectiveOwnerId(carpool) {
  return carpool.ownerId || (carpool.members[0] && carpool.members[0].id) || null;
}

// Carpools created before the two-leg (there/back) model existed used a
// single canDriveDays/needsRideDays list — normalize those into "available
// or needed for both legs" so old data keeps working.
//
// Likewise, members from before multiple addresses existed have a single
// `address` string — expose it as a one-entry `addresses` list. Emails,
// unsubscribe tokens and Clerk user IDs are stripped: every member of the
// carpool can read the payload.
function normalizeMembers(members) {
  return members.map(({ email, unsubscribeToken, calendarToken, userId, ...m }) => ({
    ...m,
    addresses: m.addresses || (m.address ? [{ id: 'a_legacy', address: m.address }] : []),
    rideAddresses: m.rideAddresses || { there: {}, back: {} },
    canDriveThereDays: m.canDriveThereDays || m.canDriveDays || [],
    canDriveBackDays: m.canDriveBackDays || m.canDriveDays || [],
    children: (m.children || []).map((c) => ({
      ...c,
      ...childNameParts(c, m.lastName),
      needsRideThereDays: c.needsRideThereDays || c.needsRideDays || [],
      needsRideBackDays: c.needsRideBackDays || c.needsRideDays || [],
    })),
  }));
}

// Carpools created before the two-leg time model existed stored a single
// "date -> HH:MM" map — normalize into the {uniform, perWeekday, perDate}
// shape, treating the legacy time as both legs' time.
function normalizeActivityTimes(activityTimes) {
  if (!activityTimes) return { uniform: {}, perWeekday: {}, perDate: {} };
  if (activityTimes.uniform !== undefined || activityTimes.perWeekday !== undefined || activityTimes.perDate !== undefined) {
    return {
      uniform: activityTimes.uniform || {},
      perWeekday: activityTimes.perWeekday || {},
      perDate: activityTimes.perDate || {},
    };
  }
  // Legacy shape: { [date]: "HH:MM" }
  const perDate = {};
  Object.entries(activityTimes).forEach(([date, time]) => {
    if (typeof time === 'string') perDate[date] = { there: time, back: time };
  });
  return { uniform: {}, perWeekday: {}, perDate };
}

// A rider's first name and last-name override (blank = the parent's last
// name). Riders saved before these were stored separately only have `name`:
// the last name is taken to be the parent's when it matches, otherwise the
// last word, so composing the parts again gives back the same name.
function childNameParts(child, parentLastName) {
  if (typeof child.firstName === 'string') return { firstName: child.firstName, lastNameOverride: child.lastNameOverride || '' };
  const name = String(child.name || '').trim();
  const last = String(parentLastName || '').trim();
  if (last && name.toLowerCase().endsWith(' ' + last.toLowerCase())) {
    return { firstName: name.slice(0, name.length - last.length).trim(), lastNameOverride: '' };
  }
  const words = name.split(/\s+/);
  if (words.length < 2) return { firstName: name, lastNameOverride: '' };
  return { firstName: words.slice(0, -1).join(' '), lastNameOverride: words[words.length - 1] };
}

// Where the schedule carries on from: each member's rides recorded in
// `carpool.driveHistory` (plus the starting credit a member who joined later
// was given) and the date they last drove. See recordPastDrives in store.js.
function historySeed(carpool) {
  const counts = {};
  const lastDriven = {};
  carpool.members.forEach((m) => {
    if (m.driveCredit) counts[m.id] = m.driveCredit;
  });
  Object.entries((carpool.driveHistory && carpool.driveHistory.dates) || {}).forEach(([date, legs]) => {
    [...(legs.there || []), ...(legs.back || [])].forEach((id) => {
      counts[id] = (counts[id] || 0) + 1;
      if (!lastDriven[id] || date > lastDriven[id]) lastDriven[id] = date;
    });
  });
  return { counts, lastDriven };
}

// Schedules every date not yet in the drive history (from when the history
// started) on top of that history. `past` holds the dates before `today`
// that still need recording; `schedule` is today onwards, and `driveCounts`
// counts rides in it. Entries are `locked` when their drivers have been
// locked in (carpool.lockedDrives).
function computeSchedule(carpool, today = todayKey(carpool.timeZone)) {
  const history = carpool.driveHistory || { since: today, dates: {} };
  const dates = (carpool.activityDates || []).filter((d) => d >= history.since && !history.dates[d]);
  const { schedule: entries } = buildSchedule(
    normalizeMembers(carpool.members),
    dates,
    carpool.dateOverrides || {},
    normalizeActivityTimes(carpool.activityTimes),
    historySeed(carpool),
    carpool.lockedDrives || {}
  );
  entries.forEach((e) => {
    e.locked = Boolean(carpool.lockedDrives && carpool.lockedDrives[e.date]);
  });
  const schedule = entries.filter((e) => e.date >= today);
  const driveCounts = Object.fromEntries(carpool.members.map((m) => [m.id, 0]));
  schedule.forEach((e) => {
    [...e.there.drivers, ...e.back.drivers].forEach((d) => {
      driveCounts[d.id] += 1;
    });
  });
  return { schedule, driveCounts, past: entries.filter((e) => e.date < today) };
}

function getScheduleResult(carpool) {
  const { schedule, driveCounts } = computeSchedule(carpool);
  return { schedule, driveCounts };
}

module.exports = {
  getEffectiveOwnerId,
  normalizeMembers,
  normalizeActivityTimes,
  childNameParts,
  historySeed,
  computeSchedule,
  getScheduleResult,
};
