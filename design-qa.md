# Design QA — Authoritative Inbox Table

## Evidence

- Source visual truth: `/var/folders/b1/5txgbtk55zj60l4482s3v7pc0000gn/T/codex-clipboard-f69fc7db-e56f-48d3-88d6-a3e1fbefbdb4.png`
- Browser-rendered implementation: `/tmp/rental-radar-inbox-final-desktop.png`
- Mobile implementation: `/tmp/rental-radar-inbox-final-mobile.png`
- Facebook profile menu state: `/tmp/rental-radar-inbox-final-profile-menu.png`
- Focus/reply sheet state: `/tmp/rental-radar-inbox-final-focus-sheet.png`
- Combined comparison input: `/tmp/inbox-design-qa-final-comparison.png`
- Source pixels: 2808 × 722. Normalized to 1440 × 370 for content-region comparison.
- Desktop implementation pixels/CSS viewport: 1440 × 1024 at device scale factor 1.
- Mobile implementation pixels/CSS viewport: 390 × 844 at device scale factor 1.
- State: light theme, fixture organization, default unfiltered Inbox with three Facebook Group/Messenger leads.
- Density normalization: source downsampled proportionally to 1440 px width; implementation main-content region cropped after the persistent app rail and normalized to the same 1440 px comparison width.

## Full-view comparison evidence

The final desktop capture preserves the source hierarchy and density: a compact page title, a single authoritative table, the same channel/customer/message/location/budget/source/assignee/status/time columns, three representative rows, subtle dividers, and the blue operational accent. The intentional added filter row replaces the source's redundant Workspace/Table switch and supports the user's requested combined filters without changing the table's information architecture.

The final mobile capture uses the same table-only information architecture as a responsive row list. All filters remain available, the page has no horizontal overflow (`innerWidth = scrollWidth = 390`), persistent bottom navigation remains visible, and no persistent control is clipped.

## Focused region comparison evidence

Focused comparison was required because table typography, column rhythm, status dots, truncation, and filter affordances are too small to judge reliably in the full-page capture. `/tmp/inbox-design-qa-final-comparison.png` places the source and final rendered content region in one image. It confirms:

- Fonts and typography: Thai/Latin system sans fallbacks, weight hierarchy, compact row labels, line-height, and ellipsis behavior are consistent with the source's operations-dashboard tone.
- Spacing and layout rhythm: table columns align, row heights remain compact, dividers are consistent, and the added filters use a coherent grid rather than forcing overflow.
- Colors and visual tokens: neutral white/gray surfaces, indigo primary controls, muted metadata, green connection state, and amber/red status semantics are consistent and accessible.
- Image quality and asset fidelity: the source contains no photographic or illustrative assets. UI icons render as sharp vector icon components; the connected Facebook identity avatar safely falls back to initials when no trusted HTTPS avatar is available.
- Copy and content: labels are Thai-first, operational, and concise. Facebook identity, app account, role, recovery, and logout are separated in the account menu without exposing provider IDs, tokens, cookies, or profile URLs.

## Interaction and runtime checks

- Opened the default Inbox, Facebook identity/account menu, and selected-row focus/reply sheet.
- Verified desktop row selection and sheet rendering.
- Verified mobile filter layout and all three responsive lead rows.
- Verified the account menu exposes the connected Facebook Page identity and connection counts while keeping the app user/role separate.
- Browser console and page errors checked in desktop and mobile captures: none.
- Mobile horizontal overflow check: none.

## Comparison history

### Iteration 1 — blocked

- P2: mobile rendered both the shell's `Inbox` title and the page's `Inbox` heading.
- P2: mobile rendered both global topbar search and the Inbox filter search, consuming excessive above-the-fold space.
- P2: mobile hid location, minimum-budget, and maximum-budget filters.
- Fix: removed the redundant mobile shell title/global search presentation, retained the single page-owned Inbox search, and exposed every authoritative filter in the responsive grid.
- Post-fix evidence: `/tmp/rental-radar-inbox-table-mobile-pagination-fixed.png` and `/tmp/rental-radar-inbox-final-mobile.png`.

### Iteration 2 — passed

- No actionable P0/P1/P2 visual or responsive findings remain.
- Desktop default, profile menu, focus sheet, and mobile default states were recaptured from the live fixture server after the final production build.
- The intentional filter-row addition is an accepted product requirement rather than source drift.

## Findings

No actionable P0/P1/P2 findings remain.

## Open questions

None for this handoff. A real Facebook avatar will appear only when the trusted tenant-scoped Page identity provides an HTTPS image; otherwise the safe initials fallback is expected.

## Implementation checklist

- [x] Table-only Inbox is authoritative.
- [x] Combined URL-owned filters are available on desktop and mobile.
- [x] Cursor pagination exposes leads beyond the first page.
- [x] Row focus opens the existing detail/reply flow.
- [x] Facebook profile/account menu is functional and role-aware.
- [x] Mobile has no horizontal overflow or duplicated search/title.
- [x] Console/page errors checked.

## Follow-up polish

No blocking polish remains. A live Page avatar may replace the initials fallback after real Meta connection setup.

final result: passed
