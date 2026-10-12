# Carpooler: how the app works

A read-only map of the code in the Carpool folder, written 2026-10-11. No files were changed.

## What it does

Carpooler is a phone-friendly web app for organizing a recurring kids' carpool. One parent creates a carpool and gets a 6-character join code. Other parents join with that code, say which days they can drive and which kids need rides, and the app works out a fair driving schedule for every activity date. Each date has two separate rides: **there** (drop-off) and **back** (pick-up). The app also sends emails: a welcome email on joining, an "email everyone" update the organizer can send once a day, and an optional monthly schedule on the 1st.

## How it's built

- **Front end** (`public/`): plain HTML, CSS and JavaScript with no framework.
  - `index.html` + `app.js` cover the home screen and the create and join flows.
  - `dashboard.html` + `dashboard.js` are a carpool's page, with Schedule, People and Settings tabs.
  - `style.css` holds the look (navy, school-bus yellow, warm paper background).
- **API** (`src/app.js`): one Express app that runs on Netlify as a single serverless function (`netlify/functions/api.js`). `npm run local` runs the same app on your own machine with a JSON file for storage instead.
- **Sign-in**: Clerk. Every carpool route needs a signed-in user, and most also need you to be a member of that carpool (`src/auth.js`).
- **Email**: Resend (`src/email.js`, `src/notify.js`). The monthly email is a scheduled Netlify function (`netlify/functions/monthly-email.mjs`).

## How parents sign up, drive and request rides

1. **Create.** The organizer enters the carpool name, activity, location and dates. Dates can be picked one by one or set up as a repeating weekly rule. They're asked to sign in only after the "All set!" step; their draft is saved in the browser so it survives the sign-in redirect. They then fill in the same member form everyone else does.
2. **Join.** A parent types the code. They're asked to sign in, see a preview (the carpool name and its dates), then fill in the member form.
3. **Member form.** This asks for name, email, how many passengers they can carry (0 to 15), and which weekdays they can drive *there* and *back*. It also lists their kids, with the weekdays each kid needs a ride *there* and *back*, plus one or more home addresses and which address each ride uses. You must be able to drive at least one leg on at least one day; there's no rider-only membership.
4. **Requesting rides** isn't a separate request. A child's weekly "needs a ride" days are the request. On a specific date, a parent can untick a kid ("not going this day") on the Schedule tab.
5. **The schedule** (`src/scheduler.js`) is worked out fresh every time someone looks; it's never saved. For each date and leg it picks the eligible parent with the fewest drives so far, breaking ties by whoever drove least recently. It adds a second driver if one car isn't big enough. If one parent can do both legs, they get the whole day as long as that isn't less fair than splitting it. Days with no driver, or not enough seats, are flagged on the dashboard.
6. **Organizer-only tools**: editing dates and times, renaming the carpool, turning the monthly email on or off, and "Email everyone". Any member can leave; if the organizer leaves, the next member becomes the organizer, and if the last member leaves, the carpool is deleted.

## How data is stored

- All carpools live in **one JSON document** (`{ carpools: { CODE: {...} } }`) in Netlify Blobs, or in `local-db.json` when running locally. Every change reads the whole document, edits it and writes the whole thing back (`src/store.js`).
- A carpool holds its name, activity and location, its dates and times, any repeating-date rule, per-date "kid not going" notes, and its members. Each member record holds their name, email, addresses, seats, driving days and kids.
- Repeating dates are written out as real dates about 12 months ahead. This happens whenever a carpool is read, so a plain read can also trigger a write.
- Old data shapes, from before the there/back split and before multiple addresses, are converted when read and never migrated in storage.
- Every member can see every other member's addresses, kids' names and schedule. Emails and Clerk IDs are stripped from what the API sends back.

## Bugs and rough edges

Ordered from most to least serious.

