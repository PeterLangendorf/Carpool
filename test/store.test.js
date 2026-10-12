const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-blobs').install();

// An old single-blob database with two carpools, from before each carpool
// had its own blob. Must be in place before the store's first call.
const legacyMember = { id: 'm1', userId: 'u1', name: 'Pat Lee', lastName: 'Lee', seats: 3, canDriveThereDays: [1], canDriveBackDays: [1], children: [] };
const legacyCarpool = (code) => ({ code, name: code, ownerId: 'm1', activityDates: [], activityTimes: {}, recurrence: null, recurrenceExcludedDates: [], dateOverrides: {}, members: [{ ...legacyMember }] });
fake.write('db', { carpools: { AAAAAA: legacyCarpool('AAAAAA'), BBBBBB: legacyCarpool('BBBBBB') } });

const store = require('../src/store');
const { getScheduleResult, normalizeMembers } = require('../src/normalize');

const memberInput = (name, userId, extra = {}) => ({
  name,
  lastName: 'X',
  userId,
  seats: 3,
  canDriveThereDays: [1, 3],
  canDriveBackDays: [1, 3],
  addresses: ['1 Main St'],
  children: [],
  ...extra,
});

test('moves the old shared blob into one blob per carpool, keeping it as a backup', async () => {
  assert.ok(await store.getCarpool('AAAAAA'));
  assert.ok(fake.data.has('carpools/AAAAAA') && fake.data.has('carpools/BBBBBB'));
  assert.ok(fake.data.has('db'));
});

test('simultaneous saves, in one carpool or several, are all kept', async () => {
  const N = 6;
  const ops = [];
  for (let i = 0; i < N; i++) {
    ops.push(store.addChild('AAAAAA', 'm1', 'm1', { firstName: `KidA${i}`, needsRideThereDays: [1] }));
    ops.push(store.addChild('BBBBBB', 'm1', 'm1', { firstName: `KidB${i}`, needsRideThereDays: [1] }));
    ops.push(store.addMember('AAAAAA', memberInput(`Joiner${i}`, `j${i}`)));
  }
  ops.push(store.updateCarpoolDetails('AAAAAA', { activityName: 'Soccer' }));
  ops.push(store.updateCarpoolDetails('BBBBBB', { activityLocation: 'Field 3' }));
  await Promise.all(ops);

  const a = await store.getCarpool('AAAAAA');
  const b = await store.getCarpool('BBBBBB');
  assert.strictEqual(a.members[0].children.length, N);
  assert.strictEqual(b.members[0].children.length, N);
  assert.strictEqual(a.members.length, 1 + N);
  assert.strictEqual(a.activityName, 'Soccer');
  assert.strictEqual(b.activityLocation, 'Field 3');
});

test('refused changes are not saved', async () => {
  await assert.rejects(store.addMember('AAAAAA', memberInput('Dup', 'u1')), (e) => e.status === 409);
  await assert.rejects(store.addChild('AAAAAA', 'm1', 'someone-else', { firstName: 'Z' }), (e) => e.status === 403);
});

test('the last member leaving deletes the carpool', async () => {
  const { carpool } = await store.createCarpoolWithOwner({ name: 'Short-lived', requireApproval: false }, memberInput('Sam', 'u9'));
  assert.strictEqual(await store.removeMember(carpool.code, carpool.ownerId), null);
  assert.strictEqual(await store.getCarpool(carpool.code), null);
  await assert.rejects(store.addMember(carpool.code, memberInput('Late', 'z')), (e) => e.status === 404);
  assert.ok(!(await store.getAllCarpools()).some((c) => c.code === carpool.code));
});

