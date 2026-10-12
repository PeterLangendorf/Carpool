// The API end to end, with Netlify Blobs faked and Clerk replaced by an
// `X-Test-User` header naming the signed-in user.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
require('./fake-blobs').install();

process.env.CLERK_PUBLISHABLE_KEY = 'pk_test';
process.env.CLERK_SECRET_KEY = 'sk_test';
const clerkPath = require.resolve('@clerk/express', { paths: [path.join(__dirname, '..')] });
require.cache[clerkPath] = {
  id: clerkPath,
  filename: clerkPath,
  loaded: true,
  exports: {
    clerkMiddleware: () => (req, res, next) => next(),
    getAuth: (req) => ({ userId: req.get('x-test-user') || null }),
    clerkClient: { users: { getUser: async () => ({ emailAddresses: [], firstName: '', lastName: '' }) } },
  },
};

const app = require('../src/app');

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(user, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Test-User': user, 'X-Time-Zone': 'America/Chicago' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const memberBody = (firstName, extra = {}) => ({
  firstName,
  lastName: 'Test',
  email: `${firstName.toLowerCase()}@example.com`,
  seats: 3,
  canDriveThereDays: [0, 1, 2, 3, 4, 5, 6],
  canDriveBackDays: [0, 1, 2, 3, 4, 5, 6],
  addresses: ['1 Main St'],
  children: [{ firstName: `${firstName}Kid`, needsRideThereDays: [0, 1, 2, 3, 4, 5, 6], needsRideBackDays: [0, 1, 2, 3, 4, 5, 6] }],
  ...extra,
});

test('join requests, ride changes and the carpools list through the API', async () => {
  // Today and the next 20 days, so some dates are locked in and some aren't.
  const today = new Date();
  const dates = Array.from({ length: 21 }, (_, i) => new Date(today.getTime() + i * 86400000).toISOString().slice(0, 10));
  const created = await call('owner', 'POST', '/api/carpools', {
    ...memberBody('Olive'),
    carpoolName: 'API carpool',
    activityName: 'Swim',
    activityLocation: 'Pool',
    dates,
    times: {},
  });
  assert.strictEqual(created.status, 201);
  const code = created.body.carpool.code;
  assert.strictEqual(created.body.carpool.requireApproval, true);

  // Someone with the code asks to join, and waits.
  const preview = await call('joiner', 'GET', `/api/carpools/${code}/preview`);
  assert.strictEqual(preview.body.isMember, false);
  const join = await call('joiner', 'POST', `/api/carpools/${code}/members`, memberBody('Jo'));
  assert.strictEqual(join.status, 202);
  assert.strictEqual((await call('joiner', 'GET', `/api/carpools/${code}/preview`)).body.isPending, true);
  assert.strictEqual((await call('joiner', 'GET', `/api/carpools/${code}`)).status, 403);

  // Only the organizer sees and answers requests.
  const ownerView = await call('owner', 'GET', `/api/carpools/${code}`);
  assert.strictEqual(ownerView.body.joinRequests.length, 1);
  const requestId = ownerView.body.joinRequests[0].id;
  const approved = await call('owner', 'POST', `/api/carpools/${code}/join-requests/${requestId}/approve`, {});
  assert.strictEqual(approved.status, 200);
  const joinerView = await call('joiner', 'GET', `/api/carpools/${code}`);
  assert.strictEqual(joinerView.status, 200);
  assert.deepStrictEqual(joinerView.body.joinRequests, [], 'members other than the organizer get no requests');
  const joinerId = joinerView.body.me.id;

  // The joiner can't make one of their rides: it goes to the organizer.
  const schedule = (await call('joiner', 'GET', `/api/carpools/${code}/schedule`)).body.schedule;
  const ride = schedule.find((e) => e.there.drivers.some((d) => d.id === joinerId));
  assert.ok(ride, 'the joiner drives something');
  const changed = await call('joiner', 'PUT', `/api/carpools/${code}/dates/${ride.date}/rides/there`, { unavailable: true });
  assert.strictEqual(changed.status, 200);
  const after = changed.body.schedule.schedule.find((e) => e.date === ride.date);
  assert.ok(!after.there.drivers.some((d) => d.id === joinerId));
  assert.ok(after.there.drivers.length > 0);
  const bad = await call('joiner', 'PUT', `/api/carpools/${code}/dates/${ride.date}/rides/sideways`, { unavailable: true });
  assert.strictEqual(bad.status, 400);

  // Both see the carpool in their list (the first call builds each list).
  for (const user of ['owner', 'joiner', 'owner']) {
    const mine = await call(user, 'GET', '/api/my-carpools');
    assert.deepStrictEqual(mine.body.carpools.map((c) => c.code), [code]);
  }
  assert.deepStrictEqual((await call('stranger', 'GET', '/api/my-carpools')).body.carpools, []);
});
