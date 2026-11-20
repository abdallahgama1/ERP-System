export const TAXONOMY_KINDS = ["category", "brand", "tag", "unit"] as const;
export type TaxonomyKindShared = (typeof TAXONOMY_KINDS)[number];

export const STOCK_MOVEMENT_TYPES = [
  "purchase_receive",
  "purchase_return",
  "sales_invoice",
  "sales_return",
  "transfer_out",
  "transfer_in",
  "adjustment_in",
  "adjustment_out",
  "write_off",
  "stock_take",
  "opening_balance",
  "work_order_consume",
  "work_order_produce",
] as const;
export type StockMovementTypeShared = (typeof STOCK_MOVEMENT_TYPES)[number];

export const TRANSFER_STATUSES = [
  "Draft",
  "In Transit",
  "Received",
  "Partial",
  "Cancelled",
] as const;
export type TransferStatusShared = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_SHORTAGE_RESOLUTIONS = [
  "none",
  "return_to_source",
  "write_off_in_transit",
  "backorder",
  "close_short",
  "claim_carrier",
] as const;
export type TransferShortageResolutionShared = (typeof TRANSFER_SHORTAGE_RESOLUTIONS)[number];

export const COUNT_SESSION_STATUSES = [
  "In Progress",
  "Completed",
  "Cancelled",
] as const;
export type CountSessionStatusShared = (typeof COUNT_SESSION_STATUSES)[number];

export const PURCHASE_ORDER_STATUSES = [
  "Draft",
  "Issued",
  "Partially Received",
  "Received",
  "Closed",
  "Cancelled",
] as const;
export type PurchaseOrderStatusShared = (typeof PURCHASE_ORDER_STATUSES)[number];

export const VENDOR_BILL_STATUSES = [
  "Draft",
  "Open",
  "Partially Paid",
  "Paid",
  "Cancelled",
  "Void",
] as const;
export type VendorBillStatusShared = (typeof VENDOR_BILL_STATUSES)[number];

export const SALES_ORDER_STATUSES = [
  "Draft",
  "Confirmed",
  "Partially Fulfilled",
  "Fulfilled",
  "Cancelled",
] as const;
export type SalesOrderStatusShared = (typeof SALES_ORDER_STATUSES)[number];

export const SALES_INVOICE_STATUSES = [
  "Draft",
  "Sent",
  "Partially Paid",
  "Paid",
  "Cancelled",
  "Void",
] as const;
export type SalesInvoiceStatusShared = (typeof SALES_INVOICE_STATUSES)[number];

export const RETAINER_INVOICE_STATUSES = [
  "Draft",
  "Sent",
  "Paid",
  "Partially Applied",
  "Applied",
  "Cancelled",
] as const;
export type RetainerInvoiceStatusShared = (typeof RETAINER_INVOICE_STATUSES)[number];
