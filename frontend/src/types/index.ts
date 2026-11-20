export interface ModulePermissionFlags {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role?: 'admin' | 'user' | 'manager';
  isActive?: boolean;
  branchScopeMode?: 'all' | 'selected';
  branchIds?: string[];
  defaultBranchId?: string | null;
  permissions?: Record<string, ModulePermissionFlags>;
}

export interface Product {
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  sellingPrice: number;
  costPrice: number;
  brand: string;
  category: string;
  unit?: string;
  minStockLevel?: number;
  barcode?: string | null;
  itemType?: 'stock' | 'non_stock' | 'service' | 'manufactured';
  trackingMode?: 'none' | 'lot' | 'serial';
  requiresExpiry?: boolean;
  shelfLifeDays?: number | null;
  pickingStrategy?: 'FEFO' | 'FIFO' | 'LIFO';
  hasBom?: boolean;
}

export interface Branch {
  branchId: string;
  branch_name: string;
  branch_location: string;
  contact_number: string;
  code?: string;
  branchType?: 'hq_warehouse' | 'warehouse' | 'retail';
  isDefault?: boolean;
  isActive?: boolean;
}

// ============== Sales ==============

export interface Customer {
  id: string;
  displayName: string;
  companyName?: string;
  customerType: 'business' | 'individual';
  contactFirstName?: string;
  contactLastName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  currency: 'SAR' | 'AED' | 'USD' | 'EGP';
  paymentTerms: 'NET15' | 'NET30' | 'COD';
  creditLimit?: number | null;
  billingAddress?: string;
  shippingAddress?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'Active' | 'In Progress' | 'Completed' | 'Cancelled';

// ---- Sales Orders ----

export type SalesOrderStatus = 'Draft' | 'Confirmed' | 'Partially Fulfilled' | 'Fulfilled' | 'Closed' | 'Cancelled';

export interface SalesOrderItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  fulfilledQty: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
}

export interface SalesOrder {
  id: string;
  soNumber: string;
  customerId: string;
  customerName: string;
  branchId: string;
  branchName: string;
  orderDate: string;
  expectedShipDate: string;
  referenceNumber?: string;
  status: SalesOrderStatus;
  items: SalesOrderItem[];
  subtotal: number;
  totalTax: number;
  grandTotal: number;
  internalNotes?: string;
  termsAndConditions?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  sessionNumber?: string;
  createdByUserId: string;
  createdByName: string;
  branchId: string;
  branchName?: string;
  name?: string;
  description?: string;
  status: SessionStatus;
  adjustmentId?: string;
  completedAt?: string;
  completedBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Sales Invoices ----

export type InvoiceStatus = 'Draft' | 'Sent' | 'Partially Paid' | 'Paid' | 'Overdue' | 'Cancelled';

export interface InvoiceItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
  lotAllocations?: Array<{ lotId?: string; lotNumber?: string; quantity: number }>;
  serialNumbers?: string[];
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  branchId?: string;
  branchName?: string;
  salesOrderId?: string;
  soNumber?: string;
  invoiceDate: string;
  dueDate: string;
  status: InvoiceStatus;
  items: InvoiceItem[];
  subtotal: number;
  totalTax: number;
  grandTotal: number;
  amountPaid: number;
  creditAppliedAmount?: number;
  retainerAppliedAmount?: number;
  icv?: number | null;
  invoiceHash?: string | null;
  prevInvoiceHash?: string | null;
  qrTlv?: string | null;
  eInvoiceStatus?: string;
  voidReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface SessionItem {
  productId: string;
  sessionId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  expectedQty?: number;
  sellingPrice: number;
  costPrice: number;
  status: 'Exact' | 'Over Count' | 'Under Count';
  variance: number;
}

export interface BranchProduct {
  productId: string;
  branchId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  avgCost?: number;
  sellingPrice: number;
  costPrice: number;
}

export interface DashboardStats {
  totalProducts: number;
  totalBranches: number;
  activeSessions: number;
  lowStockAlerts: number;
}

export type StockMovementType =
  | 'initial'
  | 'opening_balance'
  | 'assignment'
  | 'adjustment'
  | 'adjustment_in'
  | 'adjustment_out'
  | 'write_off'
  | 'damage'
  | 'transfer_in'
  | 'transfer_out'
  | 'session_count'
  | 'stock_take'
  | 'return'
  | 'return_to_vendor'
  | 'purchase_return'
  | 'purchase_receive'
  | 'receive_no_po'
  | 'sales_fulfillment'
  | 'sales_invoice'
  | 'sales_return';

export interface StockMovement {
  id: string;
  productId: string;
  branchId?: string;
  product_name: string;
  product_sku: string;
  branchName?: string;
  type: StockMovementType;
  quantity: number;
  unitCost?: number;
  reference?: string;
  notes?: string;
  createdAt: string;
  createdBy?: string;
  balanceAfter: number;
}

export interface Vendor {
  id: string;
  displayName: string;
  companyName?: string;
  contactFirstName?: string;
  contactLastName?: string;
  email?: string;
  phone?: string;
  taxNumber?: string;
  currency: 'SAR' | 'AED' | 'USD' | 'EGP';
  paymentTerms: 'NET15' | 'NET30' | 'COD';
  billingAddress?: string;
  shippingAddress?: string;
  payablesBalance: number;
  createdAt: string;
  updatedAt: string;
}

export type PurchaseOrderStatus = 'Draft' | 'Issued' | 'Partially Received' | 'Closed' | 'Cancelled';

export interface PurchaseOrderItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  receivedQty: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  branchId?: string;
  branchName?: string;
  orderDate: string;
  expectedDate: string;
  referenceNumber?: string;
  status: PurchaseOrderStatus;
  items: PurchaseOrderItem[];
  subtotal: number;
  totalTax: number;
  grandTotal: number;
  internalNotes?: string;
  termsAndConditions?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseReceiveItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  orderedQty: number;
  previouslyReceivedQty: number;
  receivingNow: number;
  unitPrice: number;
  lotNumber?: string;
  expiryDate?: string;
  serialNumbers?: string[];
}

