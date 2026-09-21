const express = require('express');
const path = require('path');
const store = require('./src/store');
const { buildSchedule } = require('./src/scheduler');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function validateMemberInput(body) {
  const errors = [];
  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  if (!firstName) errors.push('First name is required');
  if (!lastName) errors.push('Last name is required');
  const name = `${firstName} ${lastName}`.trim();

  const address = (body.address || '').trim();
  if (!address) errors.push('Address is required');

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

  return { errors, name, lastName, address, seats, canDriveThereDays, canDriveBackDays, children };
}

// Carpools created before ownership tracking existed have no stored
// ownerId — fall back to the first member (always the creator).
function getEffectiveOwnerId(carpool) {
  return carpool.ownerId || (carpool.members[0] && carpool.members[0].id) || null;
}

// Carpools created before the two-leg (there/back) model existed used a
// single canDriveDays/needsRideDays list — normalize those into "available
// or needed for both legs" so old data keeps working.
function normalizeMembers(members) {
  return members.map((m) => ({
    ...m,
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

app.post('/api/carpools', (req, res) => {
  const { carpoolName } = req.body;
  const { errors, name, lastName, address, seats, canDriveThereDays, canDriveBackDays, children } = validateMemberInput(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const carpool = store.createCarpool(carpoolName);
    const member = store.addMember(carpool.code, { name, lastName, address, seats, canDriveThereDays, canDriveBackDays, children });
    store.setOwner(carpool.code, member.id);
    res.status(201).json({ carpool: serializeCarpool(store.getCarpool(carpool.code)), member });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.get('/api/carpools/:code', (req, res) => {
  const carpool = store.getCarpool(req.params.code);
  if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });
  res.json(serializeCarpool(carpool));
});

app.post('/api/carpools/:code/members', (req, res) => {
  const { errors, name, lastName, address, seats, canDriveThereDays, canDriveBackDays, children } = validateMemberInput(req.body);
  if (errors.length) return res.status(400).json({ errors });

  try {
    const member = store.addMember(req.params.code, { name, lastName, address, seats, canDriveThereDays, canDriveBackDays, children });
    res.status(201).json({ member });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.delete('/api/carpools/:code/members/:memberId', (req, res) => {
  const carpool = store.getCarpool(req.params.code);
  if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

  const { requesterId } = req.body;
  if (requesterId !== req.params.memberId) {
    return res.status(403).json({ errors: ['You can only remove yourself'] });
  }

  const updated = store.removeMember(req.params.code, req.params.memberId);
  if (!updated) return res.json({ deleted: true });
  res.json(serializeCarpool(updated));
});

app.post('/api/carpools/:code/members/:memberId/children', (req, res) => {
  const { requesterId, firstName, lastNameOverride, needsRideThereDays, needsRideBackDays } = req.body;
  const first = String(firstName || '').trim();
  if (!first) return res.status(400).json({ errors: ['First name is required'] });

  try {
    const child = store.addChild(req.params.code, req.params.memberId, requesterId, {
      firstName: first,
      lastNameOverride: lastNameOverride ? String(lastNameOverride).trim() : '',
      needsRideThereDays: parseDays(needsRideThereDays),
      needsRideBackDays: parseDays(needsRideBackDays),
    });
    const carpool = store.getCarpool(req.params.code);
    res.status(201).json({ child, carpool: serializeCarpool(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.patch('/api/carpools/:code/members/:memberId/children/:childId', (req, res) => {
  const { requesterId, firstName, lastNameOverride, needsRideThereDays, needsRideBackDays } = req.body;

  try {
    const updates = {};
    if (firstName !== undefined) updates.firstName = String(firstName).trim();
    if (lastNameOverride !== undefined) updates.lastNameOverride = String(lastNameOverride).trim();
    if (needsRideThereDays !== undefined) updates.needsRideThereDays = parseDays(needsRideThereDays);
    if (needsRideBackDays !== undefined) updates.needsRideBackDays = parseDays(needsRideBackDays);

    store.updateChild(req.params.code, req.params.memberId, requesterId, req.params.childId, updates);
    const carpool = store.getCarpool(req.params.code);
    res.json({ carpool: serializeCarpool(carpool), schedule: getScheduleResult(carpool) });
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.delete('/api/carpools/:code/members/:memberId/children/:childId', (req, res) => {
  const { requesterId } = req.body;

  try {
    store.removeChild(req.params.code, req.params.memberId, requesterId, req.params.childId);
    const carpool = store.getCarpool(req.params.code);
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

app.put('/api/carpools/:code/activity-dates', (req, res) => {
  const carpool = store.getCarpool(req.params.code);
  if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

  const { requesterId, dates, times, recurrence } = req.body;
  if (requesterId !== getEffectiveOwnerId(carpool)) {
    return res.status(403).json({ errors: ['Only the owner can edit activity dates'] });
  }
  if (!Array.isArray(dates) || !dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    return res.status(400).json({ errors: ['dates must be an array of YYYY-MM-DD strings'] });
  }
  if (!isValidActivityTimes(times)) {
    return res.status(400).json({ errors: ['times must be a {uniform, perWeekday, perDate} object of there/back HH:MM strings'] });
  }
  if (recurrence !== undefined && recurrence !== null) {
    if (typeof recurrence !== 'object' || !Array.isArray(recurrence.weekdays) || typeof recurrence.startDate !== 'string') {
      return res.status(400).json({ errors: ['recurrence must be {weekdays, startDate, endDate}'] });
    }
  }

  const updated = store.setActivityDates(req.params.code, dates, times || {}, recurrence);
  res.json(serializeCarpool(updated));
});

app.put('/api/carpools/:code/dates/:date/child-exclusion', (req, res) => {
  const carpool = store.getCarpool(req.params.code);
  if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });

  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ errors: ['Invalid date'] });
  }
  const { requesterId, childId, excluded } = req.body;
  if (typeof childId !== 'string' || typeof excluded !== 'boolean') {
    return res.status(400).json({ errors: ['childId and excluded are required'] });
  }

  try {
    store.setChildExclusion(req.params.code, date, requesterId, childId, excluded);
    const updated = store.getCarpool(req.params.code);
    res.json(getScheduleResult(updated));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

app.get('/api/carpools/:code/schedule', (req, res) => {
  const carpool = store.getCarpool(req.params.code);
  if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });
  res.json(getScheduleResult(carpool));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Carpool app running at http://localhost:${PORT}`);
});