test("editing one part of a rider's name keeps the other", async () => {
  const { carpool, member } = await store.createCarpoolWithOwner({ name: 'Names' }, memberInput('Jo', 'u10'));
  const { child } = await store.addChild(carpool.code, member.id, member.id, { firstName: 'Mary Kate', lastNameOverride: 'Smith' });
  assert.strictEqual(child.name, 'Mary Kate Smith');

  let res = await store.updateChild(carpool.code, member.id, member.id, child.id, { firstName: 'Anne Marie' });
  assert.strictEqual(res.child.name, 'Anne Marie Smith');
  res = await store.updateChild(carpool.code, member.id, member.id, child.id, { lastNameOverride: 'Jones' });
  assert.strictEqual(res.child.name, 'Anne Marie Jones');
});

test('riders saved before name parts were stored are split sensibly', () => {
  const [m] = normalizeMembers([
    { ...legacyMember, children: [{ id: 'c1', name: 'Mary Kate Lee' }, { id: 'c2', name: 'Sam Ortiz' }, { id: 'c3', name: 'Bo' }] },
  ]);
  assert.deepStrictEqual(
    m.children.map((c) => [c.firstName, c.lastNameOverride]),
    [['Mary Kate', ''], ['Sam', 'Ortiz'], ['Bo', '']]
  );
});

test('the schedule for coming dates stays put as days go by', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T15:00:00Z') });
  const { carpool } = await store.createCarpoolWithOwner(
    { name: 'Steady', timeZone: 'America/Chicago', requireApproval: false },
    memberInput('Ann', 'u20', { children: [{ firstName: 'A1', needsRideThereDays: [1, 3], needsRideBackDays: [1, 3] }] }),
    { dates: [], times: {}, recurrence: { weekdays: [1, 3], startDate: '2026-10-05', endDate: '2026-11-30' } }
  );
  await store.addMember(
    carpool.code,
    memberInput('Ben', 'u21', { children: [{ firstName: 'B1', needsRideThereDays: [1, 3], needsRideBackDays: [1, 3] }] })
  );
  await store.addMember(carpool.code, memberInput('Cy', 'u22', { seats: 4 }));
  const before = getScheduleResult(await store.getCarpool(carpool.code)).schedule;

  // A week and a half later, after several dates have gone by.
  t.mock.timers.setTime(Date.parse('2026-10-16T15:00:00Z'));
  const later = await store.getCarpool(carpool.code);
  assert.ok(Object.keys(later.driveHistory.dates).length >= 3);
  const after = getScheduleResult(later).schedule;
  const byDate = Object.fromEntries(before.map((e) => [e.date, e]));
  const ids = (e) => [e.there.drivers.map((d) => d.id), e.back.drivers.map((d) => d.id)];
  after.forEach((e) => assert.deepStrictEqual(ids(e), ids(byDate[e.date]), e.date));
});

test('someone joining later starts level with the others', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T15:00:00Z') });
  const { carpool } = await store.createCarpoolWithOwner(
    { name: 'Newcomer', timeZone: 'UTC', requireApproval: false },
    memberInput('Ann', 'u30', { children: [{ firstName: 'A1', needsRideThereDays: [1], needsRideBackDays: [1] }] }),
    { dates: ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'], times: {} }
  );
  await store.addMember(carpool.code, memberInput('Ben', 'u31'));
  t.mock.timers.setTime(Date.parse('2026-10-27T15:00:00Z'));
  const { member: late } = await store.addMember(carpool.code, memberInput('Cy', 'u32'));
  // 4 Mondays have passed with 2 rides each, shared by 2 people: 4 rides each.
  assert.strictEqual(late.driveCredit, 4);
});

test('the local JSON file store saves simultaneous changes too', async () => {
  const file = path.join(os.tmpdir(), `carpool-test-${process.pid}-${Date.now()}.json`);
  process.env.LOCAL_DB_FILE = file;
  try {
    const { carpool, member } = await store.createCarpoolWithOwner({ name: 'Local' }, memberInput('Lo', 'u40'));
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.addChild(carpool.code, member.id, member.id, { firstName: `K${i}` }))
    );
    assert.strictEqual((await store.getCarpool(carpool.code)).members[0].children.length, 5);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).carpools[carpool.code]);
  } finally {
    delete process.env.LOCAL_DB_FILE;
    fs.rmSync(file, { force: true });
  }
});
