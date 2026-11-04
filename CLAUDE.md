# PO Desk — master context

## Role and mission
You are a senior full-stack developer building PO Desk, an internal, mobile-first web app for three South African companies. It must:
1. Issue a live Xero purchase order number within seconds when staff buy with a company card or cash, coded to the right chart-of-accounts code.
2. Let the buyer photograph the till slip with their phone, read it with Gemini, and create a DRAFT Xero bill linked to that PO with the slip attached.
Build on a zero-cost stack. Work one stage at a time. End every stage with a report (files changed, how to deploy, manual test steps, open issues) and stop. Never start the next stage unprompted.

## Companies (entities)
| entity_id | Legal name in Xero | Xero tenant ID | Notes |
|---|---|---|---|
| HPB | HP Biotech Group (Pty) Ltd | 3b167b1c-1023-4463-a02b-46f44b56fb4a | Partner and 25% shareholder in Pharma Karu. Brand #386D27 / #4D8429 / #01201A |
| NHP | NHP GLOBAL SA (PTY) LTD | 910e6495-b557-4d16-ad76-e0190cd60546 | Brand #509544 / #7A9D41 / #595959 |
| PK | Pharma Karu | 7f209224-7389-441c-ab85-e52a8a393601 | Hosts the portal. Brand #14532D / #C4862A / #5B6470 |
The same Composio connection also reaches Nandrea Health Products (tenant e775d9d3-4807-4163-9941-029493fa272b). It is out of scope: block that tenant ID in code.

## Stack (fixed; do not substitute)
- Frontend: Cloudflare Pages at https://po.pharmakaru.co.za. HTML5 + vanilla JS (ES modules) + Tailwind compiled at build time with the Tailwind CLI (not the Play CDN). Installable PWA (manifest + icons); no service-worker caching of API responses.
- Backend: one Google Apps Script web app (Execute as: Me; Who has access: Anyone). Source in /apps-script, pushed with clasp. appsscript.json timeZone = Africa/Johannesburg.
- Database: Google Sheet "PO Desk DB"; each tab is a table (see Data model).
- Files: Google Drive folder "PO Desk" via DriveApp.
- Xero: only through Composio's REST API, called from Apps Script with UrlFetchApp.
- Slip reading: Gemini API free tier via UrlFetchApp; model name lives in Config.
- Email: MailApp for approvals and notifications.
- Never call Composio or Gemini from the browser. No Supabase, no Cloudflare Workers, no paid services.

## Network contract
- /frontend/src/config.js exports API_URL = 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec' and APP_VERSION. Nothing else is configured in the frontend.
- Every request: fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, token, payload, idemKey }) }). text/plain avoids a CORS preflight, which Apps Script cannot answer. No custom headers.
- doPost(e) parses e.postData.contents, routes by action, and returns ContentService.createTextOutput(JSON.stringify(envelope)).setMimeType(ContentService.MimeType.JSON). doGet(e) is a health check only: { ok, version }.
- Envelope: { ok: true, data } or { ok: false, error: { code, message } }. Never return stack traces or keys.

## Secrets (Script Properties only)
COMPOSIO_API_KEY, COMPOSIO_XERO_ACCOUNT_ID, COMPOSIO_USER_ID (if the API needs it), GEMINI_API_KEY, SHEET_ID, DRIVE_ROOT_ID. Nothing secret in the repo or the frontend.