export interface PurchaseReceive {
  id: string;
  receiveNumber: string;
  purchaseOrderId: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  branchId: string;
  branchName: string;
  receiveDate: string;
  items: PurchaseReceiveItem[];
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

// ============== Inventory ops ==============

export type AdjustmentReason = 'recount' | 'stock_take' | 'damage' | 'theft' | 'expiry' | 'correction' | 'other';

export interface Adjustment {
  id: string;
  reference: string;
  productId: string;
  product_name: string;
  product_sku: string;
  branchId: string;
  branchName: string;
  beforeQty: number;
  newQty: number;
  delta: number;
  reason: AdjustmentReason;
  note?: string;
  approver?: string;
  createdAt: string;
  createdBy?: string;
}

export type WriteOffReason = 'damage' | 'expiry' | 'loss' | 'theft' | 'other';

export interface WriteOff {
  id: string;
  reference: string;
  productId: string;
  product_name: string;
  product_sku: string;
  branchId: string;
  branchName: string;
  quantity: number;
  reason: WriteOffReason;
  note?: string;
  costImpact: number;
  createdAt: string;
  createdBy?: string;
}

export type TransferStatus = 'Draft' | 'In Transit' | 'Received' | 'Cancelled';
export type TransferShortageResolution = 'none' | 'return_to_source' | 'write_off_in_transit';

export interface TransferItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  receivedQty: number;
}

export interface Transfer {
  id: string;
  reference: string;
  sourceBranchId: string;
  sourceBranchName: string;
  destBranchId: string;
  destBranchName: string;
  status: TransferStatus;
  shortageResolution?: TransferShortageResolution;
  items: TransferItem[];
  notes?: string;
  createdAt: string;
  createdBy?: string;
  dispatchedAt?: string;
  receivedAt?: string;
  cancelledAt?: string;
}

// ============== Audit log ==============

export type AuditModule =
  | 'inventory'
  | 'branches'
  | 'purchases'
  | 'sales'
  | 'sessions'
  | 'users'
  | 'settings'
  | 'transfers'
  | 'adjustments'
  | 'write_offs';

export interface AuditEntry {
  id: string | number;
  at: string;
  user?: string;
  actorUserId?: string;
  module: AuditModule;
  action: string;
  entity?: string;
  entityId?: string | number;
  meta?: Record<string, unknown>;
}

