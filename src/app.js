const express = require('express');
const store = require('./store');
const { sendCarpoolSummary, isEmailConfigured } = require('./email');
const { sendUpdateEmail } = require('./notify');
const { getEffectiveOwnerId, normalizeMembers, normalizeActivityTimes, getScheduleResult } = require('./normalize');

const app = express();
app.use(express.json());
// Unsubscribe confirmations and mail apps' one-click unsubscribe POST forms.
app.use(express.urlencoded({ extended: false }));

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

function serializeCarpool(carpool) {
  return {
    code: carpool.code,
    name: carpool.name,
    activityName: carpool.activityName || '',
    activityLocation: carpool.activityLocation || '',
    monthlyEmail: Boolean(carpool.monthlyEmail),
    lastUpdateEmailAt: carpool.lastUpdateEmailAt || null,
    ownerId: getEffectiveOwnerId(carpool),
    activityDates: carpool.activityDates || [],
    activityTimes: normalizeActivityTimes(carpool.activityTimes),
    recurrence: carpool.recurrence || null,
    dateOverrides: carpool.dateOverrides || {},
    members: normalizeMembers(carpool.members),
  };
}

function siteUrl(req) {
  if (process.env.URL) return process.env.URL.replace(/\/$/, '');
  return `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
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
    if (req.body.monthlyEmail !== undefined) details.monthlyEmail = Boolean(req.body.monthlyEmail);
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

const MAX_UPDATE_MESSAGE = 2000;

// Owner only, at most once per 24 hours: emails every subscribed member
// their summary + schedule for the rest of the month, with an optional note
// from the owner.
app.post('/api/carpools/:code/email-update', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.params.code);
    if (!carpool) return res.status(404).json({ errors: ['Carpool not found'] });
    if (req.body.requesterId !== getEffectiveOwnerId(carpool)) {
      return res.status(403).json({ errors: ['Only the owner can email the carpool'] });
    }
    if (!isEmailConfigured()) {
      return res.status(503).json({ errors: ["Email sending isn't set up yet"] });
    }
    const message = String(req.body.message || '').trim();
    if (message.length > MAX_UPDATE_MESSAGE) {
      return res.status(400).json({ errors: [`Keep the message under ${MAX_UPDATE_MESSAGE} characters`] });
    }
    res.json(await sendUpdateEmail(req.params.code, siteUrl(req), message));
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
});

// ---- Unsubscribe (linked from every email) ----
// GET only shows a confirm button: mail scanners prefetch links, so a GET
// must never change anything. The POST does the work, including mail apps'
// one-click unsubscribe (body "List-Unsubscribe=One-Click").

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unsubscribePage(title, body, form) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title><link rel="icon" href="/img/app-icon.svg" type="image/svg+xml" /><link rel="stylesheet" href="/style.css" /></head>
<body><div class="page"><div class="site-header"><img src="/img/carpooler-name.svg" alt="Carpooler" class="site-logo-lockup" /></div>
<div class="card"><h1>${escapeHtml(title)}</h1><p class="subtitle">${body}</p>${form || ''}</div></div></body></html>`;
}

function subscriptionForm(query, action, label, secondary) {
  const params = new URLSearchParams({ c: query.c || '', m: query.m || '', t: query.t || '' });
  return `<form method="post" action="/api/unsubscribe?${escapeHtml(params.toString())}">
<input type="hidden" name="action" value="${action}" />
<button type="submit"${secondary ? ' class="secondary"' : ''}>${escapeHtml(label)}</button></form>`;
}

app.get('/api/unsubscribe', async (req, res) => {
  try {
    const carpool = await store.getCarpool(req.query.c);
    const name = carpool ? escapeHtml(carpool.name) : 'this carpool';
    res.send(
      unsubscribePage(
        'Unsubscribe?',
        `Stop getting update and monthly schedule emails for <strong>${name}</strong>? You'll still be in the carpool.`,
        subscriptionForm(req.query, 'unsubscribe', 'Unsubscribe')
      )
    );
  } catch (err) {
    res.status(500).send(unsubscribePage('Something went wrong', escapeHtml(err.message)));
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  const subscribe = req.body.action === 'resubscribe';
  try {
    const { carpool } = await store.setEmailSubscription(req.query.c, req.query.m, req.query.t, subscribe);
    const name = escapeHtml(carpool.name);
    res.send(
      subscribe
        ? unsubscribePage("You're subscribed", `You'll get update and monthly schedule emails for <strong>${name}</strong> again.`)
        : unsubscribePage(
            "You're unsubscribed",
            `You won't get any more update or monthly schedule emails for <strong>${name}</strong>. You're still in the carpool.`,
            subscriptionForm(req.query, 'resubscribe', 'Changed your mind? Resubscribe', true)
          )
    );
  } catch (err) {
    res.status(err.status || 500).send(unsubscribePage("Couldn't update your email settings", escapeHtml(err.message)));
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
