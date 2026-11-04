# PO Desk

Internal, mobile-first web app for Pharma Karu, HP Biotech and NHP Global: a live Xero PO number at
the till, then a photographed slip that becomes a draft Xero bill. The full brief is in `CLAUDE.md`.

| Part | Where | Runs on |
|---|---|---|
| Frontend | `frontend/` | Cloudflare Pages (static: HTML, ES modules, Tailwind built at deploy time) |
| Backend | `apps-script/` | One Google Apps Script web app, pushed with clasp |
| Data | Google Sheet "PO Desk DB" and Drive folder "PO Desk" | Google |

## Frontend: Cloudflare Pages

Connect this repo in Cloudflare (Workers & Pages → Create → Pages → Connect to Git) with:

| Setting | Value |
|---|---|
| Framework preset | None |
| Root directory | `frontend` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Production branch | `main` |
| Node version | from `frontend/.node-version` (22); or set env var `NODE_VERSION=22` |

`npm run build` copies the static files into `frontend/dist/` and compiles `dist/app.css` with the
Tailwind CLI. Every branch other than `main` gets a preview URL (`https://<branch>.<project>.pages.dev`).
`frontend/_headers` sets the Content-Security-Policy and other security headers.

Local build:

```sh
cd frontend
npm install
npm run build
python3 -m http.server 8765 --directory dist   # then open http://127.0.0.1:8765
```

The only frontend setting is `frontend/src/config.js` (`API_URL`, `APP_VERSION`).

## Backend: Apps Script

```sh
clasp push                                   # upload apps-script/ to the project
clasp update-deployment AKfycbzA66-ZRoT7nxh0_hg0yVUqWAv080DYa_PbDhNerKUx0o6RvOP_0CTvUZmWrtMyLEaA   # publish it (same URL)
```

A push alone does not change the live web app; `update-deployment` publishes the pushed code as a
new version behind the same URL. If a change adds an OAuth scope, run any function in the editor
and approve it first, or the live app will fail to authorise.

Secrets live only in Script Properties (Project Settings → Script Properties): `COMPOSIO_API_KEY`,
`COMPOSIO_XERO_ACCOUNT_ID`, `COMPOSIO_USER_ID`, `GEMINI_API_KEY`; `SHEET_ID` and `DRIVE_ROOT_ID` are
written by the setup functions.

One-off setup, run from the Apps Script editor in this order: `setupSheets`, `setupDrive`,
`listTenants`, `installSyncTrigger`, `installQueueTrigger`, `syncAll`, `proposeCategories`,
`seedAdmin`, then `setMyPin` (add Script Properties `SETPIN_EMAIL` and `SETPIN_PIN` first; the
function deletes both). Every setup function is safe to run twice.

Triggers: `syncAll` daily at 02:00 SAST; `processQueue` every 5 minutes (turns provisional POs into
real Xero POs when Xero is back).

Tests (editor, results in the execution log): `testTenantGuard`, `testCoding`, `testSyncGuards`,
`testCodingLive`, `testFastSheets`, `testAccessControl`, `testLockout` (the last two need
`createTestBuyerNHP` first). PO acceptance helpers: `armForcedPOFailure` (next PO acts as if
Composio is down), `poTimingReport` (median/worst server time per step), `cleanupTestPOs` (deletes
test POs in Xero and archives "PO Desk Test Supplier …" contacts).
