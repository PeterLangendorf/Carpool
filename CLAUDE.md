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
- `src/store.js` — the entire persistence layer, backed by Netlify Blobs (a single JSON blob
  holding the whole `{ carpools: {...} }` document, read-modify-written on every call — no
  in-memory cache, no transactions/locking, so concurrent writes are last-write-wins). Owns
  carpool codes, members, children, activity dates/times, recurrence rules, and per-date child
  exclusions. All functions are async. Blobs uses eventual consistency by default (a write in
  one call isn't guaranteed visible to an immediately-following separate `load()`), so any
  store function whose result needs to reflect data it just wrote returns the mutated carpool
  object directly (e.g. `addChild`/`updateChild`/`removeChild`/`setChildExclusion` return
  `{ ..., carpool }`, and `createCarpoolWithOwner` builds the carpool and its owner member in
  one load/save round trip) rather than making the caller re-fetch with `getCarpool()`. Follow
  that pattern for any new mutation — don't write-then-immediately-`getCarpool()` in the same
  request.
- `src/scheduler.js` — pure function `buildSchedule(members, dates, dateOverrides, activityTimes)`
  that assigns drivers. No I/O; safe to reason about/test in isolation.
- `public/index.html` + `public/app.js` — the member-facing flow: home → create/join a
  carpool → member form (name, address, seats, which days you can drive) → view schedule.
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
- **Fairness scheduling**: `buildSchedule` prefers one driver who can solo both legs of a
  date; otherwise it fills each leg independently by lowest running drive-count (ties broken
  by longest time since last drove), adding a second driver only if capacity requires it.
- **Authorization is requester-ID based, not session-based**: mutating endpoints take a
  `requesterId` in the body and compare it against the target member/owner ID — there's no
  auth token or cookie session. `code` uniquely identifies a carpool; `store.normalizeCode`
  strips ambiguous characters (I/O/0/1 excluded from generated codes).
