// Sends a carpool's members their personalized summary + schedule email,
// either as an owner-triggered update or as the monthly schedule email.
const store = require('./store');
const { buildEmail, sendEmails, isEmailConfigured } = require('./email');
const { getEffectiveOwnerId, normalizeMembers, getScheduleResult } = require('./normalize');

function recipients(carpool) {
  return carpool.members.filter((m) => m.email && !m.emailOptOut);
}

// `carpool` must come from store.prepareCarpoolsForEmail so every
// recipient has an unsubscribe token. Returns { sent, skipped }.
async function emailCarpool(carpool, siteUrl, { kind, message }) {
  const scheduleInfo = { schedule: getScheduleResult(carpool).schedule, members: normalizeMembers(carpool.members) };
  const owner = carpool.members.find((m) => m.id === getEffectiveOwnerId(carpool));
  const to = recipients(carpool);
  const emails = to.map((m) =>
    buildEmail(carpool, m, siteUrl, scheduleInfo, { kind, message, fromName: owner ? owner.name : undefined })
  );
  const sent = await sendEmails(emails);
  return { sent, skipped: carpool.members.length - to.length, failed: to.length - sent };
}

// Limited to one per carpool per 24 hours (throws a 429 error otherwise).
// Returns { sent, skipped, failed, lastUpdateEmailAt }.
async function sendUpdateEmail(code, siteUrl, message) {
  const [carpool] = await store.prepareCarpoolsForEmail({ code, claimUpdateSlot: true });
  const claimedAt = carpool.lastUpdateEmailAt;
  const result = await emailCarpool(carpool, siteUrl, { kind: 'update', message });
  if (result.sent === 0) {
    const released = await store.releaseUpdateEmailSlot(code, claimedAt);
    return { ...result, lastUpdateEmailAt: released.lastUpdateEmailAt || null };
  }
  return { ...result, lastUpdateEmailAt: claimedAt };
}

// Run on the 1st of each month by netlify/functions/monthly-email.mjs.
// Skips carpools with nothing scheduled this month.
async function sendMonthlyEmails(siteUrl) {
  if (!isEmailConfigured()) return { carpools: 0, sent: 0, note: 'email not configured' };
  const monthKey = new Date().toISOString().slice(0, 7);
  const carpools = await store.prepareCarpoolsForEmail({ monthlyOnly: true });
  let emailed = 0;
  let sent = 0;
  for (const carpool of carpools) {
    if (!(carpool.activityDates || []).some((d) => d.startsWith(monthKey))) continue;
    const result = await emailCarpool(carpool, siteUrl, { kind: 'monthly' });
    emailed++;
    sent += result.sent;
  }
  return { carpools: emailed, sent };
}

module.exports = { sendUpdateEmail, sendMonthlyEmails };
