// "Today" for a carpool, in the carpool's own time zone. The server runs in
// UTC, so new Date().toISOString() is already tomorrow during a US evening and
// would drop that day's rides early. A carpool's `timeZone` (an IANA name like
// "America/Chicago") comes from the browser of whoever creates or first opens
// it; carpools without one fall back to UTC.

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// "YYYY-MM-DD" for `now` in `timeZone`.
function todayKey(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The weekday (0=Sunday) of a "YYYY-MM-DD" date, independent of the server's zone.
function weekdayOf(dateKey) {
  return new Date(dateKey + 'T00:00:00Z').getUTCDay();
}

// `months` calendar months after a "YYYY-MM-DD" date, as "YYYY-MM-DD".
function addMonths(dateKey, months) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// `days` days after a "YYYY-MM-DD" date.
function addDays(dateKey, days) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The day after a "YYYY-MM-DD" date.
function nextDay(dateKey) {
  return addDays(dateKey, 1);
}

module.exports = { isValidTimeZone, todayKey, weekdayOf, addMonths, addDays, nextDay };