## Composio and Xero rules
- One wrapper, composioExecute(toolSlug, args), in Composio.gs. Check the current REST endpoint, auth header and body shape at docs.composio.dev before writing it (expected: the v3 tools-execute endpoint, an x-api-key header, the connected account ID and an arguments object).
- All Xero calls go through helpers in Xero.gs that REQUIRE a tenantId and throw if it is missing, blank or the Nandrea tenant. Composio's Xero tools fall back to the first connected org when tenant_id is omitted, which would post a purchase into the wrong company's books.
- Verified 3 Nov 2026: XERO_GET_CONTACTS ignores tenant_id even when it is sent and always returns HPB's contacts. It is banned in Xero.gs (TENANT_UNSAFE_TOOLS); contacts are read through the proxy with an explicit xero-tenant-id header. The sync refuses to write if any AccountID or ContactID appears under two companies. Treat any tool not yet proven per tenant the same way.
- Tools: XERO_GET_CONNECTIONS, XERO_GET_ORGANISATION, XERO_LIST_ACCOUNTS, XERO_LIST_TAX_RATES, XERO_GET_CONTACTS, XERO_CREATE_CONTACT, XERO_CREATE_PURCHASE_ORDER, XERO_UPDATE_PURCHASE_ORDER, XERO_GET_PURCHASE_ORDER, XERO_LIST_PURCHASE_ORDERS, XERO_CREATE_INVOICE (Type ACCPAY), XERO_POST_INVOICE_UPDATE, XERO_GET_INVOICE, XERO_LIST_INVOICES, XERO_UPLOAD_ATTACHMENT.
- Gaps to prove in Stage 1:
  (a) The create tools for POs and invoices do not expose LineAmountTypes. Till slips are VAT-inclusive, so set Inclusive with the update tools straight after creation, unless the create tools are shown to accept it.
  (b) XERO_UPLOAD_ATTACHMENT takes a Composio file reference (s3key), not raw bytes. Find the supported route from Apps Script: Composio's file-upload endpoint, or its proxy-execute endpoint calling Xero's Attachments API directly.
  (c) The PO number is PurchaseOrderNumber in the create response; Xero assigns it from each org's own PO numbering settings. Parse responses defensively (e.g. data.PurchaseOrders[0]).
- Resolved (Stage 1 and 4): the create tools silently drop LineAmountTypes and AttentionTo, so POs are created in ONE call through the proxy (PUT /PurchaseOrders) with Inclusive, AttentionTo and the final status together; the update tool is only a backstop. Attachments and History notes also go through the proxy.
- Verified 4 Nov 2026: Xero's API cannot edit archived contacts, including un-archiving them ("Archived contacts cannot currently be edited via the API"), and refuses a second contact with the same name. A buyer asking for an archived supplier is told to have it restored in Xero.
- Retry 429 and 5xx with exponential backoff, max 3 attempts. Log every call (tool, entity, ms, ok) to AuditLog.
- Budget: Composio's free tier is about 20,000 tool calls a month (check the dashboard). One purchase uses roughly 5 to 8 calls; the nightly sync about 15. Keep calls off the hot path wherever a cache will do.

## Data model (Sheet tabs; row 1 = headers; IDs are UUIDs unless stated)
- Config(key, value)
- Entities(entity_id, legal_name, short_name, xero_tenant_id, drive_folder_id, brand_key, active)
- Users(user_id, name, email, pin_hash, pin_salt, role [buyer|approver|admin], active, failed_attempts, locked_until, pin_token_hash, pin_token_expires, created_by, created_at)
- UserEntities(user_id, entity_id, can_buy, can_approve, po_limit_zar)
- PaymentMethods(pm_id, entity_id, type [CARD|CASH], label, last4, holder_name, holder_user_id, xero_bank_account_id, xero_bank_account_name, active). Map by AccountID: these orgs' bank accounts have blank account codes.
- Categories(category_id, entity_id, name, account_code, tax_type, keywords, sort, active)
- Accounts(entity_id, account_id, code, name, type, class, tax_type, status, synced_at)
- TaxRates(entity_id, tax_type, name, rate, status, synced_at)
- Suppliers(entity_id, contact_id, name, vat_number, synced_at)
- SupplierHistory(entity_id, contact_id, account_code, uses, last_used)
- POs(po_id, idem_key, entity_id, xero_po_id, po_number, provisional_ref, status, buyer_user_id, pm_id, contact_id, supplier_name, description, category_id, account_code, tax_type, amount_incl_zar, suggestion_source, created_at, approver_user_id, decided_at, bill_id)
- Bills(bill_id, po_id, entity_id, xero_invoice_id, slip_number, slip_date, supplier_vat_no, total_incl_zar, vat_zar, drive_file_id, ocr_json, flags, created_by, created_at)
- Queue(job_id, type, payload_json, attempts, next_run_at, last_error)
- AuditLog(ts, user_id, entity_id, action, ref, ok, detail_json)
PO status values: ISSUED, AWAITING_APPROVAL, DECLINED, PENDING_XERO, BILLED, CANCELLED.
Read each tab once per request with getDataRange().getValues(); write whole rows with setValues; wrap PO creation in LockService.getScriptLock().
Exception for speed (Stage 4): web app requests read all their tabs in one Sheets API batchGet and createPO writes its rows in parallel (Db.gs fast path; testFastSheets proves it matches SpreadsheetApp cell for cell). Any Sheets API failure falls back to SpreadsheetApp.

