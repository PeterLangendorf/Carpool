// In-app notifications: what each person is told, and when. Each is saved to
// the recipient's inbox (store.addNotification) and shown under the bell on
// the home screen and carpool pages (public/notifications.js). Only members
// with a sign-in (`userId`) can receive them. Sending never throws: a failed
// notification mustn't fail the change that caused it.
const store = require('./store');
const { getEffectiveOwnerId } = require('./normalize');
const { todayKey } = require('./dates');
const { formatDate } = require('./email');

function carpoolLink(carpool, tab) {
  return `/dashboard.html?code=${encodeURIComponent(carpool.code)}${tab ? `&tab=${tab}` : ''}`;
}

async function send(userIds, carpool, type, text, link = carpoolLink(carpool)) {
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(
    unique.map((userId) =>
      store
        .addNotification(userId, { type, text, carpoolCode: carpool.code, carpoolName: carpool.name, link })
        .catch((err) => console.error('Notification failed:', err))
    )
  );
}

// The sign-in IDs of a carpool's members, leaving out `exceptMemberIds`.
function memberUsers(carpool, exceptMemberIds = []) {
  return carpool.members.filter((m) => !exceptMemberIds.includes(m.id)).map((m) => m.userId);
}

function organizer(carpool) {
  return carpool.members.find((m) => m.id === getEffectiveOwnerId(carpool)) || null;
}

// The organizer: someone asked to join.
async function joinRequested(carpool, requester) {
  const owner = organizer(carpool);
  if (!owner) return;
  await send([owner.userId], carpool, 'join_request', `${requester.name} asked to join ${carpool.name}.`, carpoolLink(carpool, 'settings'));
}

// The newcomer: they're in. Everyone else but the organizer (who approved
// them): who joined.
async function joinApproved(carpool, member) {
  const owner = organizer(carpool);
  await send([member.userId], carpool, 'join_approved', `You're in! Your request to join ${carpool.name} was approved.`);
  await send(memberUsers(carpool, [member.id, owner && owner.id]), carpool, 'member_joined', `${member.name} joined ${carpool.name}.`, carpoolLink(carpool, 'people'));
}

// The person who asked: their request was turned down.
async function joinDeclined(carpool, request) {
  await send([request.userId], carpool, 'join_declined', `Your request to join ${carpool.name} wasn't approved.`, '/');
}

// Everyone left: who left, and the new organizer if it was the organizer.
async function memberLeft(before, after, departing) {
  if (!after) return;
  await send(memberUsers(after), after, 'member_left', `${departing.name} left ${after.name}.`, carpoolLink(after, 'people'));
  const newOwnerId = getEffectiveOwnerId(after);
  if (newOwnerId !== getEffectiveOwnerId(before)) {
    const owner = organizer(after);
    if (owner) await send([owner.userId], after, 'now_organizer', `${departing.name} left, so you're now the organizer of ${after.name}.`, carpoolLink(after, 'settings'));
  }
}

// Everyone but the organizer: the dates or times changed. Only upcoming
// dates count, so the window rolling forward isn't reported.
async function datesChanged(before, after, editor) {
  const today = todayKey(after.timeZone);
  const upcoming = (c) => new Set((c.activityDates || []).filter((d) => d >= today));
  const was = upcoming(before);
  const now = upcoming(after);
  const added = [...now].filter((d) => !was.has(d)).length;
  const removed = [...was].filter((d) => !now.has(d)).length;
  const timesChanged = JSON.stringify(before.activityTimes || {}) !== JSON.stringify(after.activityTimes || {});
  const parts = [];
  if (added) parts.push(`${added} date${added === 1 ? '' : 's'} added`);
  if (removed) parts.push(`${removed} date${removed === 1 ? '' : 's'} removed`);
  if (timesChanged) parts.push('times changed');
  if (!parts.length) return;
  await send(memberUsers(after, [editor.id]), after, 'dates_changed', `${editor.name} changed the schedule for ${after.name}: ${parts.join(', ')}.`);
}

// Everyone but the organizer: the carpool's name, activity or location changed.
async function detailsChanged(before, after, editor) {
  const parts = [];
  if (before.name !== after.name) parts.push(`renamed it to "${after.name}"`);
  if ((before.activityName || '') !== (after.activityName || '')) parts.push(`changed the activity to ${after.activityName}`);
  if ((before.activityLocation || '') !== (after.activityLocation || '')) parts.push(`moved it to ${after.activityLocation}`);
  if (!parts.length) return;
  const name = before.name !== after.name ? before.name : after.name;
  await send(memberUsers(after, [editor.id]), after, 'details_changed', `${editor.name} ${parts.join(' and ')} (${name}).`);
}

// After someone says they can't make a ride or offers to drive one in the
// locked coming week: whoever was put on it, and whoever was taken off.
async function rideChanged(carpool, date, leg, actor, addedIds, removedIds) {
  const ride = `${leg === 'there' ? 'drop off' : 'pick up'} on ${formatDate(date)}`;
  const userOf = (id) => (carpool.members.find((m) => m.id === id) || {}).userId;
  await send(
    addedIds.filter((id) => id !== actor.id).map(userOf),
    carpool,
    'ride_assigned',
    `${actor.name} can't make the ${ride} for ${carpool.name}, so you're driving it now.`
  );
  await send(
    removedIds.filter((id) => id !== actor.id).map(userOf),
    carpool,
    'ride_taken',
    `${actor.name} is driving the ${ride} for ${carpool.name} instead of you.`
  );
}

module.exports = { joinRequested, joinApproved, joinDeclined, memberLeft, datesChanged, detailsChanged, rideChanged };
