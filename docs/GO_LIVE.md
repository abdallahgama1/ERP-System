# Go-Live & Legacy Cutover Guide

This runbook governs migrating an existing single-company business from legacy accounting/inventory software onto **Count It, Keep It ERP** cleanly, audibly, and reversibly.

> [!IMPORTANT]
> **Accountant Sign-Off Required:** The exact **cutover date** and **cutover accounting approach** (Balance-Sheet-only with prior earnings on `3100 Retained Earnings` vs mid-year P&L carry-in via `allowPnlAccounts=true`, plus treatment of opening Output/Input VAT carryover) **must be agreed in writing with the company's accountant before running production imports.**

---

## 1. Cutover Approach & Accounting Treatment

1. **Recommended Cutover Date:** First day of a new fiscal year or first day of a new month/quarter immediately after closing the legacy period. The chosen `cutoverDate` must fall inside an **open** fiscal period in the ERP.
2. **Balance-Sheet-Only Default (`allowPnlAccounts = false`):**
   - Load **Assets, Liabilities, and Equity** balances from the frozen legacy closing Trial Balance.
   - Carry cumulative prior-year and year-to-date net earnings as a single line on **`3100 Retained Earnings`**.
   - Revenue (`4xxx`) and Expense (`5xxx`) accounts are rejected by default to prevent distorting post-cutover P&L statements. Only enable `allowPnlAccounts = true` if your accountant explicitly requires mid-year YTD P&L balances in the ERP.
3. **Opening AR & AP Document Flagging (`source = 'opening_balance'`):**
   - Open customer invoices and open vendor bills carried forward from the legacy system are tagged `source = 'opening_balance'`.
   - They **appear in AR/AP aging** and **can be settled/paid/allocated** normally via Received Payments and Payments Made.
   - They are **strictly excluded** from:
     - **VAT Return (`GET /api/accounting/reports/vat-return`)** sales and purchase document buckets (no double taxation of prior-period invoices)
     - **Sales vs Purchases** and **Dashboard Revenue / Purchases** operational totals
     - **ETA / ZATCA E-Invoice Submission Queue** (never submitted or re-signed)
4. **Opening VAT Carryover Treatment (`2300` / `1300`):**
   - Unremitted Output VAT (`2300`) and recoverable Input VAT (`1300`) from the legacy Trial Balance post cleanly in the single opening journal entry.
   - In `GET /api/accounting/reports/vat-return`, these balances are reported separately as `openingOutputVatCarryover` and `openingInputVatCarryover` (with an explanatory `openingVatReconciliationNote`) and excluded from current-period taxable sales/purchase buckets.
   - In `GET /api/accounting/reports/reconciliation`, `Subledger VAT + Opening VAT Carryover` reconciles 1-to-1 against GL `2300` and `1300`.

---

## 2. Pre-Cutover Preparation & Dry-Run Rehearsal

1. **Freeze Legacy Master Data & Take Full Pre-Cutover Backups:**
   - Stop all postings in the legacy ERP/accounting system at the cutoff timestamp (e.g., 23:59 on the day prior to `cutoverDate`).
   - Export frozen legacy reports for independent sign-off:
     - Closing Trial Balance (EGP)
     - Aged Accounts Receivable by open invoice
     - Aged Accounts Payable by open vendor bill
     - Physical stock count & unit cost valuation per branch
     - Fixed Assets register (historical cost, accumulated depreciation, in-service dates, useful life)
     - Bank & cashbox closing balances per account
2. **Prepare Your Real CSV Files Outside Git:**
   - Download CSV templates from **Admin → Data Import & Cutover** (`/admin/imports`) or `GET /api/imports/templates/:kind`.
   - Place real company CSVs in a git-ignored directory such as `./cutover-data/` (already listed in `.gitignore` — **never commit real financial data**).
   - CSV files support UTF-8 (with or without BOM), Arabic text, Arabic-Indic numerals (`٠-٩`), Excel thousands separators, and decimal commas. Max 5 MiB / 10,000 rows per file.
   - Validate ETA Egypt requirements before cutover:
     - Customers: `eta_receiver_type` (`B`, `P`, or `F`); Business (`B`) requires 9-digit Tax Registration Number (RIN); Person (`P`) validates 14-digit National ID when supplied.
     - Vendors: 9-digit RIN or 14-digit National ID when supplied.
     - Products: include `barcode`, `unit`, `eta_code_type` (`GS1`/`EGS`), `eta_item_code`, and `eta_unit_type`.
3. **Run the Full Rehearsal on a Scratch Database:**
   ```bash
   # Rehearse with built-in synthetic fixtures:
   npm run rehearse:cutover

   # Rehearse with your own real CSV folder (runs ONLY on local scratch Postgres; refuses prod DATABASE_URL):
   npm run rehearse:cutover -- --dir ./cutover-data --cutover-date 2026-01-01 --currency EGP
   ```
   Confirm the rehearsal prints:
   - Balanced Opening Trial Balance matching your frozen legacy books
   - **8 / 8 PASS** on Subledger-to-GL Reconciliation
   - **Healthy** Accounting Setup Health (`15 / 15` mappings valid)
   - **Valid** Audit Log Hash Chain

---

## 3. Production Cutover Execution Sequence

Before importing into production, take a **baseline PostgreSQL backup** per [BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md) and [OPERATIONS.md](./OPERATIONS.md):
```bash
pg_dump --format=custom --no-owner --no-privileges --file=backups/pre-cutover-$(date +%Y%m%d-%H%M%S).dump "$DATABASE_URL"
```