## Seed data: payment methods
Setup.gs seedPaymentMethods() writes these rows and is safe to run twice. Each card is a cheque (debit) card, so it clears straight to that company's cheque bank account in Xero.
| entity_id | type | label | last4 | holder_name | Xero bank account | xero_bank_account_id |
|---|---|---|---|---|---|---|
| NHP | CARD | Cheque card | 9514 | DP Groenewald | FNB CURRENT (…4274) | b97af25a-95f9-46e3-87ba-975bebc6e34f |
| PK | CARD | Cheque card | 9581 | DP Groenewald | Pharma Karu Cheque | 3c6891b1-5d7f-49cb-9100-ce0d46ad7f11 |
| HPB | CARD | Cheque card | 6358 | RG Duncan | HP Biotech Cheque | 5052e5c9-0411-4f1c-a509-62a0a802e833 |
| NHP | CASH | Petty cash | | custodian TBC | Petty Cash | 618f8bfe-9d39-4572-a38f-3637884ebb45 |
| PK | CASH | Petty cash | | custodian TBC | Pharma Karu Petty Cash | 4016c0c3-7f48-45f0-b0e1-7ff3e3c4524e |
| HPB | CASH | Petty cash | | custodian TBC | HP Biotech Petty Cash | fc8f7e76-94bd-4871-9076-a53bc4ae8ef7 |
Each company has one cash float. Bank accounts (cards and cash floats) are matched by AccountID, never by name, because the names differ per company. Ignore HPB's bank account named "UNUSED".

## Seed data: first admin
Setup.gs seedAdmin() creates the only user before go-live: Dawid Groenewald, dawie@nhpglobalgroup.com, role admin, active, with can_buy and can_approve for HPB, NHP and PK. po_limit_zar: ask Dawie before seeding. Everyone else is added on the People screen. Dawie sets his own PIN by running setPin() once from the Apps Script editor; never write a PIN into the repo, a file or a log.

