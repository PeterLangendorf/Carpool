// Sign-in via Clerk (https://clerk.com). Every carpool route requires a
// signed-in user, and a user can only read or change a carpool they're a
// member of: members are tied to a Clerk user by `member.userId`.
//
// Needs CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY. Without them, signed-in
// routes answer 503 instead of crashing (Clerk's middleware throws when its
// keys are missing).
const { clerkMiddleware, clerkClient, getAuth } = require('@clerk/express');
const store = require('./store');

function isAuthConfigured() {
  return Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

let clerk = null;

// Express middleware: 401 unless the request carries a valid Clerk session
// (the frontend sends it as `Authorization: Bearer <token>`); sets req.userId.
function requireUser(req, res, next) {
  if (!isAuthConfigured()) return res.status(503).json({ errors: ["Sign-in isn't set up yet"] });
  clerk = clerk || clerkMiddleware();
  clerk(req, res, (err) => {
    if (err) return next(err);
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ errors: ['Please sign in'] });
    req.userId = userId;
    next();
  });
}

// The user's name and emails from Clerk. Only verified emails are trusted for
// linking older members by email.
async function getUserProfile(userId) {
  const user = await clerkClient.users.getUser(userId);
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  return {
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    email: primary ? primary.emailAddress : '',
    verifiedEmails: user.emailAddresses
      .filter((e) => e.verification && e.verification.status === 'verified')
      .map((e) => e.emailAddress),
  };
}

function hasUnlinkedMembers(carpool) {
  return carpool.members.some((m) => !m.userId && m.email);
}

// The carpool and the signed-in user's member in it (null if they aren't
// one). Members from before sign-in existed are claimed by verified email the
// first time their owner signs in. Throws 404 if there's no such carpool.
async function getMembership(req, code) {
  let carpool = await store.getCarpool(code, { timeZone: req.get('x-time-zone') });
  if (!carpool) {
    const err = new Error('Carpool not found');
    err.status = 404;
    throw err;
  }
  let member = carpool.members.find((m) => m.userId === req.userId) || null;
  if (!member && hasUnlinkedMembers(carpool)) {
    const { verifiedEmails } = await getUserProfile(req.userId);
    [carpool] = await store.linkMembersByEmail(req.userId, verifiedEmails, code);
    member = carpool.members.find((m) => m.userId === req.userId) || null;
  }
  return { carpool, member };
}

// Express middleware (after requireUser): 403 unless the signed-in user is a
// member of :code; sets req.carpool and req.member.
async function requireMember(req, res, next) {
  try {
    const { carpool, member } = await getMembership(req, req.params.code);
    if (!member) {
      return res.status(403).json({ errors: ["You're not a member of this carpool"], notMember: true });
    }
    req.carpool = carpool;
    req.member = member;
    next();
  } catch (err) {
    res.status(err.status || 500).json({ errors: [err.message] });
  }
}

// Every carpool the signed-in user is a member of. Read from their own list
// of carpool codes (see src/store.js); the first time, when there's no list
// yet, it scans every carpool, claiming any older members of theirs by
// verified email, and saves the list.
async function getUserCarpools(userId) {
  const mine = (carpools) =>
    carpools.map((carpool) => ({ carpool, member: carpool.members.find((m) => m.userId === userId) })).filter(({ member }) => member);

  const codes = await store.getUserCarpoolCodes(userId);
  if (codes) return mine(await store.getCarpools(codes));

  let carpools = await store.getAllCarpools();
  if (carpools.some((c) => hasUnlinkedMembers(c) && !c.members.some((m) => m.userId === userId))) {
    const { verifiedEmails } = await getUserProfile(userId);
    carpools = await store.linkMembersByEmail(userId, verifiedEmails);
  }
  const result = mine(carpools);
  await store.setUserCarpoolCodes(userId, result.map(({ carpool }) => carpool.code));
  return result;
}

module.exports = { isAuthConfigured, requireUser, requireMember, getMembership, getUserProfile, getUserCarpools };
