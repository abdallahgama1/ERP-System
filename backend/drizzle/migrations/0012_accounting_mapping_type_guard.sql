-- Forward-only migration: remove any gl_account_mappings rows that were previously
-- auto-bound by code collision to an account whose account_type does not match
-- the required type for that mapping_key, then safely bind missing keys only when
-- both code and account_type match.
DELETE FROM "gl_account_mappings" gm
USING "chart_of_accounts" coa,
  (VALUES
    ('default_cash_bank', 'asset'),
    ('pos_cash_drawer', 'asset'),
    ('card_clearing', 'asset'),
    ('accounts_receivable', 'asset'),
    ('inventory_asset', 'asset'),
    ('in_transit_inventory', 'asset'),
    ('wip_inventory', 'asset'),
    ('input_vat', 'asset'),
    ('fixed_assets_cost', 'asset'),
    ('accumulated_depreciation', 'asset'),
    ('accounts_payable', 'liability'),
    ('grni', 'liability'),
    ('retainer_liability', 'liability'),
    ('output_vat', 'liability'),
    ('employee_reimbursements', 'liability'),
    ('opening_equity', 'equity'),
    ('retained_earnings', 'equity'),
    ('sales_revenue', 'revenue'),
    ('cogs', 'expense'),
    ('inventory_adjustment', 'expense'),
    ('write_off_expense', 'expense'),
    ('cash_over_short', 'expense'),
    ('operating_expenses', 'expense'),
    ('realized_fx', 'expense'),
    ('unrealized_fx', 'expense'),
    ('depreciation_expense', 'expense'),
    ('asset_disposal_gain_loss', 'expense'),
    ('rounding_variance', 'expense')
  ) AS expected("mapping_key", "expected_type")
WHERE gm."account_id" = coa."id"
  AND gm."mapping_key" = expected."mapping_key"
  AND coa."account_type" <> expected."expected_type";--> statement-breakpoint
INSERT INTO "gl_account_mappings" ("company_id", "mapping_key", "account_id")
SELECT coa."company_id", m."mapping_key", coa."id"
FROM "chart_of_accounts" coa
INNER JOIN (VALUES
  ('1000', 'default_cash_bank', 'asset'),
  ('1010', 'pos_cash_drawer', 'asset'),
  ('1020', 'card_clearing', 'asset'),
  ('1100', 'accounts_receivable', 'asset'),
  ('1200', 'inventory_asset', 'asset'),
  ('1210', 'in_transit_inventory', 'asset'),
  ('1220', 'wip_inventory', 'asset'),
  ('1300', 'input_vat', 'asset'),
  ('1500', 'fixed_assets_cost', 'asset'),
  ('1510', 'accumulated_depreciation', 'asset'),
  ('2000', 'accounts_payable', 'liability'),
  ('2100', 'grni', 'liability'),
  ('2200', 'retainer_liability', 'liability'),
  ('2300', 'output_vat', 'liability'),
  ('2400', 'employee_reimbursements', 'liability'),
  ('3000', 'opening_equity', 'equity'),
  ('3100', 'retained_earnings', 'equity'),
  ('4000', 'sales_revenue', 'revenue'),
  ('5000', 'cogs', 'expense'),
  ('5100', 'inventory_adjustment', 'expense'),
  ('5200', 'write_off_expense', 'expense'),
  ('5400', 'cash_over_short', 'expense'),
  ('5500', 'operating_expenses', 'expense'),
  ('5600', 'realized_fx', 'expense'),
  ('5610', 'unrealized_fx', 'expense'),
  ('5700', 'depreciation_expense', 'expense'),
  ('5710', 'asset_disposal_gain_loss', 'expense'),
  ('5900', 'rounding_variance', 'expense')
) AS m("code", "mapping_key", "expected_type")
  ON m."code" = coa."code" AND m."expected_type" = coa."account_type"
ON CONFLICT ("company_id", "mapping_key") DO NOTHING;
