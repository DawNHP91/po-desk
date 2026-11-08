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

Two deployments of the same script project (same Sheet, Drive and Xero):

| Deployment | ID | Used by |
|---|---|---|
| Production | `AKfycbwDjzLypkr9e_G9ZbedGTR6cTkc42pPwwG9VGMdOaLmP-tDEgtwQrXeW6UrzzmSrio5` | `main` → po.pharmakaru.co.za |
| Test | `AKfycbzA66-ZRoT7nxh0_hg0yVUqWAv080DYa_PbDhNerKUx0o6RvOP_0CTvUZmWrtMyLEaA` | stage branches → `<branch>.po-desk-d5b.pages.dev` |

```sh
clasp push                                    # upload apps-script/ (changes neither deployment)
clasp update-deployment <TEST_ID> -d "what"   # try it on a preview first
clasp update-deployment <PROD_ID> -d "what"   # then publish it to po.pharmakaru.co.za
```

`update-deployment` publishes the pushed code as a new version behind the same URL. If a change adds an
OAuth scope, run any function in the editor and approve it first, or the live app fails to authorise.

Secrets live only in Script Properties (Project Settings → Script Properties): `COMPOSIO_API_KEY`,
`COMPOSIO_XERO_ACCOUNT_ID`, `COMPOSIO_USER_ID`, `GEMINI_API_KEY`; `SHEET_ID` and `DRIVE_ROOT_ID` are
written by the setup functions.

One-off setup, run from the Apps Script editor in this order: `setupSheets`, `setupDrive`, `listTenants`,
`installTriggers`, `syncAll`, `proposeCategories`, `seedAdmin`, then `setMyPin` (add Script Properties
`SETPIN_EMAIL` and `SETPIN_PIN` first; the function deletes both). Everyone else is added on the People
screen and sets their own PIN from the emailed link. Every setup function is safe to run twice; run
`setupSheets` again after any update that adds columns.

Scheduled jobs (`installTriggers`, one trigger each, safe to run again): `nightlySync` 02:00 SAST (Xero
reference data, supplier history, the learned-word index for account suggestions, and learned keywords), `processQueue` every 5 minutes (provisional POs, unfinished bills, approval reminders),
`dailyDigest` 08:00 SAST (email to admins). `sendDigestNow` shows today's digest any time.

## Go-live

Done on 4 Nov 2026 up to step 4; steps 5–7 are yours.

1. `clasp push` from the repo root.
2. New production deployment (a new, immutable version behind its own URL):
   `clasp create-version "PO Desk 0.7.0 go-live"` → `clasp create-deployment -V <that version> -d "PO Desk production"`.
3. `frontend/src/config.js`: `API_URL = 'https://script.google.com/macros/s/<PROD_ID>/exec'`, commit on `main`.
4. Merge into `main` and push: Cloudflare builds production at https://po-desk-d5b.pages.dev.
5. In the Apps Script editor: `setupSheets`, `installTriggers`.
6. Custom domain. Cloudflare dashboard → Workers & Pages → **po-desk** → Custom domains → Set up a custom domain →
   `po.pharmakaru.co.za` → Continue.
   - If pharmakaru.co.za's DNS is on Cloudflare, it adds the record itself; confirm.
   - Otherwise, at the DNS host for pharmakaru.co.za add **CNAME** `po` → `po-desk-d5b.pages.dev` (TTL "auto" or 1 hour),
     then wait until Cloudflare shows the domain **Active** with its certificate
     (minutes to an hour).
7. Smoke test on https://po.pharmakaru.co.za: the Pharma Karu sign-in page loads over https with no browser warning;
   sign in; Home shows your companies, Approvals and People; New PO → a small PO in one company → real PO number;
   My POs lists it; then cancel it in Xero (or run `cleanupTestPOs` if it was raised as a test).

Then run the UAT in `UAT.md` for HPB, NHP and PK.

## Tests

Offline (no network, nothing real is called), from the repo root:

```sh
tests/offline/run.sh          # summary and any failures; exits non-zero if anything fails
tests/offline/run.sh --all    # every PASS line too
```

It runs every `.gs` file in Node against fakes of Sheets, Drive, Composio/Xero, Gemini and MailApp (Stages 5–10: 144
checks), plus the coding engine's fixed cases (`testCoding`, 46) and the category proposals (21). `tests/offline/build/` is
generated and not committed. In the editor (results in the execution log): `testTenantGuard`, `testCoding`, `testSyncGuards`,
`testCodingLive`, `testFastSheets`, `testAccessControl`, `testLockout`.

Acceptance helpers:
- POs: `armForcedPOFailure` (the next PO acts as if Composio is down), `armOutageForUat` (the next three),
  `poTimingReport`.
- Slips: `runSlipTest`, `rerunFailedSlips`, `scoreSlipTest`, `armGeminiFailure`.
- Bills: `checkBills_NHP` / `_HPB` / `_PK` / `checkBills_all` (reads each bill back from Xero), `armBillAttachFailure`.
- Account suggestions: `testCoding` (engine cases), `testWordSuggestions_NHP` / `_HPB` / `_PK` (backtest of
  learned words on the last 12 months of bills; changes nothing), `learnKeywordsNow` (relearns every company's
  keywords from old bills now instead of at 02:00).
- UAT: `createUatAccounts` (Script Property `UAT_PIN` first), `deactivateUatAccounts`, `cleanupTestPOs` (all three
  companies: deletes test bills, then test POs, in Xero; bins their slips; archives the "PO Desk Test Supplier …" and
  "QA Vendor …" contacts).
