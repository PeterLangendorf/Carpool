# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An iOS-friendly carpool scheduling web app. A group joins a "carpool" via a 6-character
code, lists who can drive on which days, lists which kids need rides, and the server
computes a fair driving schedule for each activity date.

## Commands

- `npm start` — runs `netlify dev`, which serves `public/` as static files and emulates the
  `/api/*` serverless function locally at `http://localhost:8888`. First run requires
  `netlify login` and `netlify init` (or `netlify link`) so the CLI has a site to emulate
  Netlify Blobs against — without that, API calls fail with a Blobs "not configured" error.
- `npm run local` — runs everything on this machine with no Netlify involvement (`local-server.js`):
  one Express server for `public/` + the API on port 8888, listening on all interfaces so
  phones on the same Wi-Fi can connect. Data goes in `local-db.json` (gitignored) instead of
  Netlify Blobs, via the `LOCAL_DB_FILE` switch in `src/store.js`. Reads env vars from `.env`
  (gitignored) if present.
- Address suggestions need `MAPBOX_TOKEN` (a Mapbox access token; it stays on the server).
  Without it the address boxes are plain text boxes.
- Sign-in needs `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (from the Clerk dashboard) in
  `.env` locally and in the Netlify site's environment variables. Without them every carpool
  route answers 503 and the pages show "Sign-in unavailable".
- `npm test` runs the tests in `test/` (Node's built-in runner, no extra dependencies). They
  swap Netlify Blobs for an in-memory fake (`test/fake-blobs.js`) with real ETag behaviour;
  `test/api.test.js` also stubs Clerk so the real Express routes run, signed in as whoever
  the `X-Test-User` header names.
- `npm run lint` runs ESLint (`eslint.config.js`: recommended rules; Node globals for the
  server, browser-script globals for `public/`, which share `auth`, `ActivityTimes` and
  `CAR_SVG` across files).

## Architecture

Hosted on Netlify: `public/` is deployed as static files (served directly by Netlify's CDN,
not through a function), and the API is a single Express app wrapped as one Netlify Function.
There is no long-running server process — see `netlify.toml` for the redirect that maps
`/api/*` requests to the function.

- `src/app.js` — the Express app: all `/api/*` routes. Validates/normalizes request bodies,
  calls into `src/store.js` for persistence, and calls `src/scheduler.js` to compute schedules
  on demand (schedules are never stored — they're derived fresh from members + dates +
  overrides). Exports the app; does not listen on a port.
- `netlify/functions/api.js` — thin wrapper that adapts `src/app.js` to a Netlify Function via
  `serverless-http`. This is the only thing Netlify actually invokes. It also calls
  `connectLambda(event)` before touching the store — Netlify only auto-injects Blobs'
  site/token context for its native function signature, not for the classic `(event, context)`
  shape `serverless-http` produces, so this has to be wired up manually.
- `netlify/functions/monthly-email.mjs` — scheduled function (13:00 UTC on the 1st) that
  emails members of carpools with `monthlyEmail` on. Uses Netlify's native function format,
  so Blobs is configured automatically (no `connectLambda`).
- `src/auth.js` — Clerk sign-in for the API: `requireUser` (401 without a valid session;
  sets `req.userId`) and `requireMember` (403 unless that user is a member of `:code`; sets
  `req.carpool`/`req.member`), plus linking members from before sign-in existed by verified
  email.
- `src/normalize.js` — read-side helpers shared by the API and the email jobs
  (`normalizeMembers`, `normalizeActivityTimes`, `getEffectiveOwnerId`, `getScheduleResult`).
- `src/email.js` (builds/sends emails via Resend) and `src/notify.js` (emails a whole
  carpool: the owner's "Email everyone" update and the monthly schedule).
- `src/store.js` — the entire persistence layer, backed by Netlify Blobs: one JSON blob per
  carpool (`carpools/<CODE>`), no in-memory cache. Every change goes through
  `updateCarpool(code, change)`, which reads the carpool, runs `change` on it and saves with an
  ETag check (`onlyIfMatch`); if someone else saved that carpool in between it re-reads and
  re-runs `change`, so simultaneous saves never silently overwrite each other. `change` may
  therefore run more than once — it must only modify the carpool it's given (throwing aborts).
  Creates use `onlyIfNew`; a carpool whose last member leaves becomes a `{ deleted: true }`
  tombstone (deletes can't be conditional). Everything used to be one shared `db` blob;
  `migrateLegacyDb` copies it out once (the old blob stays as a backup). Owns
  carpool codes, members, children, activity dates/times, recurrence rules, and per-date child
  exclusions. All functions are async. Reads are **strongly consistent** (`getDbStore`): with
  Blobs' default eventual consistency, a write could take up to a minute to reach reads in
  other invocations — a just-created carpool's dashboard said "Carpool not found", and stale
  reads would keep failing the ETag check. Strong reads need the "uncached edge
  URL": native functions get it automatically, but the API runs in Lambda compatibility mode
  where `connectLambda()` drops it, so `netlify/functions/api.js` also passes each event to
  `store.useLambdaBlobsContext`, which reads `url_uncached` from it (falling back to eventual
  reads if it's ever missing). Store functions whose result needs to reflect data they just
  wrote still return the mutated carpool directly (e.g. `addChild`/`updateChild`/
  `removeChild`/`setChildExclusion` return `{ ..., carpool }`, and `createCarpoolWithOwner`
  builds the carpool and its owner in one write) rather than re-fetching with
  `getCarpool()` — keep that pattern for new mutations.
- `src/scheduler.js` — pure function `buildSchedule(members, dates, dateOverrides, activityTimes, history)`
  that assigns drivers. No I/O; safe to reason about/test in isolation.
- `public/auth.js` — loaded by every page before its own script: fetches the Clerk
  publishable key from `GET /api/config`, loads Clerk's browser scripts from the key's
  Frontend API host, and `auth.fetch` attaches the session token as a Bearer header. Pages
  never sign people in themselves: `auth.redirectToSignIn(returnTo, reason)` /
  `auth.requireSignIn()` send them to the sign-in page, which comes back afterwards. Clerk
  navigates after sign-in and sign-out (to `/`) — don't reload from an auth listener, which
  can cut a sign-out short.
- `public/sign-in.html` + `public/sign-in.js` — the sign-in page at `/sign-in` (a rewrite in
  `netlify.toml`; `extensions: ['html']` in `local-server.js`). Takes `?redirect_url=`
  (same-site paths only, to avoid an open redirect) and `?reason=create|join` for its wording.
- `public/privacy.html` — the privacy policy at `/privacy`. It describes what data the app
  collects, who sees it and which services handle it (Clerk, Google, Netlify, Resend, Apple
  Maps links), so update it when any of that changes. `public/tos.html` is the terms of
  service at `/tos`. Both are linked from the home and sign-in pages.
- `public/index.html` + `public/app.js` — the member-facing flow: home → create/join a
  carpool → member form (name → riders → addresses → ride days → driving days → seats; the
  seats step only appears if some driving days are ticked; with none ticked, someone with
  riders finishes with 0 seats and someone without riders is asked to pick a day) → view schedule.
  Nobody is asked to sign in until it's needed: when looking up a join code, or after the
  create flow's "All set!" popup (before "Add yourself"). The carpool details entered so far
  are saved to localStorage (`saveCreateDraft`) and restored on `/?resume=create`, since
  signing in leaves the page. The home screen is a navy hero with "Create a carpool" and a
  join-code box (the join-code screen remains for deep links and errors). Signed-in people
  get a "Carpools" button there that opens their carpools as tickets (`GET
  /api/my-carpools`, which also returns weekdays and the next ride). Joining by code calls
  `GET .../preview` (name + dates/times only); people already in the carpool go straight to
  the dashboard, and people waiting for approval to the `join-pending` screen.
- `public/dashboard.html` + `public/dashboard.js` — a carpool's page: navy band, then tabs
  (`showTab`): Schedule (calendar, day details with "Can't make it" / "I'll drive it" on each
  ride, per-date exclusions), People (members with drive counts, your riders/addresses),
  Export (calendar subscription, maps app, printing) and Settings (join requests, organizer
  tools, copy code, leave).

### UI conventions

- Look and feel lives in `public/style.css`: color tokens on `:root` (brand navy `--navy`
  from the wordmark, school-bus yellow `--sun` for "your turn", warm `--paper` background;
  calendar days keep the original green / grey / red scheme via the `--cal-*` tokens),
  system fonts (headings in `ui-rounded`, i.e. SF Pro Rounded on iPhone). No emoji in the UI:
  icons are small inline SVG line icons (`.icon`; `ICONS` in `dashboard.js`).
- `showScreen` in `app.js` slides screens forward/back along each journey's order; overlays
  open as bottom sheets. All motion is disabled under `prefers-reduced-motion`.
- Forms are `novalidate`: each submit handler checks its own fields and shows the message
  with `showError`, so the browser's built-in "fill out this field" bubbles never appear.
- Never use the browser's built-in `alert()` / `confirm()` / `prompt()` boxes. Use
  `Dialog.confirm({ title, message, items, confirmText, cancelText, danger })` and
  `Dialog.prompt({ title, label, placeholder, confirmText })` from `public/dialog.js` (both
  return promises; the sheet sits above any other overlay).

### Domain model details worth knowing before editing

- **Calendar feed** (`src/calendar.js`): `GET /api/calendar/:code/:memberId/:token.ics` is an
  iCalendar feed of that member's upcoming drives and their riders' rides, for Apple/Google/
  Outlook subscriptions. Calendar apps can't sign in, so the key is a secret per-member
  `calendarToken` (made by `GET .../calendar`, replaced by `POST .../calendar/reset`;
  stripped from API responses by `normalizeMembers`). Times are UTC from the carpool's time
  zone (floating if it has none); drop offs end at the activity's start time, pick ups start
  at its end, 30 minutes each.
- **Maps app is a per-device choice** (Export tab, `localStorage` `carpooler.mapsApp`):
  `mapsUrl`/`routeUrl` in `dashboard.js` build Apple or Google Maps links. Google Maps
  directions take every stop (waypoints: up to 3 on phones, 9 elsewhere); Apple Maps links
  can only hold one stop, so its route button goes to the first stop. Emails still use Apple
  Maps links.
- **Printing**: the Export tab fills `#printView` (outside the page) and calls
  `window.print()`; print CSS hides everything else.

- **Two independent legs per activity date**: "there" (drop-off) and "back" (pickup) each
  have their own eligible drivers, rider list, and time. A member's driving availability is
  `canDriveThereDays` / `canDriveBackDays`; a child's ride need is `needsRideThereDays` /
  `needsRideBackDays` — all as arrays of weekday numbers (0=Sunday..6=Saturday), not dates.
  Each is optional but not both: a member drives, has riders who need rides, or both
  (`validateMemberInput` refuses neither, and so does the driving-days step). `seats: 0`
  means not driving: the API saves no drive days for them and `buildSchedule` never picks a
  member with no seats.
- **Activity times resolve most-specific-wins**: `perDate` overrides `perWeekday` overrides
  `uniform`. The rule lives once, in `public/activity-times.js`: the server `require`s it and
  the pages load it as a script (`window.ActivityTimes`, aliased `resolveTimes`).
- **"Today" is the carpool's own date**: `carpool.timeZone` (IANA name) comes from the
  creator's browser, or for older carpools from whoever opens it first (`auth.fetch` sends an
  `X-Time-Zone` header; `store.getCarpool(code, { timeZone })` adopts it if unset). Use
  `todayKey(carpool.timeZone)` from `src/dates.js` for anything about upcoming dates — never
  `new Date().toISOString()`, which is UTC (tomorrow, during a US evening).
- **Recurrence is materialized, not computed on the fly**: `store.getCarpool()` calls
  `materializeRecurrence()` on every read, which lazily expands a recurrence rule (weekdays +
  start/end date) into concrete entries in `activityDates`, rolling a ~12-month window forward
  with no background job. `recurrenceExcludedDates` tracks dates a user manually removed from
  an otherwise-recurring series, so materialization doesn't resurrect them.
- **Backward-compatible normalization on read**: `src/app.js` has `normalizeMembers` and
  `normalizeActivityTimes`, which upgrade old single-leg data shapes (`canDriveDays`,
  `needsRideDays`, a flat `date -> "HH:MM"` map) into the current two-leg shape at read time.
  The stored blob itself is never migrated — old and new shapes coexist in it.
- **Fairness scheduling**: `buildSchedule` fills each leg independently by lowest running
  drive-count (ties broken by longest time since last drove), adding more drivers only while
  the seats aren't enough. It swaps in one driver for both legs of a date only when that driver's
  count is no higher than the average of the split's drivers (or the split falls short on
  drivers/seats) — an unconditional solo preference let one always-available member take
  every such date while others never drove.
- **Drive history keeps the schedule stable**: once a date passes, who drove it is saved in
  `carpool.driveHistory.dates` (`store.recordPastDrives`, run on every read like
  materialization; recording starts at `driveHistory.since`, with no back-filling). The
  schedule (`normalize.computeSchedule`) carries on from those counts, so it comes out the
  same as before the date passed. Without it, counts restarted at zero every day and the
  future reshuffled whenever a date went by. A member who joins later gets `driveCredit` (the
  members' average count so far) so they don't drive every ride until they catch up.
  `driveCounts` in the API only count upcoming rides.
- **The coming week is locked in**: `store.lockUpcomingDrives` (on every read) saves the
  drivers of each date in the next 7 days in `carpool.lockedDrives[date] = { there, back }`.
  `buildSchedule` keeps locked drivers (as many as are needed to seat everyone) and only
  tops up by fairness, so a new family, changed availability or an absent rider can't
  reshuffle rides that are days away. Anyone added is locked in too; locks for past dates
  are dropped once recorded in the history.
- **Swapping rides is per-date overrides**: `dateOverrides[date].unavailableDriverIds` and
  `.volunteers` (each `{ there: [ids], back: [ids] }`), set by `PUT
  .../dates/:date/rides/:leg` (`store.setRideOverride`) for the requester only. "Can't make
  it" takes you off that ride (and out of its lock), and the fairest other driver is picked;
  "I'll drive it" puts you first on it. Anyone newly put on a locked ride is emailed.
  `dateOverrides[date]` always keeps `excludedChildIds` (code iterates it).
- **Every join needs the organizer's approval**, in every carpool (old ones included; a
  leftover `requireApproval` field in stored carpools is ignored). Joining adds the member to
  `carpool.joinRequests` instead of `members` (`POST .../members` answers 202
  `{ pending: true }`, emails the organizer and notifies them); the organizer answers with
  `POST .../join-requests/:memberId/approve|decline`. Only the organizer gets `joinRequests`
  from the API.
- **Notifications are in-app, per user**: `inbox/<userId>` blobs (`{ items }`, newest first,
  capped at 50) via `store.addNotification`; `GET /api/notifications` and `POST
  /api/notifications/read`. `src/notifications.js` decides who's told what: the organizer
  about join requests; the person asking when approved/declined (they aren't a member yet,
  hence per-user rather than per-carpool); members when someone joins or leaves, when the
  organizer changes dates/times or the name/activity/location, when they become organizer,
  and when a locked ride is handed to them or taken over. The person who made a change
  isn't told about it. `public/notifications.js` mounts the bell into `#notifBell` (home
  hero and carpool band) and polls every minute while the page is visible. Links can open a
  dashboard tab with `?tab=schedule|people|settings`.
- **Each user has a list of their carpools**: `users/<userId>` blobs (`{ codes, complete }`)
  so `GET /api/my-carpools` reads only that user's carpools. The first time (no complete
  list), `auth.getUserCarpools` scans every carpool, claims legacy members by email, and
  saves the list. Codes are added before joining/creating and removed after leaving, so the
  list never misses one; extra codes are harmless because readers check membership.
- **Riders store their name parts**: `firstName` and `lastNameOverride` (blank = the
  parent's last name) alongside the composed `name`. Older riders only have `name`;
  `normalize.childNameParts` splits it.
- **Addresses are per member, chosen per ride**: a member has `addresses: [{id, address}]`
  (only required if they have riders) and `rideAddresses: { there: {weekday: addressId},
  back: {...} }` saying which address each ride starts/ends at (falls back to the first
  address). The create/join request sends `addresses` as strings and `rideAddresses` as
  indexes into that list; `store.buildMember` swaps indexes for generated IDs. The legacy
  single `address` field is still written (as the first address) and upgraded on read by
  `normalizeMembers`. Members edit theirs later via `PUT .../members/:memberId/addresses`
  (entries keep their `id` so existing ride choices survive edits).
- **Address suggestions are recommended, not required**: `public/address-autocomplete.js`
  (`AddressAutocomplete.attach(input)`) shows Mapbox Address Autofill suggestions under every
  address box (create/join, My addresses, activity location), through our own `GET
  /api/address-suggestions` (`src/address-suggestions.js`) so the token never reaches a
  browser (the account has no payment details, so its token can't be URL-restricted). That
  endpoint works signed out (the activity location comes before sign-in), so it only answers
  same-origin requests and rate-limits each visitor; it biases results with Netlify's
  `x-nf-geo` visitor location when present, else sticks to the US. A typed address is still
  accepted: the box notes it wasn't found, and saving asks "Use it anyway?" in a `Dialog`
  (`await AddressAutocomplete.confirmUnverified(inputs)`, only for new or changed
  addresses). Addresses picked from the list are saved
  with `verified: true` (`addressesVerified` on create/join; `verified` per entry on `PUT
  .../addresses`; `activityLocationVerified` on the carpool). Mapbox's terms forbid storing
  its coordinates, so only the text is saved.
- **Carpools have `activityName` / `activityLocation`**; the location is the end of every
  drop-off route and the start of every pick-up route in the dashboard's route overlay.
  The owner edits them (and the carpool name) via `PATCH /api/carpools/:code/details`.
- **Emails** (`src/email.js`): welcome (on create/join), owner update (`POST
  .../email-update`, optional message), and monthly — all the same per-member layout:
  carpool details plus a table of the member's drives for
  the rest of the month (stops in route order with Apple Maps links, built from the same
  schedule + ride-address logic as the dashboard's route overlay). Sent on create and join
  via Resend's HTTP API, only when the `RESEND_API_KEY` and `EMAIL_FROM` env vars are set
  (otherwise a silent no-op). Short one-off notices (`sendNotice`: a join request for the
  organizer, a ride handed to someone) are plain text plus a link.
  Every summary email has an unsubscribe link (`/api/unsubscribe?c=&m=&t=`, plus RFC 8058
  one-click headers) authorized by a secret per-member `unsubscribeToken`; GET only shows a
  confirm button (link scanners prefetch), POST sets `member.emailOptOut`, which update and
  monthly emails skip. Emails, tokens and Clerk user IDs are stripped from every API response by
  `normalizeMembers`.
- **Authorization is Clerk-session based**: every carpool route runs `requireUser` (and
  usually `requireMember`); the requester is `req.member`, worked out from the session —
  never trust a member ID from the request body. Members are tied to Clerk users by
  `member.userId` (set on create/join). Members from before sign-in existed have no
  `userId` and are claimed the first time a user with a matching *verified* email (Clerk)
  opens the carpool or their carpool list (`store.linkMembersByEmail`). Only members can read
  a carpool (addresses, riders, schedule); the unsubscribe routes are the only unauthenticated
  ones besides `/api/config`. `code` uniquely identifies a carpool; `store.normalizeCode`
  strips ambiguous characters (I/O/0/1 excluded from generated codes).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
