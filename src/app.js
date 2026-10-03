const express = require('express');
const store = require('./store');
const { buildSchedule } = require('./scheduler');
const { sendCarpoolSummary } = require('./email');

const app = express();
app.use(express.json());

const VALID_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseDays(value) {
  return Array.isArray(value) ? value.map(Number).filter((d) => VALID_DAYS.includes(d)) : [];
}

function parseChildren(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((c) => ({
      firstName: String((c && c.firstName) || '').trim(),
      lastNameOverride: c && c.lastNameOverride ? String(c.lastNameOverride).trim() : '',
      needsRideThereDays: parseDays(c && c.needsRideThereDays),
      needsRideBackDays: parseDays(c && c.needsRideBackDays),
    }))
    .filter((c) => c.firstName)
    .slice(0, 10);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ADDRESSES = 5;

// Accepts the current `addresses: [string]` shape, falling back to the older
// single `address` string.
function parseAddresses(body) {
  const raw = Array.isArray(body.addresses) ? body.addresses : body.address ? [body.address] : [];
  return raw
    .map((a) => String(a || '').trim())
    .filter(Boolean)
    .slice(0, MAX_ADDRESSES);
}

// `rideAddresses` picks which of the member's addresses each ride uses, as
// { there: { [weekday]: addressIndex }, back: { ... } }. Indexes refer to the
// `addresses` array in the same request; the store swaps them for address IDs.
function parseRideAddresses(value, addressCount) {
  const out = { there: {}, back: {} };
  if (!value || typeof value !== 'object') return out;
  ['there', 'back'].forEach((leg) => {
    Object.entries(value[leg] || {}).forEach(([weekday, index]) => {
      const w = Number(weekday);
      const i = Number(index);
      if (VALID_DAYS.includes(w) && Number.isInteger(i) && i >= 0 && i < addressCount) out[leg][w] = i;
    });
  });
  return out;
}

function validateMemberInput(body) {
  const errors = [];
  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  if (!firstName) errors.push('First name is required');
  if (!lastName) errors.push('Last name is required');
  const name = `${firstName} ${lastName}`.trim();

  const email = String(body.email || '').trim();
  if (!EMAIL_RE.test(email)) errors.push('A valid email address is required');

  const seats = Number(body.seats);
  if (!Number.isInteger(seats) || seats < 0 || seats > 15) {
    errors.push('Number of passengers must be a whole number between 0 and 15');
  }

  const canDriveThereDays = parseDays(body.canDriveThereDays);
  const canDriveBackDays = parseDays(body.canDriveBackDays);
  if (canDriveThereDays.length === 0 && canDriveBackDays.length === 0) {
    errors.push('Pick at least one day/leg you can drive');
  }

  const children = parseChildren(body.children);

  // An address is only needed to pick up/drop off riders — a driver-only
  // member can skip it.
  const addresses = parseAddresses(body);
  if (children.length && !addresses.length) errors.push('At least one address is required');
  const rideAddresses = parseRideAddresses(body.rideAddresses, addresses.length);

  return {
    errors,
    member: { name, lastName, email, addresses, rideAddresses, seats, canDriveThereDays, canDriveBackDays, children },
  };
}

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
// `address` string — expose it as a one-entry `addresses` list. Emails are
// stripped: the carpool payload is readable by anyone with the join code.
function normalizeMembers(members) {
  return members.map(({ email, ...m }) => ({
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

function serializeCarpool(carpool) {
  return {
    code: carpool.code,
    name: carpool.name,
    activityName: carpool.activityName || '',
    activityLocation: carpool.activityLocation || '',
    ownerId: getEffectiveOwnerId(carpool),
    activityDates: carpool.activityDates || [],
    activityTimes: normalizeActivityTimes(carpool.activityTimes),
    recurrence: carpool.recurrence || null,
    dateOverrides: carpool.dateOverrides || {},
    members: normalizeMembers(carpool.members),
  };
}

function getScheduleResult(carpool) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const upcoming = (carpool.activityDates || []).filter((d) => d >= todayKey);
  return buildSchedule(normalizeMembers(carpool.members), upcoming, carpool.dateOverrides || {}, normalizeActivityTimes(carpool.activityTimes));
}

function siteUrl(req) {
  if (process.env.URL) return process.env.URL.replace(/\/$/, '');
  return `https://${req.get('x-forwarded-host') || req.get('host')}`;
}

app.post('/api/carpools', async (req, res) => {
  const { dates, times, recurrence } = req.body;
  const carpoolName = String(req.body.carpoolName || '').trim();
  const activityName = String(req.body.activityName || '').trim();
  const activityLocation = String(req.body.activityLocation || '').trim();
  const { errors, member: memberInput } = validateMemberInput(req.body);
  if (!carpoolName) errors.push('Carpool name is required');
  if (!activityName) errors.push('Activity name is required');
  if (!activityLocation) errors.push('Activity location is required');
  if (dates !== undefined) errors.push(...activityDatesErrors(dates, times, recurrence));
  if (errors.length) return res.status(400).json({ errors });

  try {
    const { carpool, member } = await store.createCarpoolWithOwner(
      { name: carpoolName, activityName, activityLocation },
      memberInput,
      dates !== undefined ? { dates, times: times || {}, recurrence } : null
    );
    const emailSent = await sendCarpoolSummary(member.email, carpool, member, siteUrl(req), {
      schedule: getScheduleResult(carpool).schedule,
      members: normalizeMembers(carpool.members),
    });
    res.status(201).json({ carpool: serializeCarpool(carpool), member: normalizeMembers([member])[0], emailSent });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.get('/api/carpools/:code', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });
    res.json(serializeCarpool(carpool));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.post('/api/carpools/:code/members', async (req, res) => {
  const { errors, member: memberInput } = validateMemberInput(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const { member, carpool } = await store.addMember(req.params.code, memberInput);
    const emailSent = await sendCarpoolSummary(member.email, carpool, member, siteUrl(req), {
      schedule: getScheduleResult(carpool).schedule,
      members: normalizeMembers(carpool.members),
    });
    res.status(201).json({ member: normalizeMembers([member])[0], emailSent });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.delete('/api/carpools/:code/members/:memberId', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

    const { requesterId } = req.body;
    if (requesterId !== req.params.memberId) {
      return res.status(403).json({ errors: ['You can only remove yourself'] });
    }

    const updated = await store.removeMember(req.params.code, req.params.memberId);
    if (!updated) return res.json({ deleted: true });
    res.json(serializeCarpool(updated));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.post('/api/carpools/:code/members/:memberId/children', async (req, res) => {
  const { requesterId, firstName, lastNameOverride, needsRideThereDays, needsRideBackDays } = req.body;
  const first = String(firstName || '').trim();
  if (!first) return res.status(400).json({ errors: ['First name is required'] });

  try {
    const { child, carpool } = await store.addChild(req.params.code, req.params.memberId, requesterId, {
      firstName: first,
      lastNameOverride: lastNameOverride ? String(lastNameOverride).trim() : '',
      needsRideThereDays: parseDays(needsRideThereDays),
      needsRideBackDays: parseDays(needsRideBackDays),
    });
    res.status(201).json({ child, carpool: serializeCarpool(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.patch('/api/carpools/:code/members/:memberId/children/:childId', async (req, res) => {
  const { requesterId, firstName, lastNameOverride, needsRideThereDays, needsRideBackDays } = req.body;

  try {
    const updates = {};
    if (firstName !== undefined) updates.firstName = String(firstName).trim();
    if (lastNameOverride !== undefined) updates.lastNameOverride = String(lastNameOverride).trim();
    if (needsRideThereDays !== undefined) updates.needsRideThereDays = parseDays(needsRideThereDays);
    if (needsRideBackDays !== undefined) updates.needsRideBackDays = parseDays(needsRideBackDays);

    const { carpool } = await store.updateChild(req.params.code, req.params.memberId, requesterId, req.params.childId, updates);
    res.json({ carpool: serializeCarpool(carpool), schedule: getScheduleResult(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.delete('/api/carpools/:code/members/:memberId/children/:childId', async (req, res) => {
  const { requesterId } = req.body;

  try {
    const { carpool } = await store.removeChild(req.params.code, req.params.memberId, requesterId, req.params.childId);
    res.json({ carpool: serializeCarpool(carpool), schedule: getScheduleResult(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

function isValidLegTimes(value) {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((k) => k === 'there' || k === 'back') && Object.values(value).every((v) => typeof v === 'string');
}

function isValidActivityTimes(times) {
  if (times === undefined) return true;
  if (typeof times !== 'object' || times === null || Array.isArray(times)) return false;
  if (!isValidLegTimes(times.uniform)) return false;
  if (times.perWeekday !== undefined) {
    if (typeof times.perWeekday !== 'object' || times.perWeekday === null || Array.isArray(times.perWeekday)) return false;
    if (!Object.values(times.perWeekday).every(isValidLegTimes)) return false;
  }
  if (times.perDate !== undefined) {
    if (typeof times.perDate !== 'object' || times.perDate === null || Array.isArray(times.perDate)) return false;
    if (!Object.values(times.perDate).every(isValidLegTimes)) return false;
  }
  return true;
}

function activityDatesErrors(dates, times, recurrence) {
  const errors = [];
  if (!Array.isArray(dates) || !dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    errors.push('dates must be an array of YYYY-MM-DD strings');
  }
  if (!isValidActivityTimes(times)) {
    errors.push('times must be a {uniform, perWeekday, perDate} object of there/back HH:MM strings');
  }
  if (recurrence !== undefined && recurrence !== null) {
    if (typeof recurrence !== 'object' || !Array.isArray(recurrence.weekdays) || typeof recurrence.startDate !== 'string') {
      errors.push('recurrence must be {weekdays, startDate, endDate}');
    }
  }
  return errors;
}

app.put('/api/carpools/:code/activity-dates', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

    const { requesterId, dates, times, recurrence } = req.body;
    if (requesterId !== getEffectiveOwnerId(carpool)) {
      return res.status(403).json({ errors: ['Only the owner can edit activity dates'] });
    }
    const errors = activityDatesErrors(dates, times, recurrence);
    if (errors.length) return res.status(400).json({ errors });

    const updated = await store.setActivityDates(req.params.code, dates, times || {}, recurrence);
    res.json(serializeCarpool(updated));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.put('/api/carpools/:code/dates/:date/child-exclusion', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ errors: ['Invalid date'] });
    }
    const { requesterId, childId, excluded } = req.body;
    if (typeof childId !== 'string' || typeof excluded !== 'boolean') {
      return res.status(400).json({ errors: ['childId and excluded are required'] });
    }

    const updated = await store.setChildExclusion(req.params.code, date, requesterId, childId, excluded);
    res.json(getScheduleResult(updated));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.patch('/api/carpools/:code/details', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

    const { requesterId } = req.body;
    if (requesterId !== getEffectiveOwnerId(carpool)) {
      return res.status(403).json({ errors: ['Only the owner can edit carpool details'] });
    }

    const details = {};
    const errors = [];
    [
      ['name', 'Carpool name'],
      ['activityName', 'Activity name'],
      ['activityLocation', 'Activity location'],
    ].forEach(([key, label]) => {
      if (req.body[key] === undefined) return;
      details[key] = String(req.body[key]).trim();
      if (!details[key]) errors.push(`${label} is required`);
    });
    if (errors.length) return res.status(400).json({ errors });

    const updated = await store.updateCarpoolDetails(req.params.code, details);
    res.json(serializeCarpool(updated));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

// Body: { requesterId, addresses: [{ id?, address }], rideAddresses } where
// rideAddresses indexes into `addresses`, as on create/join.
app.put('/api/carpools/:code/members/:memberId/addresses', async (req, res) => {
  const raw = Array.isArray(req.body.addresses) ? req.body.addresses : [];
  const addresses = raw
    .map((a) => ({ id: a && typeof a.id === 'string' ? a.id : null, address: String((a && a.address) || '').trim() }))
    .filter((a) => a.address)
    .slice(0, MAX_ADDRESSES);
  if (addresses.length !== Math.min(raw.length, MAX_ADDRESSES)) {
    return res.status(400).json({ errors: ['Fill in or remove empty addresses'] });
  }
  const rideAddresses = parseRideAddresses(req.body.rideAddresses, addresses.length);

  try {
    const { carpool } = await store.setMemberAddresses(
      req.params.code,
      req.params.memberId,
      req.body.requesterId,
      addresses,
      rideAddresses
    );
    res.json({ carpool: serializeCarpool(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.get('/api/carpools/:code/schedule', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });
    res.json(getScheduleResult(carpool));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

module.exports = app;