Verify the production environment is ready:
- Confirm `GET /health` and `GET /ready` return HTTP `200`.
- Configure **Settings → Company** (`baseCurrency`, `taxRegistrationNumber`, `einvoicingMode`, legal name, address) and ensure all physical **Branches** exist with matching `code` values.
- Ensure the **Fiscal Year** covering `cutoverDate` exists and its target period is `open` (`/accounting/periods`).

Execute imports via **Admin → Data Import & Cutover** (`/admin/imports`) in this **exact order**, running **Validate (Dry Run)** before every **Commit All-or-Nothing**:

| Order | Dataset | Endpoint | Notes |
| :---: | :--- | :--- | :--- |
| **1** | **Chart of Accounts** | `POST /api/imports/chart_of_accounts` | Inspect projected **Setup Health** in the dry-run report. Resolve any mapping collisions via `/accounting/setup-health` before proceeding. |
| **2** | **Customers** | `POST /api/imports/customers` | Validates `eta_receiver_type` and ETA RIN / NID formats. |
| **3** | **Vendors** | `POST /api/imports/vendors` | Validates ETA RIN / NID formats. |
| **4** | **Products & Barcodes** | `POST /api/imports/products` | Imports SKUs, barcodes, Arabic names, UOM, and ETA GS1/EGS fields; auto-registers taxonomy. |
| **5** | **Opening Stock per Branch** | `POST /api/imports/opening_stock` | Sets `branch_products` quantities & WMAC costs (`movement_type = opening_balance`). Total valuation must match GL `1200` in Step 8. |
| **6** | **Opening Fixed Assets** | `POST /api/imports/opening_fixed_assets` | Loads asset register (`source = opening_balance`). Totals must match GL `1500` & `1510` in Step 8. |
| **7** | **Opening Treasury Accounts** | `POST /api/imports/opening_treasury` | Links bank & cashbox accounts 1-to-1 to active Asset GL accounts (`source = opening_balance`). |
| **8** | **Opening Balances (TB + Open AR + Open AP)** | `POST /api/imports/opening-balances` | Allowed **only once** while zero non-opening JEs exist. Posts **one** balanced opening journal dated at `cutoverDate` and creates flagged open AR/AP documents. |

---

## 4. Mandatory Go-Live Sign-Off Checks

Do **not** open the system to operational users until every check below passes:

1. **Trial Balance Tie-Out:** Open **Accounting → Financial Statements → Trial Balance** (`/accounting/statements`) and confirm every account balance matches the frozen legacy Trial Balance to the exact piastre and `Total Debits === Total Credits`.
2. **Subledger-to-GL Reconciliation (8/8 PASS):** Open **Accounting → Subledger Reconciliation** (`/accounting/reconciliation`) and confirm all 8 controls show **Pass** with `0.00` variance:
   - Accounts Receivable (`1100`) vs Open AR documents
   - Accounts Payable (`2000`) vs Open AP documents
   - Inventory Valuation (`1200`) vs Physical Branch Stock
   - Output VAT (`2300`) vs VAT Subledger + Opening Carryover
   - Input VAT (`1300`) vs VAT Subledger + Opening Carryover
   - Fixed Assets Cost (`1500`) vs Fixed Assets Register
   - Accumulated Depreciation (`1510`) vs Fixed Assets Register
   - Treasury Accounts (`1030+`) vs Bound Asset GL Accounts
3. **Physical Stock Spot-Check:** Spot-check branch stock counts in **Branches** and **Inventory Valuation** against signed physical count sheets.
4. **AR / AP Aging Verification:** Open **Reports → AR Aging** (`/reports/ar-aging`) and confirm open customer balances match the legacy aging report by customer and due bucket, while **Sales vs Purchases** (`/reports/sales-vs-purchases`) and **VAT Return** sales/purchase buckets show `0.00` prior to new operational transactions.
5. **E-Invoice Queue Clean:** Open **Administration → E-Invoice Queue** (`/admin/einvoicing`) and confirm **zero** opening AR documents appear in the queue.
6. **Accounting Setup Health:** Open **Accounting → Setup Health** (`/accounting/setup-health`) and confirm **Healthy** (`0` issues).
7. **Audit Log Hash Chain:** Verify `GET /api/audit-logs/verify` returns `valid: true`.
8. **Take Post-Cutover Golden Backup:** Capture a fresh `pg_dump` immediately after accountant sign-off and before enabling live user access.

---

## 5. Undo & Rollback Procedures

### Option A — Controlled Opening Reversal (Before Live Operations Begin)
If a cutover mistake is found **before** any non-opening journal entry, payment allocation, or depreciation run has been posted:
1. Open **Admin → Data Import & Cutover** (`/admin/imports`) and click **Reverse Opening Cutover** (or call `POST /api/imports/opening-balances/reverse` with an admin session and required `reason`).
2. This atomically:
   - Posts a balanced mirror reversing journal entry (`opening_balance_reversal`) dated at `cutoverDate`
   - Removes all flagged opening AR invoices, AP bills, fixed assets, treasury accounts, and opening stock
   - Writes `opening_balances.reversed` into the tamper-evident audit hash chain
3. Fix the source CSVs and re-run Steps 5–8 cleanly.

### Option B — Full Database Rollback via Pre-Cutover Backup
If live operational postings have already started or you need a complete revert to the pre-cutover state:
1. Place the application in maintenance mode / stop backend containers.
2. Restore `backups/pre-cutover-*.dump` using the exact restore steps in [BACKUP_RESTORE_AND_ROLLBACK.md](./BACKUP_RESTORE_AND_ROLLBACK.md) and [OPERATIONS.md](./OPERATIONS.md).
3. Restart the service, confirm `/ready` returns `200`, and re-verify `GET /api/audit-logs/verify`.
