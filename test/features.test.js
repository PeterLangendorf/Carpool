const test = require('node:test');
const assert = require('node:assert');
require('./fake-blobs').install();
const store = require('../src/store');
const { getScheduleResult } = require('../src/normalize');

const memberInput = (name, userId, extra = {}) => ({
  name,
  lastName: 'X',
  userId,
  seats: 1,
  canDriveThereDays: [0, 1, 2, 3, 4, 5, 6],
  canDriveBackDays: [0, 1, 2, 3, 4, 5, 6],
  addresses: ['1 Main St'],
  children: [],
  ...extra,
});
const kid = (firstName) => ({ firstName, needsRideThereDays: [0, 1, 2, 3, 4, 5, 6], needsRideBackDays: [0, 1, 2, 3, 4, 5, 6] });
const ids = (leg) => leg.drivers.map((d) => d.id).sort();

test('new carpools ask the organizer to approve people who join', async () => {
  const { carpool } = await store.createCarpoolWithOwner({ name: 'Approve' }, memberInput('Olive', 'owner1'));
  assert.strictEqual(carpool.requireApproval, true);

  const joined = await store.addMember(carpool.code, memberInput('Jo', 'joiner1'));
  assert.strictEqual(joined.pending, true);
  let current = await store.getCarpool(carpool.code);
  assert.strictEqual(current.members.length, 1);
  assert.ok(store.findPendingRequest(current, 'joiner1'));

  const { member } = await store.approveJoinRequest(carpool.code, joined.member.id);
  assert.strictEqual(member.name, 'Jo');
  current = await store.getCarpool(carpool.code);
  assert.strictEqual(current.members.length, 2);
  assert.strictEqual(current.joinRequests.length, 0);
  await assert.rejects(store.approveJoinRequest(carpool.code, joined.member.id), (e) => e.status === 404);

  const other = await store.addMember(carpool.code, memberInput('Ned', 'joiner2'));
  await store.declineJoinRequest(carpool.code, other.member.id);
  current = await store.getCarpool(carpool.code);
  assert.strictEqual(current.members.length, 2);
  assert.strictEqual(store.findPendingRequest(current, 'joiner2'), null);

  await store.updateCarpoolDetails(carpool.code, { requireApproval: false });
  assert.strictEqual((await store.addMember(carpool.code, memberInput('Ida', 'joiner3'))).pending, false);
});

test("each user's carpool list tracks joining and leaving", async () => {
  const { carpool, member } = await store.createCarpoolWithOwner({ name: 'Index', requireApproval: false }, memberInput('Una', 'indexUser'));
  assert.strictEqual(await store.getUserCarpoolCodes('indexUser'), null, 'not complete until a full scan');
  await store.setUserCarpoolCodes('indexUser', []);
  assert.deepStrictEqual(await store.getUserCarpoolCodes('indexUser'), [carpool.code]);

  const { carpool: second } = await store.createCarpoolWithOwner({ name: 'Index 2', requireApproval: false }, memberInput('Vic', 'u2'));
  const { member: joined } = await store.addMember(second.code, memberInput('Una', 'indexUser'));
  assert.deepStrictEqual((await store.getUserCarpoolCodes('indexUser')).sort(), [carpool.code, second.code].sort());

  await store.removeMember(second.code, joined.id);
  await store.removeMember(carpool.code, member.id);
  assert.deepStrictEqual(await store.getUserCarpoolCodes('indexUser'), []);
});

test('the coming week is locked in; later dates stay fair', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T15:00:00Z') });
  // Two one-seat drivers with a rider each: both drive every ride.
  const { carpool, member: ann } = await store.createCarpoolWithOwner(
    { name: 'Locks', timeZone: 'UTC', requireApproval: false },
    memberInput('Ann', 'l1', { children: [kid('A1')] }),
    { dates: ['2026-10-06', '2026-10-08', '2026-10-27'], times: {} }
  );
  const { member: ben } = await store.addMember(carpool.code, memberInput('Ben', 'l2', { children: [kid('B1')] }));
  let current = await store.getCarpool(carpool.code);
  assert.deepStrictEqual(Object.keys(current.lockedDrives).sort(), ['2026-10-06', '2026-10-08']);

  // A newcomer with a big car would be the fairest pick from now on...
  const { member: cy } = await store.addMember(carpool.code, memberInput('Cy', 'l3', { seats: 4 }));
  current = await store.getCarpool(carpool.code);
  const byDate = Object.fromEntries(getScheduleResult(current).schedule.map((e) => [e.date, e]));
  // ...but this week's rides keep their drivers,
  assert.deepStrictEqual(ids(byDate['2026-10-06'].there), [ann.id, ben.id].sort());
  assert.deepStrictEqual(ids(byDate['2026-10-08'].back), [ann.id, ben.id].sort());
  // while later ones are scheduled as usual.
  assert.deepStrictEqual(ids(byDate['2026-10-27'].there), [cy.id]);

  // Ann can't make Tuesday's drop off: Ben keeps it and Cy fills her seat.
  await store.setRideOverride(carpool.code, '2026-10-06', 'there', ann.id, { unavailable: true });
  current = await store.getCarpool(carpool.code);
  let entry = getScheduleResult(current).schedule.find((e) => e.date === '2026-10-06');
  assert.deepStrictEqual(ids(entry.there), [ben.id, cy.id].sort());
  assert.ok(current.lockedDrives['2026-10-06'].there.includes(cy.id), 'the replacement is locked in too');
  assert.deepStrictEqual(ids(entry.back), [ann.id, ben.id].sort(), 'the other ride is untouched');

  // Ben volunteers for the later pick up, which Cy would otherwise drive alone.
  await store.setRideOverride(carpool.code, '2026-10-27', 'back', ben.id, { volunteer: true });
  current = await store.getCarpool(carpool.code);
  entry = getScheduleResult(current).schedule.find((e) => e.date === '2026-10-27');
  assert.ok(ids(entry.back).includes(ben.id));

  // Past dates can't be changed.
  await assert.rejects(store.setRideOverride(carpool.code, '2026-10-01', 'there', ann.id, { unavailable: true }), (e) => e.status === 400);
});