1. **Names can inject code into other parents' dashboards (security).** Kids' names, parents' names and driver names go into the page as raw HTML without escaping, in `public/dashboard.js` around lines 404, 409, 431 and 605–611. Other parts of the app do use `escapeHtml`. Any member could add a "child" whose name contains a script, and it would run in every other member's browser while they're signed in. That script could read the page, including everyone's addresses, or act as them.
2. **Simultaneous changes in *any* two carpools can wipe each other out.** Since every carpool shares one stored document with no locking, two parents saving at the same moment, even in unrelated carpools, can each overwrite the other's change. The last write wins and the other change is silently lost. Reads that roll repeating dates forward also write, which makes this more likely. The code's own notes acknowledge this (`src/store.js`, CLAUDE.md).
3. **The schedule can change after the fact.** Only dates from today onward are scheduled, and drive counts start at zero each time (`src/normalize.js` `getScheduleResult`). So once a date passes, past drives stop counting and future assignments can shuffle. A new family joining, or one kid being marked absent, can also reassign drivers on later dates. There's no way to lock in an assignment or swap with someone. Parents may find "my Thursday" has moved.
4. **"Today" is UTC on the server.** The server decides which dates are upcoming using UTC (`src/normalize.js:820`, `src/app.js:135`). In the US evening, UTC is already tomorrow, so today's ride drops off the schedule and out of emails several hours early. Other parts of the code use the server's local date, which on Netlify is also UTC, so it's consistent there but differs when running locally.
5. **Editing a kid's name can lose part of it.** In `src/store.js` `updateChild`:
   - Changing only the first name drops any custom last name, which falls back to the parent's.
   - Changing only the last name keeps just the first word of the name, so "Mary Kate Smith" becomes "Mary …".
   - An empty first name is also accepted on edit, though not when adding a kid.
6. **At most two cars per ride.** If two cars still don't have enough seats, the scheduler stops and reports kids without a seat rather than adding a third driver (`src/scheduler.js` `pickDrivers`).
7. **Anyone with the code gets in.** There's no approval step. Join codes come from `Math.random`, though sign-in is required and there are about a billion possible codes. Combined with every member seeing every address and kid name, a leaked code exposes a lot.
8. **Smaller things:**
   - The rules for working out activity times are written twice, in `src/store.js` and `public/dashboard.js`, and have to be kept in sync by hand.
   - There are no tests or linting.
   - The home screen's "Carpools" list loads every carpool in the system for each user. That's fine now but slows down as usage grows.
   - `local-db.json` is in the folder with two test carpools in it. CLAUDE.md says it's meant to be gitignored, but there is no `.gitignore` in this folder.

## Status (2026-10-11)

1. **Fixed.** Names are escaped everywhere they go into the dashboard's HTML.
2. **Fixed.** Each carpool is its own blob, and every save checks it isn't overwriting someone else's (ETag) and redoes the change if it would.
3. **Fixed.** Drives on past dates are saved and the schedule carries on from them, so the future no longer reshuffles every time a date passes; someone joining later starts at the average drive count. The coming week's drivers are locked in, so a new family, changed availability or an absent kid can't move them (a locked ride only gets extra drivers if it runs short of seats). Each ride has "Can't make it" (the fairest other driver takes it, and is emailed if it's this week) and "I'll drive it" (take someone's ride, or one with no driver); together they make a swap.
4. **Fixed.** "Today" uses each carpool's time zone, taken from the creator's browser or, for older carpools, from whoever opens it first.
5. **Fixed.** Riders keep their first name and last name separately, editing one keeps the other, and a blank first name is refused.
6. **Fixed.** The scheduler adds as many cars as it takes.
7. **Fixed.** Join codes come from a cryptographic random source, and organizers approve people before they can join (on for new carpools, a switch in Settings; carpools from before this keep open joining until their organizer turns it on). The organizer is emailed about each request.
8. Duplicated time rules: **fixed** (one shared `public/activity-times.js`). Tests: **added** (`npm test`). Linting: **added** (`npm run lint`, ESLint). Carpools list: **fixed**, each user has their own list of carpool codes, built from one full scan the first time. `local-db.json`: **was already fine**, since `.gitignore` exists and lists it.
