# Task 1 report — application shell

## Outcome

- Replaced the eight-destination POC shell with one five-destination manifest: Inbox, Properties, Sources, Automations, Settings.
- Added a responsive desktop rail and mobile bottom navigation using Lucide icons, 44px targets, visible focus, and reduced-motion handling.
- Added warm-neutral/indigo design tokens and a locally bundled Noto Sans Thai variable font.
- Added URL state helpers with deterministic query serialization and popstate restoration.
- Added a same-origin API client with typed, retry-aware, non-leaking error messages.
- Removed fixture/demo actions and legacy top-level workflow labels from the production entry page.

## TDD evidence

1. `node --test scripts/frontend-shell.test.mjs` — RED: legacy navigation assertion failed and new shell modules were absent.
2. `node --test scripts/frontend-shell.test.mjs` — GREEN: 5/5 passed.
3. Added a network-failure safety case — RED because the client classified status `0` as `server_error`.
4. Fixed network classification — GREEN: 6/6 passed.

## Verification

- `node --test scripts/frontend-shell.test.mjs` — 6 passed, 0 failed.
- `npm run build` — production build succeeded.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test` — 310 passed, 0 failed.

## Self-review

- No external image assets or credentials were added.
- The user-owned untracked `artifacts-dashboard-saved-group.png` was not staged or modified.
- Legacy feature components remain untouched for later vertical cutover tasks, but are no longer imported by the production entry page.

## Review fixes

- Added real App Router pages for all five destinations using one shared placeholder component; `/` now redirects consistently to `/inbox`.
- Added route-existence coverage alongside navigation and popstate restoration coverage.
- Changed standalone `navigate()` to mutate history directly and optionally notify through `onChange`, without registering an undisposable event listener.
- Added a regression proving standalone navigation registers zero `popstate` listeners.
