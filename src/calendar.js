// A member's carpool schedule as an iCalendar feed, for subscribing from
// Apple Calendar, Google Calendar, Outlook and so on (the dashboard's Export
// tab). Calendar apps can't sign in, so the feed is reached by a private link
// with a secret per-member token (`member.calendarToken`; see the routes in
// src/app.js). It holds the member's upcoming drives and their riders' rides,
// and apps re-fetch it to pick up schedule changes.
const { computeSchedule, normalizeMembers } = require('./normalize');
const { rideStops } = require('./email');
const { isValidTimeZone } = require('./dates');

// Drives are shown as half-hour events: drop offs ending when the activity
// starts, pick ups starting when it ends.
const RIDE_MINUTES = 30;

// Text values: backslashes, semicolons, commas and newlines are escaped.
function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 bytes are folded (continued on lines starting with a
// space), without splitting a character.
function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

// The UTC instant of a wall-clock time in `timeZone`.
function zonedToUtc(dateKey, hhmm, timeZone) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // How far the zone is from UTC at instant `t`.
  const offsetAt = (t) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t); // second pass for times near a daylight-saving change
  return new Date(t);
}

const utcStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// DTSTART/DTEND for one ride. With a known time zone, exact UTC times; without
// one, "floating" local times (shown at that clock time wherever the reader
// is). With no time set, an all-day event.
function rideTimes(dateKey, time, leg, timeZone) {
  if (!time) {
    const next = new Date(Date.parse(`${dateKey}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return [`DTSTART;VALUE=DATE:${dateKey.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next.replace(/-/g, '')}`];
  }
  const shift = leg === 'there' ? -RIDE_MINUTES : RIDE_MINUTES;
  if (isValidTimeZone(timeZone)) {
    const anchor = zonedToUtc(dateKey, time, timeZone);
    const other = new Date(anchor.getTime() + shift * 60000);
    const [start, end] = leg === 'there' ? [other, anchor] : [anchor, other];
    return [`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`];
  }
  // Wall-clock arithmetic done in UTC, then written without a zone.
  const wall = new Date(`${dateKey}T${time}:00Z`);
  const shifted = new Date(wall.getTime() + shift * 60000);
  const floating = (d) => utcStamp(d).replace(/Z$/, '');
  const [start, end] = leg === 'there' ? [shifted, wall] : [wall, shifted];
  return [`DTSTART:${floating(start)}`, `DTEND:${floating(end)}`];
}

// The feed for `member` (as stored) of `carpool`. `siteUrl` is for links.
function buildCalendar(carpool, member, siteUrl) {
  const members = normalizeMembers(carpool.members);
  const me = members.find((m) => m.id === member.id);
  const link = `${siteUrl}/dashboard.html?code=${encodeURIComponent(carpool.code)}`;
  const stamp = utcStamp(new Date());
  const { schedule } = computeSchedule(carpool);

  const events = [];
  schedule.forEach((entry) => {
    ['there', 'back'].forEach((leg) => {
      const ride = entry[leg];
      if (!ride.children.length) return;
      const driving = ride.drivers.some((d) => d.id === me.id);
      const myRiders = ride.children.filter((c) => c.parentId === me.id);
      if (!driving && !myRiders.length) return;

      const legName = leg === 'there' ? 'drop off' : 'pick up';
      const drivers = ride.drivers.map((d) => d.name).join(' & ');
      const lines = [];
      let summary;
      if (driving) {
        summary = `Drive: ${legName} · ${carpool.name}`;
        const others = ride.drivers.filter((d) => d.id !== me.id).map((d) => d.name);
        if (others.length) lines.push(`Also driving: ${others.join(' & ')}`);
        lines.push('Stops:');
        rideStops(carpool, members, me, entry, leg).forEach((stop, i) => {
          lines.push(`${i + 1}. ${stop.address || 'No address on file'} (${stop.note})`);
        });
      } else if (ride.noDriverAvailable) {
        summary = `Needs a driver: ${legName} · ${carpool.name}`;
        lines.push(`Riders: ${myRiders.map((c) => c.name).join(', ')}`, 'No one is available to drive this ride yet.');
      } else {
        summary = `Ride: ${legName} with ${drivers} · ${carpool.name}`;
        lines.push(`Riders: ${myRiders.map((c) => c.name).join(', ')}`, `Driver: ${drivers}`);
      }
      lines.push('', `Open the carpool: ${link}`);

      const time = leg === 'there' ? entry.thereTime : entry.backTime;
      events.push([
        'BEGIN:VEVENT',
        `UID:${carpool.code}-${entry.date}-${leg}-${me.id}@carpooler`,
        `DTSTAMP:${stamp}`,
        ...rideTimes(entry.date, time, leg, carpool.timeZone),
        `SUMMARY:${escapeText(summary)}`,
        ...(carpool.activityLocation ? [`LOCATION:${escapeText(carpool.activityLocation)}`] : []),
        `DESCRIPTION:${escapeText(lines.join('\n'))}`,
        `URL:${link}`,
        'END:VEVENT',
      ]);
    });
  });

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Carpooler//Carpool schedule//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${carpool.name} (Carpooler)`)}`,
    ...(isValidTimeZone(carpool.timeZone) ? [`X-WR-TIMEZONE:${carpool.timeZone}`] : []),
    // Hints for how often apps should check for changes.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...events.flat(),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, zonedToUtc };
