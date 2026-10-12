// Address suggestions for the address boxes (public/address-autocomplete.js),
// fetched from Mapbox Address Autofill by the server so the Mapbox token
// (MAPBOX_TOKEN) never reaches a browser. It's open to signed-out visitors,
// since the activity location is typed before signing in, so it only answers
// this site's own pages and limits how often each visitor can ask. Without
// payment details on the Mapbox account, the worst abuse can do is use up
// the month's free sessions (suggestions then stop until the next month).
const crypto = require('crypto');

const SUGGEST_URL = 'https://api.mapbox.com/autofill/v1/suggest/';
const MAX_QUERY_LENGTH = 256;
const MAX_SUGGESTIONS = 5;
// Typing pauses a few times per address, so this is plenty for a person.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

// Requests per visitor in the current minute: ip -> { count, start }. Kept in
// memory, so it's per function instance; enough to slow down a script.
const recentRequests = new Map();

function clientIp(req) {
  const forwarded = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  return req.get('x-nf-client-connection-ip') || forwarded || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  if (recentRequests.size > 5000) {
    recentRequests.forEach((entry, key) => {
      if (now - entry.start > RATE_WINDOW_MS) recentRequests.delete(key);
    });
  }
  const entry = recentRequests.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    recentRequests.set(ip, { count: 1, start: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// Browsers say which site a request came from (Sec-Fetch-Site, or the
// Origin/Referer headers in older ones), so other websites' pages can't use
// this. A script can fake those headers; the rate limit is for that.
function isFromOwnPages(req) {
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  const source = req.get('origin') || req.get('referer');
  if (!source) return false;
  try {
    const host = new URL(source).host;
    return host === req.get('host') || host === req.get('x-forwarded-host');
  } catch {
    return false;
  }
}

// Netlify's guess at where the visitor is (the `x-nf-geo` header, JSON,
// possibly base64-encoded), so nearby addresses come first. Calling Mapbox
// from the server means its own "near the requester" option would use the
// server's location instead.
function visitorGeo(req) {
  const raw = req.get('x-nf-geo');
  if (!raw) return null;
  for (const decode of [(s) => s, (s) => Buffer.from(s, 'base64').toString('utf8')]) {
    try {
      const geo = JSON.parse(decode(raw));
      if (geo && typeof geo === 'object') return geo;
    } catch {
      // Try the next encoding.
    }
  }
  return null;
}

// Mapbox's full_address ends with the country; leave it off in the US.
function addressText(suggestion) {
  const full = suggestion.full_address || suggestion.place_name || suggestion.address_line1 || '';
  return full.replace(/, United States$/, '').trim();
}

// GET /api/address-suggestions?q=...&session=... -> { suggestions: [string] }.
// `session` is the browser's id for one address box's typing, which Mapbox
// bills as one session. 503 when MAPBOX_TOKEN isn't set (the boxes then stay
// plain text boxes).
async function addressSuggestions(req, res) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return res.status(503).json({ errors: ["Address suggestions aren't set up"] });
  if (!isFromOwnPages(req)) return res.status(403).json({ errors: ['Not allowed'] });
  if (isRateLimited(clientIp(req))) return res.status(429).json({ errors: ['Too many requests, try again in a minute'] });

  const q = String(req.query.q || '').trim().slice(0, MAX_QUERY_LENGTH);
  if (q.length < 3) return res.json({ suggestions: [] });
  const session = /^[A-Za-z0-9-]{8,64}$/.test(String(req.query.session || '')) ? req.query.session : crypto.randomUUID();

  const params = new URLSearchParams({
    access_token: token,
    session_token: session,
    types: 'address',
    streets: 'true',
    language: 'en',
    limit: String(MAX_SUGGESTIONS),
  });
  const geo = visitorGeo(req);
  if (geo && Number.isFinite(Number(geo.longitude)) && Number.isFinite(Number(geo.latitude))) {
    params.set('proximity', `${Number(geo.longitude)},${Number(geo.latitude)}`);
  }
  // Without knowing the visitor's country, stick to the US (where the site is).
  const country = geo && geo.country && /^[A-Za-z]{2}$/.test(geo.country.code || '') ? geo.country.code : 'us';
  params.set('country', country.toLowerCase());

  try {
    const response = await fetch(`${SUGGEST_URL}${encodeURIComponent(q)}?${params}`);
    if (!response.ok) {
      console.error('Mapbox suggest failed:', response.status, await response.text().catch(() => ''));
      return res.status(502).json({ suggestions: [] });
    }
    const data = await response.json();
    const suggestions = [...new Set((data.suggestions || []).map(addressText).filter(Boolean))];
    res.set('Cache-Control', 'no-store');
    res.json({ suggestions });
  } catch (err) {
    console.error('Mapbox suggest failed:', err);
    res.status(502).json({ suggestions: [] });
  }
}

module.exports = { addressSuggestions };
