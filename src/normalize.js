// Read-side helpers shared by the API and the email jobs: upgrade older
// stored data shapes and compute the live schedule.
const { buildSchedule } = require('./scheduler');

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
// `address` string — expose it as a one-entry `addresses` list. Emails and
// unsubscribe tokens are stripped: the carpool payload is readable by anyone
// with the join code.
function normalizeMembers(members) {
  return members.map(({ email, unsubscribeToken, ...m }) => ({
    ...m,
    addresses: m.addresses || (m.address ? [{ id: 'a_legacy', address: m.address }] : []),
    rideAddresses: m.rideAddresses || { there: {}, back: {} },
    canDriveThereDays: m.canDriveThereDays || m.canDriveDays || [],
    canDriveBackDays: m.canDriveBackDays || m.canDriveDays || [],
    children: (m.children || []).map((c) => ({
      ...c,
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

function getScheduleResult(carpool) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const upcoming = (carpool.activityDates || []).filter((d) => d >= todayKey);
  return buildSchedule(normalizeMembers(carpool.members), upcoming, carpool.dateOverrides || {}, normalizeActivityTimes(carpool.activityTimes));
}

module.exports = { getEffectiveOwnerId, normalizeMembers, normalizeActivityTimes, getScheduleResult };
