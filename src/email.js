// Sends the "here's your carpool" summary email via Resend's HTTP API.
// Disabled (a silent no-op) unless both RESEND_API_KEY and EMAIL_FROM are
// set in the Netlify site's environment variables, so local dev and
// unconfigured deploys keep working without an email provider.

const FULL_DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(hhmm) {
  if (!hhmm) return '?';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function dayList(days) {
  const sorted = (days || []).slice().sort();
  return sorted.length ? sorted.map((d) => FULL_DAY_LABELS[d]).join(', ') : 'None';
}

function scheduleLine(carpool) {
  const r = carpool.recurrence;
  if (r) {
    const days = r.weekdays.map((d) => FULL_DAY_LABELS[d]).join(', ');
    return r.endDate
      ? `Every ${days}, ${formatDate(r.startDate)} through ${formatDate(r.endDate)}`
      : `Every ${days}, starting ${formatDate(r.startDate)}`;
  }
  const dates = carpool.activityDates || [];
  if (!dates.length) return 'No dates set yet';
  const shown = dates.slice(0, 10).map(formatDate).join(', ');
  return dates.length > 10 ? `${shown}, and ${dates.length - 10} more` : shown;
}

function timesLine(activityTimes) {
  const times = activityTimes || {};
  const perWeekday = Object.entries(times.perWeekday || {});
  if (perWeekday.length) {
    return perWeekday
      .map(([w, t]) => `${FULL_DAY_LABELS[w]}: drop off ${formatTime(t.there)}, pick up ${formatTime(t.back)}`)
      .join('; ');
  }
  if (times.uniform && times.uniform.there) {
    return `Drop off ${formatTime(times.uniform.there)}, pick up ${formatTime(times.uniform.back)}`;
  }
  return 'Varies by date';
}

function mapsUrl(address) {
  return `https://maps.apple.com/?address=${encodeURIComponent(address)}`;
}

// Mirrors the dashboard's rideAddressFor: the address a member picked for
// this leg + weekday, falling back to their first address.
function rideAddressFor(member, leg, weekday) {
  const addresses = (member && member.addresses) || [];
  const chosenId = member && member.rideAddresses && member.rideAddresses[leg] && member.rideAddresses[leg][weekday];
  const match = addresses.find((a) => a.id === chosenId) || addresses[0];
  return match ? match.address : null;
}

// Stops for one ride, in driving order — the same list the dashboard's
// "Start route" shows. Drop off: rider pickups, then the activity. Pick up:
// the activity, then rider drop-offs.
function rideStops(carpool, members, driver, entry, leg) {
  const legData = entry[leg];
  const groups = new Map();
  legData.children.forEach((c) => {
    // With a single address, the driver's own riders start/end at home with them.
    if (c.parentId === driver.id && (driver.addresses || []).length <= 1) return;
    const parent = members.find((m) => m.id === c.parentId);
    const address = rideAddressFor(parent, leg, entry.weekday);
    const key = `${c.parentId}|${address || ''}`;
    if (!groups.has(key)) groups.set(key, { address, riders: [] });
    groups.get(key).riders.push(c.name);
  });
  const riderStops = Array.from(groups.values()).map((g) => ({
    address: g.address,
    note: `${leg === 'there' ? 'Pick up' : 'Drop off'} ${g.riders.join(', ')}`,
  }));
  const activityStop = { address: carpool.activityLocation || null, note: carpool.activityName || 'Activity' };
  return leg === 'there' ? [...riderStops, activityStop] : [activityStop, ...riderStops];
}

// Every ride `member` is scheduled to drive from today to the end of the
// current month.
function drivesThisMonth(carpool, member, schedule, members) {
  const monthKey = new Date().toISOString().slice(0, 7);
  const rows = [];
  (schedule || [])
    .filter((e) => e.date.startsWith(monthKey))
    .forEach((entry) => {
      ['there', 'back'].forEach((leg) => {
        if (!entry[leg].drivers.some((d) => d.id === member.id)) return;
        rows.push({
          date: entry.date,
          ride: leg === 'there' ? 'Drop off' : 'Pick up',
          time: leg === 'there' ? entry.thereTime : entry.backTime,
          stops: rideStops(carpool, members, members.find((m) => m.id === member.id) || member, entry, leg),
        });
      });
    });
  return rows;
}

function monthName() {
  return new Date().toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

function drivesHtml(rows) {
  const heading = `<h3 style="font-size:16px;margin:24px 0 8px">Your drives for the rest of ${monthName()}</h3>`;
  if (!rows.length) {
    return `${heading}<p style="font-size:14px;color:#6b7280">You're not scheduled to drive for the rest of ${monthName()}.</p>`;
  }
  const cell = 'padding:8px;border-bottom:1px solid #d3e6f7;vertical-align:top;font-size:14px';
  const head = 'padding:8px;border-bottom:2px solid #d3e6f7;text-align:left;font-size:12px;color:#6b7280';
  const body = rows
    .map((r) => {
      const stops = r.stops
        .map((st, i) => {
          const place = st.address
            ? `<a href="${escapeHtml(mapsUrl(st.address))}" style="color:#0ea5e9;font-weight:600;text-decoration:none">${escapeHtml(st.address)}</a>`
            : '<span style="color:#6b7280">No address on file</span>';
          return `<div style="margin-bottom:4px">${i + 1}. ${place}<br><span style="color:#6b7280;font-size:12px">${escapeHtml(st.note)}</span></div>`;
        })
        .join('');
      return `<tr><td style="${cell};white-space:nowrap">${escapeHtml(formatDate(r.date))}</td><td style="${cell};white-space:nowrap">${escapeHtml(r.ride)}<br><span style="color:#6b7280">${escapeHtml(formatTime(r.time))}</span></td><td style="${cell}">${stops}</td></tr>`;
    })
    .join('');
  return `${heading}
      <table style="border-collapse:collapse;width:100%">
        <tr><th style="${head}">Date</th><th style="${head}">Ride</th><th style="${head}">Stops</th></tr>
        ${body}
      </table>
      <p style="font-size:12px;color:#6b7280">This is the schedule as of today. It can change as people join or update their availability, so check the app for the latest.</p>`;
}

function drivesText(rows) {
  if (!rows.length) return [`You're not scheduled to drive for the rest of ${monthName()}.`];
  return [
    `Your drives for the rest of ${monthName()}:`,
    ...rows.map(
      (r) =>
        `- ${formatDate(r.date)}, ${r.ride} at ${formatTime(r.time)}: ` +
        r.stops.map((st) => `${st.address || 'No address on file'} (${st.note}) ${st.address ? mapsUrl(st.address) : ''}`.trim()).join(' -> ')
    ),
    '(Schedule as of today; check the app for the latest.)',
  ];
}

function buildSummary(carpool, member, siteUrl, scheduleInfo) {
  const drives = scheduleInfo ? drivesThisMonth(carpool, member, scheduleInfo.schedule, scheduleInfo.members) : null;
  const link = `${siteUrl}/?code=${encodeURIComponent(carpool.code)}&tab=join`;
  const riders = (member.children || []).map((c) => c.name);
  const firstChild = (member.children || [])[0];

  const rows = [
    ['Join code', carpool.code],
    ['Activity', carpool.activityName || ''],
    ['Location', carpool.activityLocation || ''],
    ['Schedule', scheduleLine(carpool)],
    ['Times', timesLine(carpool.activityTimes)],
    ['Your riders', riders.length ? riders.join(', ') : 'None (driving only)'],
  ];
  if (firstChild) {
    rows.push(['Rides needed (drop off)', dayList(firstChild.needsRideThereDays)]);
    rows.push(['Rides needed (pick up)', dayList(firstChild.needsRideBackDays)]);
  }
  rows.push(['You can drive (drop off)', dayList(member.canDriveThereDays)]);
  rows.push(['You can drive (pick up)', dayList(member.canDriveBackDays)]);
  if ((member.addresses || []).length) {
    rows.push(['Your addresses', member.addresses.map((a) => a.address).join('; ')]);
  }
  const filled = rows.filter(([, v]) => v);

  const subject = `Your carpool: ${carpool.name} (code ${carpool.code})`;
  const text = [
    `Hi ${member.name},`,
    '',
    `Here's a summary of your carpool "${carpool.name}".`,
    '',
    ...filled.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(drives ? [...drivesText(drives), ''] : []),
    `Share the join code ${carpool.code} with others in your carpool, or send them this link:`,
    link,
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161a;background:#ffffff;padding:20px;border-radius:12px;max-width:560px">
      <p>Hi ${escapeHtml(member.name)},</p>
      <p>Here's a summary of your carpool <strong>${escapeHtml(carpool.name)}</strong>.</p>
      <p style="font-family:Menlo,monospace;font-size:28px;font-weight:700;letter-spacing:4px;text-align:center;padding:14px;border:2px dashed #0ea5e9;border-radius:12px;background:#eaf4fc">${escapeHtml(carpool.code)}</p>
      <table style="border-collapse:collapse;font-size:14px">
        ${filled
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`
          )
          .join('')}
      </table>
      ${drives ? drivesHtml(drives) : ''}
      <p>Share the join code with others in your carpool, or send them this link:<br><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
    </div>
  `;

  return { subject, text, html };
}

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// Resolves to true if the email was accepted for delivery. Never throws — a
// failed email must not fail the carpool create/join that triggered it.
// `scheduleInfo` ({ schedule, members }, members normalized) adds the
// member's drives for the rest of the month.
async function sendCarpoolSummary(to, carpool, member, siteUrl, scheduleInfo) {
  if (!to || !isEmailConfigured()) return false;
  const { subject, text, html } = buildSummary(carpool, member, siteUrl, scheduleInfo);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      console.error('Summary email failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Summary email failed:', err);
    return false;
  }
}

module.exports = { sendCarpoolSummary };
