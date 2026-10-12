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

// The types of `user`'s notifications, newest first.
async function notificationTypes(user) {
  return (await call(user, 'GET', '/api/notifications')).body.notifications.map((n) => n.type);
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

  // Someone with the code asks to join, and waits.
  const preview = await call('joiner', 'GET', `/api/carpools/${code}/preview`);
  assert.strictEqual(preview.body.isMember, false);
  const join = await call('joiner', 'POST', `/api/carpools/${code}/members`, memberBody('Jo'));
  assert.strictEqual(join.status, 202);
  assert.strictEqual((await call('joiner', 'GET', `/api/carpools/${code}/preview`)).body.isPending, true);
  assert.strictEqual((await call('joiner', 'GET', `/api/carpools/${code}`)).status, 403);

  // The organizer is notified, with a link to the requests in Settings.
  const [request] = (await call('owner', 'GET', '/api/notifications')).body.notifications;
  assert.strictEqual(request.type, 'join_request');
  assert.strictEqual(request.link, `/dashboard.html?code=${code}&tab=settings`);
  assert.strictEqual((await call('owner', 'GET', '/api/notifications')).body.unread, 1);

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
  assert.deepStrictEqual(await notificationTypes('joiner'), ['join_approved']);

  // Reading clears the count.
  await call('owner', 'POST', '/api/notifications/read', {});
  assert.strictEqual((await call('owner', 'GET', '/api/notifications')).body.unread, 0);

  // This week was locked in before the joiner arrived, so the organizer
  // drives it. The organizer can't make one ride: it goes to the joiner,
  // who's told.
  const ownerId = ownerView.body.me.id;
  const schedule = (await call('owner', 'GET', `/api/carpools/${code}/schedule`)).body.schedule;
  const ride = schedule.find((e) => e.locked && e.there.drivers.some((d) => d.id === ownerId));
  assert.ok(ride, 'the organizer drives something this week');
  const changed = await call('owner', 'PUT', `/api/carpools/${code}/dates/${ride.date}/rides/there`, { unavailable: true });
  assert.strictEqual(changed.status, 200);
  const after = changed.body.schedule.schedule.find((e) => e.date === ride.date);
  assert.deepStrictEqual(after.there.drivers.map((d) => d.id), [joinerId]);
  assert.strictEqual((await notificationTypes('joiner'))[0], 'ride_assigned');
  const bad = await call('joiner', 'PUT', `/api/carpools/${code}/dates/${ride.date}/rides/sideways`, { unavailable: true });
  assert.strictEqual(bad.status, 400);

  // The organizer drops the last date: the joiner is told, the organizer isn't.
  const edited = await call('owner', 'PUT', `/api/carpools/${code}/activity-dates`, { dates: dates.slice(0, -1), times: {} });
  assert.strictEqual(edited.status, 200);
  const [datesNote] = (await call('joiner', 'GET', '/api/notifications')).body.notifications;
  assert.strictEqual(datesNote.type, 'dates_changed');
  assert.match(datesNote.text, /1 date removed/);
  assert.notStrictEqual((await notificationTypes('owner'))[0], 'dates_changed');

  // So are name and location changes.
  await call('owner', 'PATCH', `/api/carpools/${code}/details`, { activityLocation: 'Lake' });
  assert.strictEqual((await notificationTypes('joiner'))[0], 'details_changed');

  // Both see the carpool in their list (the first call builds each list).
  for (const user of ['owner', 'joiner', 'owner']) {
    const mine = await call(user, 'GET', '/api/my-carpools');
    assert.deepStrictEqual(mine.body.carpools.map((c) => c.code), [code]);
  }
  assert.deepStrictEqual((await call('stranger', 'GET', '/api/my-carpools')).body.carpools, []);

  // When the joiner leaves, the organizer is told.
  await call('joiner', 'DELETE', `/api/carpools/${code}/members/${joinerId}`, {});
  assert.strictEqual((await notificationTypes('owner'))[0], 'member_left');
});

