# Graph Report - Carpool  (2026-10-11)

## Corpus Check
- 29 files · ~149,772 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 4, .lock 1, .toml 1)

## Summary
- 499 nodes · 991 edges · 16 communities (15 shown, 1 thin omitted)
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 118 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `666b5a21`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dashboard.js
- public/app.js
- Home / Create / Join Page
- store.js
- src/app.js
- package.json
- Brand Artwork & Manifest
- local-server.js
- api.test.js
- Page Loader
- store.test.js
- buildSchedule
- features.test.js
- scheduler.test.js
- dates.test.js
- ref_path

## God Nodes (most connected - your core abstractions)
1. `updateCarpool()` - 24 edges
2. `todayKey()` - 17 edges
3. `showError()` - 13 edges
4. `renderAll()` - 13 edges
5. `escapeHtml()` - 12 edges
6. `buildSchedule()` - 12 edges
7. `selectDay()` - 11 edges
8. `buildSummary()` - 11 edges
9. `createCarpoolWithOwner()` - 11 edges
10. `showScreen()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Member-Only Visibility of Carpool Data` --semantically_similar_to--> `Clerk-Session-Based Authorization`  [INFERRED] [semantically similar]
  public/privacy.html → CLAUDE.md
- `Bugs and rough edges` --references--> `getScheduleResult()`  [INFERRED]
  todo/carpool-app-overview.md → src/normalize.js
- `Fairness Scheduling Algorithm` --references--> `buildSchedule()`  [EXTRACTED]
  CLAUDE.md → src/scheduler.js
- `6-Character Carpool Join Code` --references--> `normalizeCode()`  [EXTRACTED]
  CLAUDE.md → src/store.js
- `Bugs and rough edges` --references--> `updateChild()`  [INFERRED]
  todo/carpool-app-overview.md → src/store.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Pennant bunting decorations on the home page** — public_img_rainbow_pennants, public_img_blue_pennants, public_index [EXTRACTED 1.00]
