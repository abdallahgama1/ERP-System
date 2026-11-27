# User Acceptance Testing (UAT) Script — Full Day of Real Operations

Run this checklist on an isolated **rehearsal database** (seeded via `npm run rehearse:cutover` or your company's real cutover CSVs) before signing off on production go-live. All monetary values below are in **EGP** with **14% VAT**.

---

## Pre-UAT Setup
- Confirm the rehearsal instance is running cleanly (`GET /health` → `200`, `GET /ready` → `200`).
- Sign in as an **Admin** user and verify **Admin → Data Import & Cutover** (`/admin/imports`) shows **Cutover Readiness Check: PASS — Ready** (8/8 reconciliation controls, healthy setup, intact audit chain).
- Verify your company base currency is `EGP` in **Settings → Company** (`/settings`).

| # | Sign-Off | Tester | Date |
| :-: | :--- | :--- | :--- |
| 0 | `[ ] PASS  [ ] FAIL` — Rehearsal baseline ready & Cutover Readiness = PASS | | |

---

## Step 1 — Create Customer (B2B with ETA Egypt Fields)
- **Route:** **Sales → Customers** (`/sales/customers`) → click **Add Customer**
- **Actions:**
  1. Name: `Cairo Metro Contracting`
  2. Company: `Cairo Metro Contracting SAE`
  3. ETA Receiver Type: `B — Business`
  4. Tax Registration Number (RIN): `310550770` (9 digits)
  5. Currency: `EGP`, Payment Terms: `NET30`, Credit Limit: `100000`
  6. Save.
- **Expected Result:**
  - Customer appears in the customer directory and search results.
  - Invalid RIN lengths (e.g., 5 digits) are rejected for Business (`B`) customers.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 2 — Receive Stock & Post Vendor Bill (Purchasing)
- **Route:** **Purchases → Purchase Orders** (`/purchases/orders/new`) → **Purchase Receives** (`/purchases/receives/new`) → **Vendor Bills** (`/purchases/bills`)
- **Actions:**
  1. Create a PO for vendor `VEND-SYN-01` (HQ-01) for `20 × SYN-VALVE-01` at `160.00 EGP` (14% VAT).
  2. Receive all `20` units on **Purchase Receives** (`RCV-*`).
  3. Create & post a **Vendor Bill** (`BILL-*`) linked to that receive (`Subtotal 3,200.00`, `VAT 448.00`, `Total 3,648.00 EGP`).
- **Expected Result:**
  - Stock on hand for `SYN-VALVE-01` at `HQ-01` increases by `20` and WMAC average cost recalculates deterministically (`(120×150 + 20×160) / 140 = 151.4286 EGP`).
  - GL postings:
    - On Receive: `DR 1200 Inventory 3,200.00 / CR 2100 GRNI 3,200.00`.
    - On Vendor Bill: `DR 2100 GRNI 3,200.00 + DR 1300 Input VAT 448.00 / CR 2000 AP 3,648.00`.
  - Vendor bill appears as `Open` in **Vendor Bills**.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 3 — Create Sales Order (Quote) & Sales Invoice + Customer Payment
- **Route:** **Sales → Sales Orders** (`/sales/orders/new`) → **Invoices** (`/sales/invoices`) → **Received Payments** (`/sales/payments`)
- **Actions:**
  1. Create a Sales Order for `Cairo Metro Contracting` (`HQ-01`) for `10 × SYN-VALVE-01` at `260.00 EGP` (14% VAT).
  2. Convert/create a posted **Sales Invoice** (`Status = Sent`, `Subtotal 2,600.00`, `VAT 364.00`, `Total 2,964.00 EGP`).
  3. Record a **Received Payment** of `2,964.00 EGP` (`Bank Transfer`) allocated against the invoice.
  4. *(Optional cutover check)* Also record a partial payment of `10,000.00 EGP` against opening invoice `OPEN-AR-2025-001` and confirm it applies cleanly.
- **Expected Result:**
  - Stock on hand for `SYN-VALVE-01` drops by `10`.
  - GL postings on Invoice: `DR 1100 AR 2,964.00 / CR 4000 Sales Revenue 2,600.00 + CR 2300 Output VAT 364.00`, plus `DR 5000 COGS / CR 1200 Inventory` at WMAC cost.
  - Invoice transitions to `Paid` after payment; AR balance reduces cleanly.
  - Under ETA mode, the new B2B invoice appears in **Admin → E-Invoice Queue** (`/admin/einvoicing`), while `OPEN-AR-2025-001` does **not**.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 4 — POS Sale & POS Return
- **Route:** **POS Register** (`/pos`)
- **Actions:**
  1. Open a cashier shift on an active terminal (enter 4-digit PIN if prompted; set opening float e.g. `1,000.00 EGP`).
  2. Scan or select `SYN-PUMP-02` (qty `2`, unit price `495.00 EGP`, 14% VAT → `Subtotal 990.00`, `VAT 138.60`, `Total 1,128.60 EGP`).
  3. Complete checkout using **Split Tender** (e.g., `628.60 EGP Cash` + `500.00 EGP Card`) and preview/print the thermal receipt.
  4. Open **Recent Receipts**, select the receipt, and process a **POS Return** (`POSR-*`) for `1` unit (`564.30 EGP` refunded, restock enabled).
- **Expected Result:**
  - Stock decreases by `2` on sale and increases by `1` on return.
  - Output VAT GL (`2300`) increases by `138.60` on sale and reverses by `69.30` on `POSR-*` return (net `+69.30 EGP`).
  - Both `S` (Sale) and `R` (Return) receipts queue in **E-Invoice Queue** when ETA mode is enabled.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 5 — Operating Expense Claim
- **Route:** **Accounting → Operating Expenses** (`/expenses`)
- **Actions:**
  1. Create a direct-treasury expense claim paid from `CSH-HQ-SYN` (`HQ Petty Cashbox`) for `Office Supplies` (`5500` or operating expense account), net `500.00 EGP`, `14%` VAT (`70.00 EGP`), total `570.00 EGP`.
  2. Approve and pay (or submit direct treasury).
- **Expected Result:**
  - Expense claim shows status `Paid`.
  - GL posts `DR Expense 500.00 + DR 1300 Input VAT 70.00 / CR 1031 HQ Petty Cashbox 570.00`.
  - Cashbox balance in **Treasury & Bank** decreases by `570.00 EGP`.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 6 — Bank Reconciliation
- **Route:** **Accounting → Treasury & Bank** (`/treasury/accounts`)
- **Actions:**
  1. Select `BNK-CIB-SYN` (`CIB Main Operating EGP`).
  2. Import a sample bank statement CSV containing a deposit matching Step 3's customer payment (`+2,964.00`) and a bank charge (`-50.00`).
  3. Match the `+2,964.00` line to its posted GL journal line and post the `-50.00` line as a Bank Fee (`DR Bank Charges / CR 1030 Main Operating Bank`).
- **Expected Result:**
  - Matched statement lines change status to `Reconciled`.
  - Bank fee automatically posts a balanced journal entry and reduces `1030` GL balance by `50.00 EGP`.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 7 — Month-End Close & Period Lock
- **Route:** **Accounting → Fiscal Periods** (`/accounting/periods`)
- **Actions:**
  1. Click **Lock** on the active test month (e.g., `2026-01`).
  2. Attempt to post a manual journal entry in **Journal Entries** (`/accounting/journal-entries`) dated inside `2026-01`.
  3. *(Optional)* Run **FX Revaluation Wizard** preview to confirm zero errors.
  4. Unlock `2026-01` if further testing is needed, or verify admin **Reopen Fiscal Year** flow on a closed test year.
- **Expected Result:**
  - Locked period shows `Locked` badge with timestamp.
  - Backdated journal entry in the locked period is rejected with a clear period-locked error.
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 8 — VAT Return Report & Financial Statements
- **Route:** **Accounting → Financial Statements** (`/accounting/statements`) & **Subledger Reconciliation** (`/accounting/reconciliation`)
- **Actions:**
  1. Open **Financial Statements → VAT Return** for the test period.
  2. Open **Trial Balance**, **Profit & Loss**, **Balance Sheet**, and **Cash Flow**.
  3. Open **Subledger Reconciliation** (`/accounting/reconciliation`).
- **Expected Result:**
  - **VAT Return:**
    - Current-period Output VAT = `364.00 (invoice) + 138.60 (POS) - 69.30 (POSR) = 433.30 EGP` (excludes opening AR invoices).
    - Current-period Input VAT = `448.00 (bill) + 70.00 (expense) = 518.00 EGP` (excludes opening AP bills).
    - Opening VAT carryover (`5,600.00` Output / `3,500.00` Input) is reported separately and reconciles cleanly to GL `2300` (`6,033.30`) and GL `1300` (`4,018.00`).
  - **Trial Balance & Balance Sheet:** `Balanced = true` (`Total Debits === Total Credits`; `Assets === Liabilities + Equity`).
  - **Subledger Reconciliation:** **8 / 8 PASS** (`0.00` variance on every control account).
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Step 9 — Audit Log, Hash Chain & Cutover Readiness Sign-Off
- **Route:** **Administration → Audit Log** (`/audit-log`) & **Data Import & Cutover** (`/admin/imports`)
- **Actions:**
  1. Review the Audit Log and confirm entries exist for customer creation, stock receipt, invoice, POS return, expense claim, period lock, and bank reconciliation with actor names and request details.
  2. Open **Data Import & Cutover** (`/admin/imports`) and click **Refresh** on the **Cutover Readiness Check** card (or call `GET /api/imports/cutover-readiness`).
  3. Confirm `GET /api/audit-logs/verify` reports `valid: true`.
- **Expected Result:**
  - **Cutover Readiness Check** shows **PASS — Ready**:
    - Subledger Reconciliation: **Pass** (8/8)
    - Accounting Setup Health: **Pass** (0 issues)
    - Audit Hash Chain: **Pass** (0 broken rows)
- **Sign-Off:** `[ ] PASS  [ ] FAIL`

---

## Final UAT Approval

| Role | Name | Decision | Signature / Date |
| :--- | :--- | :--- | :--- |
| Finance / Accountant | | `[ ] Approved  [ ] Rejected` | |
| Operations / Warehouse | | `[ ] Approved  [ ] Rejected` | |
| System Administrator | | `[ ] Approved  [ ] Rejected` | |
