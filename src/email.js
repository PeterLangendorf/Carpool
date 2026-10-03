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

function buildSummary(carpool, member, siteUrl, scheduleInfo, options = {}) {
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

  const kind = options.kind || 'welcome';
  const ownerNote = kind === 'update' && options.message ? options.message.trim() : '';
  const fromName = options.fromName || 'The organizer';
  const unsubscribe = unsubscribeUrl(carpool, member, siteUrl);

  const subject = {
    welcome: `Your carpool: ${carpool.name} (code ${carpool.code})`,
    update: `Update from ${fromName}: ${carpool.name}`,
    monthly: `Your ${monthName()} carpool schedule: ${carpool.name}`,
  }[kind];
  const intro = {
    welcome: `Here's a summary of your carpool "${carpool.name}".`,
    update: `${fromName} sent an update about your carpool "${carpool.name}".`,
    monthly: `Here's your ${monthName()} schedule for your carpool "${carpool.name}".`,
  }[kind];
  const footer = `You're getting this because you're in the "${carpool.name}" carpool.`;

  const text = [
    `Hi ${member.name},`,
    '',
    intro,
    ...(ownerNote ? ['', `Message from ${fromName}:`, ownerNote] : []),
    '',
    ...filled.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(drives ? [...drivesText(drives), ''] : []),
    `Share the join code ${carpool.code} with others in your carpool, or send them this link:`,
    link,
    '',
    footer,
    ...(unsubscribe ? [`Unsubscribe from update and monthly emails: ${unsubscribe}`] : []),
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161a;background:#ffffff;padding:20px;border-radius:12px;max-width:560px">
      <p>Hi ${escapeHtml(member.name)},</p>
      <p>${escapeHtml(intro)}</p>
      ${
        ownerNote
          ? `<div style="background:#f0f8ff;border:1px solid #9fd3f5;border-radius:12px;padding:12px 14px;margin:0 0 16px"><div style="font-size:12px;color:#6b7280;margin-bottom:4px">Message from ${escapeHtml(fromName)}</div><div style="white-space:pre-wrap">${escapeHtml(ownerNote)}</div></div>`
          : ''
      }
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
      <p style="font-size:12px;color:#6b7280;border-top:1px solid #d3e6f7;padding-top:12px;margin-top:20px">
        ${escapeHtml(footer)}
        ${unsubscribe ? `<br><a href="${escapeHtml(unsubscribe)}" style="color:#6b7280">Unsubscribe</a> from update and monthly emails.` : ''}
      </p>
    </div>
  `;

  // Lets mail apps show their own one-click "Unsubscribe" button (RFC 8058).
  const headers = unsubscribe
    ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;

  return { subject, text, html, headers };
}

function unsubscribeUrl(carpool, member, siteUrl) {
  if (!member.unsubscribeToken) return null;
  const params = new URLSearchParams({ c: carpool.code, m: member.id, t: member.unsubscribeToken });
  return `${siteUrl}/api/unsubscribe?${params}`;
}

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function resendRequest(path, body) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().catch(() => '')}`);
}

// Builds one ready-to-send email. `member` is the stored member (it needs
// `email` and `unsubscribeToken`); `scheduleInfo` ({ schedule, members },
// members normalized) adds their drives for the rest of the month.
// `options`: { kind: 'welcome' | 'update' | 'monthly', message, fromName }.
function buildEmail(carpool, member, siteUrl, scheduleInfo, options) {
  const { subject, text, html, headers } = buildSummary(carpool, member, siteUrl, scheduleInfo, options);
  return { from: process.env.EMAIL_FROM, to: [member.email], subject, text, html, ...(headers ? { headers } : {}) };
}

// Resolves to true if the email was accepted for delivery. Never throws — a
// failed email must not fail the carpool create/join that triggered it.
async function sendCarpoolSummary(to, carpool, member, siteUrl, scheduleInfo) {
  if (!to || !isEmailConfigured()) return false;
  try {
    await resendRequest('/emails', buildEmail(carpool, member, siteUrl, scheduleInfo, { kind: 'welcome' }));
    return true;
  } catch (err) {
    console.error('Summary email failed:', err);
    return false;
  }
}

// Sends many emails via Resend's batch endpoint (up to 100 per request).
// Returns how many were accepted; logs and skips any batch that fails.
const BATCH_SIZE = 100;

async function sendEmails(emails) {
  let sent = 0;
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    try {
      await resendRequest('/emails/batch', batch);
      sent += batch.length;
    } catch (err) {
      console.error('Batch email failed:', err);
    }
  }
  return sent;
}

module.exports = { sendCarpoolSummary, buildEmail, sendEmails, isEmailConfigured };