// ============== Purchase Returns ==============

export type PurchaseReturnReason = 'damaged' | 'wrong_item' | 'expired' | 'quality' | 'other';

export interface PurchaseReturnItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  receivedQty: number;
  returnQty: number;
  unitPrice: number;
}

export interface PurchaseReturn {
  id: string;
  reference: string;
  receiveId: string;
  receiveNumber: string;
  purchaseOrderId: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  branchId: string;
  branchName: string;
  returnDate: string;
  reason: PurchaseReturnReason;
  note?: string;
  items: PurchaseReturnItem[];
  creditAmount: number;
  createdAt: string;
  createdBy?: string;
}

// ============== Vendor Bills & Payments ==============

export type BillStatus = 'Draft' | 'Open' | 'Partially Paid' | 'Paid' | 'Overdue' | 'Cancelled';

export type BillMatchStatus = 'matched' | 'qty_mismatch' | 'price_mismatch' | 'unmatched';

export interface VendorBillItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
  receivedQty?: number;
  orderedUnitPrice?: number;
}

export interface VendorBill {
  id: string;
  billNumber: string;
  vendorBillReference?: string;
  vendorId: string;
  vendorName: string;
  branchId?: string;
  receiveId?: string;
  receiveNumber?: string;
  purchaseOrderId?: string;
  poNumber?: string;
  billDate: string;
  dueDate: string;
  status: BillStatus;
  matchStatus: BillMatchStatus;
  matchNotes: string[];
  items: VendorBillItem[];
  subtotal: number;
  totalTax: number;
  grandTotal: number;
  amountPaid: number;
  notes?: string;
  voidReason?: string;
  createdAt: string;
  createdBy?: string;
}

export interface PaymentAllocation {
  billId: string;
  billNumber: string;
  amount: number;
}

export interface PaymentMade {
  id: string;
  paymentNumber: string;
  vendorId: string;
  vendorName: string;
  paymentDate: string;
  method: PaymentMethod;
  reference?: string;
  amount: number;
  allocations: PaymentAllocation[];
  status?: PaymentDocumentStatus;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

export type PaymentMethod = 'cash' | 'bank' | 'card' | 'cheque';
export type PaymentDocumentStatus = 'Posted' | 'Voided';

export interface ReceivedPaymentAllocation {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
}

export interface ReceivedPayment {
  id: string;
  paymentNumber: string;
  customerId: string;
  customerName: string;
  paymentDate: string;
  method: PaymentMethod;
  reference?: string;
  amount: number;
  allocations: ReceivedPaymentAllocation[];
  unapplied: number;
  status?: PaymentDocumentStatus;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

// ---------------- Sales: returns / credit notes ----------------

export type SalesReturnReason = 'damaged' | 'wrong_item' | 'expired' | 'not_needed' | 'other';
export type SalesReturnDisposition = 'restock' | 'write_off';

export interface SalesReturnItem {
  id: string;
  productId: string;
  product_name: string;
  product_sku: string;
  returnQty: number;
  unitPrice: number;
  taxPercent: number;
  amount: number;
  disposition: SalesReturnDisposition;
}

export interface SalesReturn {
  id: string;
  returnNumber: string;
  creditNoteNumber?: string;
  customerId: string;
  customerName: string;
  invoiceId?: string;
  invoiceNumber?: string;
  salesOrderId?: string;
  soNumber?: string;
  branchId: string;
  branchName: string;
  returnDate: string;
  reason: SalesReturnReason;
  items: SalesReturnItem[];
  creditTotal: number;
  creditApplied: number;
  notes?: string;
  createdAt: string;
  createdBy?: string;
}

// ---------------- Sales: retainer invoices ----------------

export type RetainerStatus = 'Draft' | 'Sent' | 'Paid' | 'Partially Applied' | 'Applied' | 'Cancelled';

export interface RetainerInvoice {
  id: string;
  retainerNumber: string;
  customerId: string;
  customerName: string;
  branchId?: string;
  retainerDate: string;
  status: RetainerStatus;
  amount: number;
  amountPaid: number;
  amountApplied: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}
