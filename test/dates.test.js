const test = require('node:test');
const assert = require('node:assert');
const { todayKey, isValidTimeZone, weekdayOf, addMonths, nextDay } = require('../src/dates');

test("today is the carpool's local date, not UTC", () => {
  const eveningInChicago = new Date('2026-10-11T03:30:00Z'); // 10:30pm on the 10th in Chicago
  assert.strictEqual(todayKey('America/Chicago', eveningInChicago), '2026-10-10');
  assert.strictEqual(todayKey(null, eveningInChicago), '2026-10-11');
  assert.strictEqual(todayKey('Not/AZone', eveningInChicago), '2026-10-11');
});

test('time zone validation', () => {
  assert.ok(isValidTimeZone('Europe/London'));
  assert.ok(!isValidTimeZone('Mars/Base'));
  assert.ok(!isValidTimeZone(''));
  assert.ok(!isValidTimeZone(undefined));
});

test('date arithmetic on YYYY-MM-DD keys', () => {
  assert.strictEqual(weekdayOf('2026-10-11'), 0);
  assert.strictEqual(nextDay('2026-12-31'), '2027-01-01');
  assert.strictEqual(addMonths('2026-10-11', 12), '2027-10-11');
});