- **Favicon / PWA icon set** — public_img_app_icon, public_img_carpooler_app_icon, public_manifest [EXTRACTED 1.00]
- **Sign-In and Authorization Flow** — public_sign_in_page, claude_clerk_authentication, claude_authorization_model, src_auth_requireuser, src_auth_requiremember, claude_legacy_member_email_linking [EXTRACTED 1.00]
- **Blob Store Consistency Pattern** — claude_netlify_blobs_document_store, claude_strong_consistency_reads, claude_return_mutated_carpool_pattern, claude_connectlambda_wiring, src_store_uselambdablobscontext [EXTRACTED 1.00]
- **Carpooler brand identity (navy #174597 car pennant + yellow bar)** — public_img_app_icon, public_img_carpooler_app_icon, public_img_carpooler_logo, public_img_carpooler_name [INFERRED 0.85]

## Communities (16 total, 1 thin omitted)

### Community 0 - "dashboard.js"
Cohesion: 0.05
Nodes (89): activityStopHtml(), addressDraft, answerJoinRequest(), api(), applyTime(), autoSelectDay(), changeRide(), closeMyChildrenOverlay() (+81 more)

### Community 1 - "public/app.js"
Cohesion: 0.05
Nodes (51): UI Conventions (Brand Tokens, No Emoji, SVG Icons), addChildRow(), api(), DAY_LABELS, DAY_ORDER, daysInMonth(), escapeHtml(), flowProgressEl (+43 more)

### Community 2 - "Home / Create / Join Page"
Cohesion: 0.07
Nodes (37): Carpool Scheduling Web App, Carpool Emails (Welcome, Update, Monthly), Clerk Session Authentication, 6-Character Carpool Join Code, Per-Member Addresses Chosen per Ride, Two Independent Legs per Activity Date, saveCreateDraft(), auth (+29 more)

### Community 3 - "store.js"
Cohesion: 0.07
Nodes (68): Local Mode (local-server.js + local-db.json), addDays(), addMonths(), isValidTimeZone(), nextDay(), todayKey(), weekdayOf(), addChild() (+60 more)

### Community 4 - "src/app.js"
Cohesion: 0.06
Nodes (64): RFC-8058, config, activityDatesErrors(), app, escapeHtml(), express, { getEffectiveOwnerId, normalizeMembers, normalizeActivityTimes, getScheduleResult }, isOwner() (+56 more)

### Community 5 - "package.json"
Cohesion: 0.05
Nodes (42): globals, app, { connectLambda }, handler(), serverless, serverlessHandler, store, dependencies (+34 more)

### Community 6 - "Brand Artwork & Manifest"
Cohesion: 0.09
Nodes (25): App icon: navy-blue (#174597-ish) triangular pennant hanging from a school-bus-yellow bar with a white front-view car; transparent background, embedded raster in SVG (design source), Blue pennants: bunting banner of six car pennants in shades of blue on a yellow string, wide 1337x372 decoration (design source), Carpooler app icon (maskable): same navy car pennant with yellow bar placed on a rounded-square tile with navy #174597 edge/background (design source), Carpooler logo: navy car pennant with yellow bar plus vector navy #174597 'Carpooler' lettering above (embedded raster still carries an older 'CLUBWHEELS' varsity title, clipped out) (design source), Carpooler wordmark: pure-vector 'Carpooler' name in brand navy #174597 (source of the --navy CSS token), with round wheel-like 'o' glyphs (design source), Rainbow pennants: bunting banner of six multicolored pastel car pennants (incl. periwinkle) on a yellow string, 1337x372 hero decoration (design source), App icon: navy-blue (#174597-ish) triangular pennant hanging from a school-bus-yellow bar with a white front-view car; transparent background, embedded raster in SVG (served copy), Blue pennants: bunting banner of six car pennants in shades of blue on a yellow string, wide 1337x372 decoration (served copy) (+17 more)

### Community 7 - "local-server.js"
Cohesion: 0.25
Nodes (6): api, express, os, path, site, express

### Community 8 - "api.test.js"
Cohesion: 0.25
Nodes (5): app, assert, clerkPath, path, test

### Community 10 - "store.test.js"
Cohesion: 0.15
Nodes (9): assert, fake, fs, { getScheduleResult, normalizeMembers }, legacyMember, os, path, store (+1 more)

### Community 11 - "buildSchedule"
Cohesion: 0.12
Nodes (13): resolveActivityTimes(), buildSchedule(), fillLeg(), pickDrivers(), { resolveActivityTimes }, { weekdayOf }, Bugs and rough edges, Carpooler: how the app works (+5 more)

### Community 12 - "features.test.js"
Cohesion: 0.25
Nodes (4): assert, { getScheduleResult }, store, test

### Community 13 - "scheduler.test.js"
Cohesion: 0.29
Nodes (4): assert, { buildSchedule }, MONDAYS, test

### Community 14 - "dates.test.js"
Cohesion: 0.33
Nodes (3): assert, test, { todayKey, isValidTimeZone, weekdayOf, addMonths, nextDay }

### Community 15 - "ref_path"
Cohesion: 0.50
Nodes (3): createFakeBlobs(), install(), path

## Knowledge Gaps
- **15 isolated node(s):** `eslint`, `netlify-cli`, `RFC-8058`, `UI Conventions (Brand Tokens, No Emoji, SVG Icons)`, `Leave Carpool Confirmation Overlay` (+10 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 168 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App icon: navy-blue (#174597-ish) triangular pennant hanging from a school-bus-yellow bar with a white front-view car; transparent background, embedded raster in SVG (served copy)` connect `Brand Artwork & Manifest` to `dashboard.js`, `src/app.js`?**
  _High betweenness centrality (0.311) - this node is a cross-community bridge._
- **What connects `eslint`, `netlify-cli`, `RFC-8058` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `dashboard.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05446727185857621 - nodes in this community are weakly interconnected._
- **Why does `Home / Create / Join Page` connect `Home / Create / Join Page` to `public/app.js`?**
  _High betweenness centrality (0.231) - this node is a cross-community bridge._
- **Should `public/app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.053763440860215055 - nodes in this community are weakly interconnected._
- **Why does `Carpool Dashboard Page` connect `Home / Create / Join Page` to `dashboard.js`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Should `Home / Create / Join Page` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._