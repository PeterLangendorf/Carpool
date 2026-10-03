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

function buildSummary(carpool, member, siteUrl) {
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
    `Share the join code ${carpool.code} with others in your carpool, or send them this link:`,
    link,
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161a;max-width:520px">
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
async function sendCarpoolSummary(to, carpool, member, siteUrl) {
  if (!to || !isEmailConfigured()) return false;
  const { subject, text, html } = buildSummary(carpool, member, siteUrl);
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
