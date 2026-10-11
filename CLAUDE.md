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
- Sign-in needs `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (from the Clerk dashboard) in
  `.env` locally and in the Netlify site's environment variables. Without them every carpool
  route answers 503 and the pages show "Sign-in unavailable".
- No test suite and no lint config currently exist in this repo.

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
- `src/store.js` — the entire persistence layer, backed by Netlify Blobs (a single JSON blob
  holding the whole `{ carpools: {...} }` document, read-modify-written on every call — no
  in-memory cache, no transactions/locking, so concurrent writes are last-write-wins). Owns
  carpool codes, members, children, activity dates/times, recurrence rules, and per-date child
  exclusions. All functions are async. Reads are **strongly consistent** (`getDbStore`): with
  Blobs' default eventual consistency, a write could take up to a minute to reach reads in
  other invocations — a just-created carpool's dashboard said "Carpool not found", and a stale
  read-modify-write could undo someone else's change. Strong reads need the "uncached edge
  URL": native functions get it automatically, but the API runs in Lambda compatibility mode
  where `connectLambda()` drops it, so `netlify/functions/api.js` also passes each event to
  `store.useLambdaBlobsContext`, which reads `url_uncached` from it (falling back to eventual
  reads if it's ever missing). Store functions whose result needs to reflect data they just
  wrote still return the mutated carpool directly (e.g. `addChild`/`updateChild`/
  `removeChild`/`setChildExclusion` return `{ ..., carpool }`, and `createCarpoolWithOwner`
  builds the carpool and its owner in one load/save) rather than re-fetching with
  `getCarpool()` — keep that pattern for new mutations.
- `src/scheduler.js` — pure function `buildSchedule(members, dates, dateOverrides, activityTimes)`
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
  carpool → member form (name, address, seats, which days you can drive) → view schedule.
  Nobody is asked to sign in until it's needed: when looking up a join code, or after the
  create flow's "All set!" popup (before "Add yourself"). The carpool details entered so far
  are saved to localStorage (`saveCreateDraft`) and restored on `/?resume=create`, since
  signing in leaves the page. Signed-in people also get "Your carpools" (`GET
  /api/my-carpools`). Joining by code calls `GET .../preview` (name + dates/times only);
  people already in the carpool go straight to the dashboard.
- `public/dashboard.html` + `public/dashboard.js` — the owner's carpool management view
  (edit activity dates/times/recurrence, manage members/children, per-date exclusions).

### Domain model details worth knowing before editing

- **Two independent legs per activity date**: "there" (drop-off) and "back" (pickup) each
  have their own eligible drivers, rider list, and time. A member's driving availability is
  `canDriveThereDays` / `canDriveBackDays`; a child's ride need is `needsRideThereDays` /
  `needsRideBackDays` — all as arrays of weekday numbers (0=Sunday..6=Saturday), not dates.
- **Activity times resolve most-specific-wins**: `perDate` overrides `perWeekday` overrides
  `uniform`. This resolution logic is duplicated in `src/store.js` (`resolveActivityTimes`,
  used by the backend) and `public/dashboard.js` (`resolveTimes`, used for frontend preview) —
  keep them in sync if you change the precedence rules.
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
  drive-count (ties broken by longest time since last drove), adding a second driver only if
  capacity requires it. It swaps in one driver for both legs of a date only when that driver's
  count is no higher than the average of the split's drivers (or the split falls short on
  drivers/seats) — an unconditional solo preference let one always-available member take
  every such date while others never drove.
- **Addresses are per member, chosen per ride**: a member has `addresses: [{id, address}]`
  (only required if they have riders) and `rideAddresses: { there: {weekday: addressId},
  back: {...} }` saying which address each ride starts/ends at (falls back to the first
  address). The create/join request sends `addresses` as strings and `rideAddresses` as
  indexes into that list; `store.buildMember` swaps indexes for generated IDs. The legacy
  single `address` field is still written (as the first address) and upgraded on read by
  `normalizeMembers`. Members edit theirs later via `PUT .../members/:memberId/addresses`
  (entries keep their `id` so existing ride choices survive edits).
- **Carpools have `activityName` / `activityLocation`**; the location is the end of every
  drop-off route and the start of every pick-up route in the dashboard's route overlay.
  The owner edits them (and the carpool name) via `PATCH /api/carpools/:code/details`.
- **Emails** (`src/email.js`): welcome (on create/join), owner update (`POST
  .../email-update`, optional message), and monthly — all the same per-member layout:
  carpool details plus a table of the member's drives for
  the rest of the month (stops in route order with Apple Maps links, built from the same
  schedule + ride-address logic as the dashboard's route overlay). Sent on create and join
  via Resend's HTTP API, only when the `RESEND_API_KEY` and `EMAIL_FROM` env vars are set
  (otherwise a silent no-op).
  Every email has an unsubscribe link (`/api/unsubscribe?c=&m=&t=`, plus RFC 8058
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
