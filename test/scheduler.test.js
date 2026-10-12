const test = require('node:test');
const assert = require('node:assert');
const { buildSchedule } = require('../src/scheduler');

const member = (id, seats, days = [1, 2, 3, 4, 5], kids = []) => ({
  id,
  name: id,
  seats,
  canDriveThereDays: days,
  canDriveBackDays: days,
  children: kids.map((k) => ({ id: `${id}-${k}`, name: k, needsRideThereDays: days, needsRideBackDays: days })),
});

// Mondays in October and November 2026.
const MONDAYS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
const drivers = (entry) => [entry.there.drivers.map((d) => d.id), entry.back.drivers.map((d) => d.id)];

test('shares the driving evenly', () => {
  const members = [member('a', 4, [1], ['a1']), member('b', 4, [1], ['b1'])];
  const { driveCounts } = buildSchedule(members, MONDAYS);
  assert.strictEqual(driveCounts.a, driveCounts.b);
});

test('adds as many cars as it takes to seat everyone', () => {
  const kids = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
  const members = [member('a', 3, [1], kids), member('b', 3, [1]), member('c', 3, [1])];
  const [entry] = buildSchedule(members, ['2026-10-05']).schedule;
  assert.strictEqual(entry.there.drivers.length, 3);
  assert.strictEqual(entry.there.overCapacity, false);
});

test('reports riders without a seat when there are no more drivers', () => {
  const members = [member('a', 2, [1], ['k1', 'k2', 'k3', 'k4', 'k5'])];
  const [entry] = buildSchedule(members, ['2026-10-05']).schedule;
  assert.strictEqual(entry.there.overCapacity, true);
  assert.strictEqual(entry.there.strandedCount, 3);
});

test('carrying on from history gives the same schedule as one long run', () => {
  const members = [member('a', 4, [1], ['a1']), member('b', 4, [1], ['b1']), member('c', 2, [1], ['c1'])];
  const full = buildSchedule(members, MONDAYS).schedule;

  // Record the first three dates the way store.recordPastDrives does...
  const counts = {};
  const lastDriven = {};
  full.slice(0, 3).forEach((e) => {
    [...e.there.drivers, ...e.back.drivers].forEach((d) => {
      counts[d.id] = (counts[d.id] || 0) + 1;
      lastDriven[d.id] = e.date;
    });
  });
  // ...then schedule the rest on top of them.
  const rest = buildSchedule(members, MONDAYS.slice(3), {}, {}, { counts, lastDriven }).schedule;
  assert.deepStrictEqual(rest.map(drivers), full.slice(3).map(drivers));
});