test("a declined request is cleared and the person who asked is told", async () => {
  const created = await call('owner2', 'POST', '/api/carpools', {
    ...memberBody('Pat'),
    carpoolName: 'Closed carpool',
    activityName: 'Chess',
    activityLocation: 'Library',
  });
  const code = created.body.carpool.code;
  await call('asker', 'POST', `/api/carpools/${code}/members`, memberBody('Ash'));
  const requestId = (await call('owner2', 'GET', `/api/carpools/${code}`)).body.joinRequests[0].id;
  assert.strictEqual((await call('asker', 'POST', `/api/carpools/${code}/join-requests/${requestId}/approve`, {})).status, 403);
  await call('owner2', 'POST', `/api/carpools/${code}/join-requests/${requestId}/decline`, {});
  assert.deepStrictEqual((await call('owner2', 'GET', `/api/carpools/${code}`)).body.joinRequests, []);
  assert.deepStrictEqual(await notificationTypes('asker'), ['join_declined']);
  assert.strictEqual((await call('asker', 'GET', `/api/carpools/${code}/preview`)).body.isPending, false);
});

test('addresses remember whether they were picked from the map suggestions', async () => {
  const created = await call('mapper', 'POST', '/api/carpools', {
    ...memberBody('Max', { addresses: ['1 Main St, Springfield, IL', '2 Side Rd'], addressesVerified: [true, false] }),
    carpoolName: 'Map carpool',
    activityName: 'Soccer',
    activityLocation: 'Pine Hill Park',
    activityLocationVerified: false,
  });
  const { code, members } = created.body.carpool;
  assert.deepStrictEqual(members[0].addresses.map((a) => Boolean(a.verified)), [true, false]);
  assert.strictEqual(created.body.carpool.activityLocationVerified, false);

  const saved = await call('mapper', 'PUT', `/api/carpools/${code}/members/${members[0].id}/addresses`, {
    addresses: [{ id: members[0].addresses[1].id, address: '2 Side Rd, Springfield, IL', verified: true }],
  });
  assert.deepStrictEqual(saved.body.carpool.members[0].addresses.map((a) => a.verified), [true]);

  const edited = await call('mapper', 'PATCH', `/api/carpools/${code}/details`, { activityLocation: '5 Park Ave', activityLocationVerified: true });
  assert.strictEqual(edited.body.activityLocationVerified, true);
});