## Flow 1: raise a PO
1. Buyer logs in and picks the company (only those they may buy for; skip the picker if there is just one).
2. Form: payment method (that company's cards and cash floats), supplier (type-ahead over cached Xero suppliers; "New supplier" creates a Xero contact), what is being bought, estimated amount incl. VAT in rand, category.
3. The coding engine suggests an account code with a reason (e.g. "last 4 bills from this supplier"); the buyer can change it to any active purchase account of that company.
4. Submit with a client-generated idemKey. Backend checks permissions, dedupes on idemKey, then creates the Xero PO: contact, Date and DeliveryDate today, one line (description, qty 1, amount, account code, tax type), Reference "<card label> ••<last4> · <buyer first name>", AttentionTo the buyer, Inclusive amounts.
5. Amount within the buyer's limit: Status AUTHORISED; the PO number shows large with a copy button. Above the limit: Status SUBMITTED; the buyer sees the number marked "Awaiting approval: don't buy yet" and approvers are emailed. Approve sets AUTHORISED, decline sets DELETED; the buyer is told either way.
6. If Composio or Xero still fails after retries: issue a provisional ref <ENTITY>-P-<yyMMdd>-<seq>, status PENDING_XERO, and queue a retry (time trigger every 5 minutes). Put the provisional ref in the eventual Xero PO's Reference and tell the buyer the real number. Never invent anything that looks like a Xero PO number.
Target: PO number on screen in under 5 seconds on 4G for an existing supplier.

## Flow 2: slip to draft bill
1. Buyer opens an open PO (or taps "Add slip" and picks one), then "Photograph slip". Use the phone's native camera: <input type="file" accept="image/*" capture="environment">, plus a second input without capture for the gallery. Do NOT use getUserMedia; in-browser camera streams are unreliable on Android browsers.
2. In the browser: downscale to 1600 px on the long edge, JPEG quality about 0.75, honour EXIF orientation, base64-encode, show a thumbnail.
3. Backend saves the image to Drive: PO Desk/<Entity>/<YYYY>/<MM>/<PO number>_<YYYY-MM-DD>_<supplier>_<total>.jpg.
4. Gemini returns strict JSON (responseMimeType application/json with a responseSchema): supplier_name, supplier_vat_number, slip_number, date, currency, line_items [{ description, qty, unit_price_incl, line_total_incl }], subtotal_excl, vat_amount, total_incl, payment_method_hint, plus a confidence per field.
5. Review screen, pre-filled and editable. Warn, don't block, when: the total differs from the PO by more than Config VARIANCE_PCT (default 10%) or VARIANCE_ZAR (default R500); the supplier name doesn't match the PO's contact; there is no supplier VAT number (bill uses the no-VAT tax type); the total is above R5,000, which needs a full tax invoice; the slip date is more than 3 days from the PO date; or it looks like a duplicate (same supplier + slip number, or same supplier + date + total). VAT thresholds come from Config and are confirmed with the accountant.
6. Submit creates the Xero bill: Type ACCPAY, Status DRAFT, the PO's contact, Date and DueDate = slip date, Reference "<PO number> · <slip number>", lines from the slip (or one line for the total) coded to the PO's account code, tax type from the cached tax rates, Inclusive amounts. Attach the slip to the bill and to the PO, set the PO to BILLED, and record the link in Bills and POs.
Xero's API has no field linking a bill to a PO; that link only exists when a bill is made with Xero's own "Copy to bill". So the link here is: PO number in the bill's Reference + the same slip on both + PO status BILLED + the Bills row. If Composio can reach Xero's History and Notes endpoint, also add a note on each record naming the other.

## Account coding engine (Coding.gs)
suggestAccount(entityId, contactId, categoryId, description) returns { accountCode, taxType, source, reason }, trying in order:
1. Supplier history: if this supplier's last N coded purchases in this company (Config, default 5) share one account code, use it.
2. Keyword rules: Categories.keywords matched against the description (case-insensitive, whole words).
3. Category default: Categories.account_code for the chosen category.
4. Fallback: Config DEFAULT_ACCOUNT_<entity>, flagged "needs review".
Only return a code that is ACTIVE in that company's cached chart and valid for purchases. The buyer's final choice updates SupplierHistory. Categories and codes are per company because the three charts of accounts differ.

## Security
- Login: email + 6-digit PIN, stored as SHA-256(salt + PIN) via Utilities.computeDigest. Five failed attempts lock the account for 15 minutes.
- Session token: Utilities.getUuid() held in CacheService (6-hour maximum), refreshed on use; the browser keeps it in sessionStorage.
- Every action re-checks on the server that the user is still active, their role and their UserEntities; never trust the company the browser says it picked.
- People are managed on the in-app People screen (admins only; built in Stage 7). Cards, cash floats and categories are edited in the Sheet for v1. Setup.gs keeps createUser() and setPin() only to bootstrap the first admin.
- PINs are always chosen by the person through an emailed single-use link (48-hour expiry, token stored only as a hash). Admins never see or set anyone's PIN.
- Rate-limit logins and PO creation per user.

## UI and branding
- Mobile-first, one-handed, large tap targets; must work in Android Chrome and iOS Safari.
- Brand colours and logos come from /frontend/brand/brands.json; follow its notes on which colours are safe for small text.
- The shell is Pharma Karu-branded (the host). Keep a BRANDS map keyed by entity and by hostname, so more subdomains can be added later. Once a company is chosen, the header logo and accent switch to it and a fixed bar reads "Buying for: <company>", so nobody posts to the wrong books.
- Screens: Login, Company picker, Home (New PO, Add slip, My POs with status chips), New PO, PO issued, Slip capture, Slip review, Approvals (approvers only), Set PIN, People (admins only).
- Plain language. Amounts in rand with two decimals; dates like 3 Nov 2026.

## Code standards
- Frontend: /frontend/index.html, /frontend/src/{config,api,auth,brand,router,camera}.js, /frontend/src/views/*.js, /frontend/brand/<entity>/.
- Backend: /apps-script/{Main,Auth,Db,Config,Composio,Xero,Coding,Ocr,Drive,Approvals,Sync,Setup,Tests}.gs and appsscript.json.
- Complete files only; the only placeholders allowed are API_URL and Script Properties values. Comment the why, not the what.
