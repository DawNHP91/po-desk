# PO Desk UAT checklist

Run on the live domain, **https://po.pharmakaru.co.za**, once for each company: **HPB (HP Biotech), NHP (NHP Global)
and PK (Pharma Karu)**. Tick a cell only when the expected result is seen. "Auto" lines are driven by a script against
the live site with the UAT test accounts; "You" lines need a real inbox or Xero and are done by hand.

## Before you start (Apps Script editor)

1. `setupSheets` (new columns), `installTriggers`, then Script Property `UAT_PIN` and `createUatAccounts`.
   Accounts (fake `@po-desk.test` addresses, no email ever goes to them):
   `test.buyer.hpb@`, `test.buyer@` (NHP), `test.buyer.pk@` — buyers, limit R500 in their own company only;
   `test.approver@` — can approve HPB, NHP and PK, cannot buy.
2. Just before the run: `armOutageForUat` (the next three PO creations act as if Composio is down).

## Per company

| # | Test | How | Expected | HPB | NHP | PK |
|---|---|---|---|---|---|---|
| 1 | PO under limit | Auto: test buyer, card, new supplier, R120 | Real PO number on screen in seconds, status Issued; PO in Xero AUTHORISED, Inclusive | | | |
| 2 | PO over limit, then approved | Auto: R650 → test approver approves with a note | Buyer sees "Awaiting approval: don't buy yet"; Approvals lists it; after approval the buyer's PO is Issued and shows "Approved by Test Approver: note"; Xero PO AUTHORISED with a History note | | | |
| 3 | Declined PO | Auto: R700 → test approver declines (tap twice) with a note | Buyer's PO Declined with the note; Xero PO DELETED | | | |
| 4 | New supplier | Auto: "+ New supplier" in test 1 | Supplier created in that company's Xero only (it appears in no other company) | | | |
| 5 | Slip with a VAT number | Auto: slip on PO 1 → Create the bill | Draft bill: Reference "PO-xxxx · slip no", Inclusive, VAT = slip VAT; slip on bill and PO; PO BILLED | | | |
| 6 | Slip without a VAT number | Auto: slip on the approved PO 2 | Amber note "No supplier VAT number"; bill with VAT R0.00 | | | |
| 7 | Slip over R5,000 | Auto: PO R5,750 → approved → slip R5,750 | Amber note "Over R5,000: SARS needs a full tax invoice…"; bill made | | | |
| 8 | Duplicate slip | Auto: same slip again on another PO | Amber note "This looks like a slip already captured on PO-…" | | | |
| 9 | Composio outage | Auto, after `armOutageForUat`: one PO per company | Provisional ref (e.g. NHP-P-261105-01), not a PO number; within ~5 min the queue makes the real PO and the PO screen shows it | | | |
| 10 | Another company's data | Auto: this company's buyer asks for another company's reference data, PO and slip | FORBIDDEN / "PO not found" / "Slip not found" every time; nothing returned | | | |
| 11 | Admin adds a buyer; PIN from the email link | You: People → Add a person → `dawie@pharmakaru.co.za`, Buyer, can buy in this company (once, all three ticked) → open the email → set PIN → sign in | Email "PO Desk: set your PIN" with a link that opens Set PIN; PIN saved; sign-in works; the picker shows the ticked companies; the link fails if opened again | | | |
| 12 | PIN reset | You: People → that person → Reset PIN (tap twice) → new email → new PIN | Old PIN refused at once; any open session on another phone ends; new PIN works | | | |
| 13 | Deactivated person is refused | You: People → Deactivate (tap twice) | Their open session ends on the next tap; sign-in refused; their POs still listed for admins | | | |
| 14 | Non-admin calls an admin action | Auto: test buyer and test approver call listPeople / savePerson / resetPin / setPersonActive | FORBIDDEN each time; nothing changes; AuditLog shows `auth.forbidden` | | | |

Also check once (You):
- Dawie gets the approval email for tests 2, 3 and 7, and its link opens straight at that PO in Approvals.
- After 4 working hours, an approval still waiting gets exactly one reminder (leave one PO waiting overnight).
- The 08:00 digest arrives the next morning.
- `checkBills_all` passes for every bill from the run, and the bills look right in Xero (Business → Bills to pay → Draft).

## Afterwards

`cleanupTestPOs` (deletes the test bills and POs in all three Xero orgs, bins the slips, archives the test suppliers),
`deactivateUatAccounts`, and on the People screen deactivate `dawie@pharmakaru.co.za` if it was only for testing.