test('address suggestions come through the server, which keeps the Mapbox token', async (t) => {
  const realFetch = globalThis.fetch;
  const mapboxCalls = [];
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.MAPBOX_TOKEN;
  });
  // Stand in for Mapbox; everything else (calls to our server) goes through.
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.mapbox.com/')) {
      mapboxCalls.push(new URL(url));
      const body = { suggestions: [{ full_address: '1 Main St, Springfield, Illinois 62701, United States' }, { full_address: '1 Main Ave, Springfield, Illinois 62702, United States' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, options);
  };
  const ask = (query, headers = { 'Sec-Fetch-Site': 'same-origin' }) => realFetch(`${base}/api/address-suggestions?${query}`, { headers });

  // Not set up: the boxes stay plain.
  assert.strictEqual((await ask('q=1+Main')).status, 503);

  process.env.MAPBOX_TOKEN = 'pk.secret-token';
  const res = await ask('q=1+Main&session=0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('secret-token'), 'the token never reaches the browser');
  assert.deepStrictEqual(JSON.parse(text).suggestions, ['1 Main St, Springfield, Illinois 62701', '1 Main Ave, Springfield, Illinois 62702']);
  const [sent] = mapboxCalls;
  assert.strictEqual(sent.searchParams.get('access_token'), 'pk.secret-token');
  assert.strictEqual(sent.searchParams.get('session_token'), '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.strictEqual(sent.searchParams.get('country'), 'us');

  // Visitor location from Netlify, when it's there, puts nearby addresses first.
  const geo = Buffer.from(JSON.stringify({ country: { code: 'CA' }, latitude: 43.65, longitude: -79.38 })).toString('base64');
  await ask('q=1+Main', { 'Sec-Fetch-Site': 'same-origin', 'X-Nf-Geo': geo });
  assert.strictEqual(mapboxCalls[1].searchParams.get('proximity'), '-79.38,43.65');
  assert.strictEqual(mapboxCalls[1].searchParams.get('country'), 'ca');

  // Other websites' pages are turned away, and short queries don't reach Mapbox.
  assert.strictEqual((await ask('q=1+Main', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.strictEqual((await ask('q=1+Main', {})).status, 403);
  assert.deepStrictEqual(await (await ask('q=1')).json(), { suggestions: [] });
  assert.strictEqual(mapboxCalls.length, 2);

  // Too many requests from one visitor in a minute.
  const statuses = [];
  for (let i = 0; i < 65; i++) statuses.push((await ask('q=1')).status);
  assert.ok(statuses.includes(429));
});

test("members need rides, or drive, or both, but not neither", async () => {
  // Rides only: 0 seats, so no driving days are saved even if some were sent.
  const created = await call('host', 'POST', '/api/carpools', {
    ...memberBody('Hana', { seats: 0, canDriveThereDays: [1, 2], canDriveBackDays: [1] }),
    carpoolName: 'Riders only',
    activityName: 'Piano',
    activityLocation: 'Music school',
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const [host] = created.body.carpool.members;
  assert.deepStrictEqual([host.canDriveThereDays, host.canDriveBackDays], [[], []], '0 seats means not driving');
  const code = created.body.carpool.code;

  // Driving only: no riders.
  const driver = await call('driverOnly', 'POST', `/api/carpools/${code}/members`, {
    ...memberBody('Dev', { canDriveThereDays: [1], canDriveBackDays: [] }),
    children: [],
    addresses: [],
  });
  assert.strictEqual(driver.status, 202, JSON.stringify(driver.body));

  // Neither: refused, with the reason.
  const idle = await call('idle', 'POST', `/api/carpools/${code}/members`, {
    ...memberBody('Ivy', { seats: 4, canDriveThereDays: [], canDriveBackDays: [] }),
    children: [],
    addresses: [],
  });
  assert.strictEqual(idle.status, 400);
  assert.match(idle.body.errors.join(' '), /Pick at least one day you can drive/);
  const noSeats = await call('idle', 'POST', `/api/carpools/${code}/members`, {
    ...memberBody('Ivy', { seats: 0, canDriveThereDays: [1], canDriveBackDays: [1] }),
    children: [],
    addresses: [],
  });
  assert.strictEqual(noSeats.status, 400, 'days without seats is not driving');
});

test('each member gets a private calendar feed of their rides', async () => {
  const today = new Date();
  const dates = Array.from({ length: 7 }, (_, i) => new Date(today.getTime() + (i + 1) * 86400000).toISOString().slice(0, 10));
  const created = await call('calOwner', 'POST', '/api/carpools', {
    ...memberBody('Cal'),
    carpoolName: 'Calendar, carpool; test',
    activityName: 'Swim',
    activityLocation: '1 Pool Rd, Springfield',
    dates,
    times: { uniform: { there: '07:30', back: '16:00' } },
  });
  const code = created.body.carpool.code;

  const { body: link } = await call('calOwner', 'GET', `/api/carpools/${code}/calendar`);
  assert.match(link.url, new RegExp(`/api/calendar/${code}/m_[^/]+/[0-9a-f]{32}\\.ics$`));
  // The token stays out of everything else the API sends.
  const view = await call('calOwner', 'GET', `/api/carpools/${code}`);
  assert.ok(!JSON.stringify(view.body).includes(link.url.split('/').pop().replace('.ics', '')));

  const feedPath = new URL(link.url).pathname;
  const res = await fetch(base + feedPath);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  const ics = await res.text();
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'lines are folded');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(String.raw`SUMMARY:Drive: drop off · Calendar\, carpool\; test`), 'commas and semicolons escaped');
  assert.ok(unfolded.includes(String.raw`LOCATION:1 Pool Rd\, Springfield`));
  // The test requests say America/Chicago: a 7:30 drop off ends at 12:30 or 13:30 UTC.
  assert.match(unfolded, /DTEND:\d{8}T1[23]3000Z/);
  assert.strictEqual((unfolded.match(/BEGIN:VEVENT/g) || []).length, dates.length * 2);

  // A wrong token, or the old one after a reset, gets nothing.
  assert.strictEqual((await fetch(base + feedPath.replace(/[0-9a-f]{32}/, '0'.repeat(32)))).status, 404);
  const { body: fresh } = await call('calOwner', 'POST', `/api/carpools/${code}/calendar/reset`, {});
  assert.notStrictEqual(fresh.url, link.url);
  assert.strictEqual((await fetch(base + feedPath)).status, 404);
  assert.strictEqual((await fetch(base + new URL(fresh.url).pathname)).status, 200);

  // Only members can get a link.
  assert.strictEqual((await call('stranger', 'GET', `/api/carpools/${code}/calendar`)).status, 403);
});
