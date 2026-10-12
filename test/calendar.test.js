const test = require('node:test');
const assert = require('node:assert');
const { zonedToUtc } = require('../src/calendar');

test('ride times convert from the carpool time zone to UTC', () => {
  // Chicago is UTC-5 in October (daylight time) and UTC-6 in January.
  assert.strictEqual(zonedToUtc('2026-10-13', '07:30', 'America/Chicago').toISOString(), '2026-10-13T12:30:00.000Z');
  assert.strictEqual(zonedToUtc('2027-01-12', '07:30', 'America/Chicago').toISOString(), '2027-01-12T13:30:00.000Z');
  // The morning clocks go forward (2 am becomes 3 am on 2027-03-14).
  assert.strictEqual(zonedToUtc('2027-03-14', '08:00', 'America/Chicago').toISOString(), '2027-03-14T13:00:00.000Z');
});
