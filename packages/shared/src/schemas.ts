import { z } from "zod";
import { ETA_CODE_TYPES, ETA_RECEIVER_TYPES } from "./einvoicing.ts";
import { ITEM_TYPES, PICKING_STRATEGIES, TRACKING_MODES, lotAllocationInputSchema } from "./inventory-extensions.ts";
import { offsetPageQuerySchema, optionalUuidQuery } from "./pagination.ts";
import { BRANCH_TYPES } from "./permissions.ts";
import { TAXONOMY_KINDS, TRANSFER_SHORTAGE_RESOLUTIONS } from "./statuses.ts";

// Branches
export const branchInputSchema = z.object({
  code: z.string().trim().min(1).max(32).optional(),
  name: z.string().trim().min(1, "Branch name is required").max(120),
  branchType: z.enum(BRANCH_TYPES).optional().default("retail"),
  location: z.string().trim().max(200).optional().default(""),
  address: z.string().trim().max(300).optional().default(""),
  phone: z.string().trim().max(60).optional().default(""),
  email: z.string().trim().max(120).optional().default(""),
  managerName: z.string().trim().max(120).optional().default(""),
  etaBranchId: z.string().trim().max(16).optional().default("0"),
  country: z.string().trim().max(8).optional().default("EG"),
  governorate: z.string().trim().max(100).optional().default(""),
  regionCity: z.string().trim().max(100).optional().default(""),
  street: z.string().trim().max(200).optional().default(""),
  buildingNumber: z.string().trim().max(40).optional().default(""),
  postalCode: z.string().trim().max(24).optional().default(""),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
});
export const updateBranchSchema = branchInputSchema.partial();
export type BranchInput = z.input<typeof branchInputSchema>;

// Taxonomy
export const createTaxonomySchema = z.object({
  kind: z.enum(TAXONOMY_KINDS),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(300).optional().default(""),
  symbol: z.string().trim().max(32).optional().default(""),
  color: z.string().trim().max(32).optional().default(""),
});
export const updateTaxonomySchema = createTaxonomySchema.partial().omit({ kind: true });
export type CreateTaxonomyInput = z.input<typeof createTaxonomySchema>;

// Products & Inventory Operations
export const initialStockSchema = z.object({
  branchId: z.string().uuid(),
  quantity: z.number().min(0),
  unitCost: z.number().min(0).optional(),
  lotNumber: z.string().trim().min(1).max(80).optional(),
  manufactureDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
});

export const createProductSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required").max(80),
  barcode: z.string().trim().max(80).nullable().optional(),
  name: z.string().trim().min(1, "Product name is required").max(160),
  nameAr: z.string().trim().max(160).optional().default(""),
  description: z.string().trim().max(500).optional().default(""),
  category: z.string().trim().max(120).optional().default(""),
  brand: z.string().trim().max(120).optional().default(""),
  unit: z.string().trim().max(40).optional().default("pcs"),
  tags: z.array(z.string()).optional().default([]),
  costPrice: z.number().min(0).default(0),
  sellingPrice: z.number().min(0).default(0),
  minStockLevel: z.number().min(0).default(0),
  itemType: z.enum(ITEM_TYPES).optional().default("stock"),
  trackingMode: z.enum(TRACKING_MODES).optional(),
  requiresExpiry: z.boolean().optional().default(false),
  shelfLifeDays: z.number().int().positive().nullable().optional().default(null),
  pickingStrategy: z.enum(PICKING_STRATEGIES).optional().default("FEFO"),
  trackLots: z.boolean().optional().default(false),
  trackSerials: z.boolean().optional().default(false),
  etaCodeType: z.enum(ETA_CODE_TYPES).optional().default("EGS"),
  etaItemCode: z.string().trim().max(80).optional().default(""),
  etaUnitType: z.string().trim().max(16).optional().default("EA"),
  initialStock: z.array(initialStockSchema).optional().default([]),
});

export const updateProductSchema = createProductSchema
  .partial()
  .omit({ initialStock: true })
  .extend({ isActive: z.boolean().optional() });
export type CreateProductInput = z.input<typeof createProductSchema>;

export const adjustBranchLevelSchema = z.object({
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  newQuantity: z.number().min(0),
  unitCost: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  notes: z.string().trim().max(300).optional().default("Branch stock update"),
});

export const adjustmentSchema = z.object({
  branchId: z.string().uuid(),
  reason: z.string().trim().min(1).max(60),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyDelta: z.number().optional(),
        newQty: z.number().min(0).optional(),
        notes: z.string().trim().max(250).optional().default(""),
        lotNumber: z.string().trim().min(1).max(80).optional(),
        manufactureDate: z.string().nullable().optional(),
        expiryDate: z.string().nullable().optional(),
        lotAllocations: z.array(lotAllocationInputSchema).optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .min(1),
});

export const writeOffSchema = z.object({
  branchId: z.string().uuid(),
  reason: z.string().trim().min(1).max(60),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        notes: z.string().trim().max(250).optional().default(""),
        lotAllocations: z.array(lotAllocationInputSchema).optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .min(1),
});

export const createTransferSchema = z.object({
  fromBranchId: z.string().uuid(),
  toBranchId: z.string().uuid(),
  status: z.enum(["Draft", "In Transit"]).optional().default("In Transit"),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        notes: z.string().trim().max(250).optional().default(""),
        lotAllocations: z.array(lotAllocationInputSchema).optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .min(1),
});

export const receiveTransferSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyReceived: z.number().min(0),
      })
    )
    .min(1),
  shortageResolution: z.enum(TRANSFER_SHORTAGE_RESOLUTIONS).optional(),
  notes: z.string().trim().max(500).optional(),
});

// Count Sessions
export const createSessionSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1, "Session name is required").max(160),
  notes: z.string().trim().max(500).optional().default(""),
  productIds: z.array(z.string().uuid()).optional(),
});

export const patchSessionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  notes: z.string().trim().max(500).optional(),
  branchId: z.string().uuid().optional(),
  status: z.enum(["In Progress", "Cancelled"]).optional(),
});

export const upsertSessionItemsSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        countedQty: z.number().min(0),
        scannedCount: z.number().int().min(0).optional(),
        notes: z.string().trim().max(250).optional(),
      })
    )
    .min(1),
});

// Purchasing
export const vendorSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1, "Vendor name is required").max(160),
  email: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(60).optional().default(""),
  company: z.string().trim().max(160).optional().default(""),
  address: z.string().trim().max(300).optional().default(""),
  taxNumber: z.string().trim().max(80).optional().default(""),
  currency: z.string().trim().max(10).optional().default("USD"),
  paymentTermsDays: z.number().int().min(0).max(365).optional().default(30),
  notes: z.string().trim().max(500).optional().default(""),
});

export const poLineSchema = z.object({
  productId: z.string().uuid(),
  description: z.string().trim().max(250).optional().default(""),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  taxRate: z.number().min(0).max(100).optional().default(0),
});

export const poSchema = z.object({
  vendorId: z.string().uuid(),
  branchId: z.string().uuid(),
  status: z.enum(["Draft", "Issued"]).optional().default("Draft"),
  orderDate: z.string().optional(),
  expectedDate: z.string().nullable().optional(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z.array(poLineSchema).min(1),
});

export const receiveSchema = z.object({
  poId: z.string().uuid().nullable().optional(),
  vendorId: z.string().uuid(),
  branchId: z.string().uuid(),
  receiveDate: z.string().optional(),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        poLineId: z.string().uuid().nullable().optional(),
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        unitCost: z.number().min(0),
        lotNumber: z.string().trim().min(1).max(80).optional(),
        manufactureDate: z.string().nullable().optional(),
        expiryDate: z.string().nullable().optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .min(1),
});

export const billSchema = z.object({
  vendorId: z.string().uuid(),
  branchId: z.string().uuid(),
  poId: z.string().uuid().nullable().optional(),
  receiveId: z.string().uuid().nullable().optional(),
  billDate: z.string().optional(),
  dueDate: z.string(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid().nullable().optional(),
        description: z.string().trim().max(250).optional().default(""),
        quantity: z.number().positive(),
        unitCost: z.number().min(0),
        taxRate: z.number().min(0).max(100).optional().default(0),
      })
    )
    .min(1),
});

export const paymentMadeSchema = z.object({
  vendorId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  paymentDate: z.string().optional(),
  amount: z.number().positive(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  paymentMethod: z.string().trim().min(1).max(60).optional().default("bank"),
  reference: z.string().trim().max(120).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
  allocations: z
    .array(
      z.object({
        billId: z.string().uuid(),
        amount: z.number().positive(),
      })
    )
    .default([]),
});

export const purchaseReturnSchema = z.object({
  vendorId: z.string().uuid(),
  branchId: z.string().uuid(),
  receiveId: z.string().uuid().nullable().optional(),
  billId: z.string().uuid().nullable().optional(),
  returnDate: z.string().optional(),
  reason: z.string().trim().max(120).optional().default("other"),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        unitCost: z.number().min(0),
        taxRate: z.number().min(0).max(100).optional().default(0),
      })
    )
    .min(1),
});

// Sales
export const customerSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1, "Customer name is required").max(160),
  email: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(60).optional().default(""),
  company: z.string().trim().max(160).optional().default(""),
  billingAddress: z.string().trim().max(300).optional().default(""),
  shippingAddress: z.string().trim().max(300).optional().default(""),
  taxNumber: z.string().trim().max(80).optional().default(""),
  etaReceiverType: z.enum(ETA_RECEIVER_TYPES).optional(),
  currency: z.string().trim().max(10).optional().default("USD"),
  paymentTermsDays: z.number().int().min(0).max(365).optional().default(30),
  creditLimit: z.number().min(0).nullable().optional().default(null),
  notes: z.string().trim().max(500).optional().default(""),
});

export const salesOrderSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid(),
  status: z.enum(["Draft", "Confirmed"]).optional().default("Draft"),
  orderDate: z.string().optional(),
  expectedShipmentDate: z.string().nullable().optional(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        description: z.string().trim().max(250).optional().default(""),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
        discount: z.number().min(0).optional().default(0),
        taxRate: z.number().min(0).max(100).optional().default(0),
      })
    )
    .min(1),
});

export const invoiceSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid(),
  soId: z.string().uuid().nullable().optional(),
  status: z.enum(["Draft", "Sent"]).optional().default("Sent"),
  invoiceDate: z.string().optional(),
  dueDate: z.string(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid().nullable().optional(),
        description: z.string().trim().max(250).optional().default(""),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
        discount: z.number().min(0).optional().default(0),
        taxRate: z.number().min(0).max(100).optional().default(0),
        lotAllocations: z.array(lotAllocationInputSchema).optional(),
        serialNumbers: z.array(z.string().trim().min(1).max(100)).optional(),
      })
    )
    .min(1),
});

export const receivedPaymentSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  paymentDate: z.string().optional(),
  amount: z.number().positive(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  paymentMethod: z.string().trim().min(1).max(60).optional().default("bank"),
  reference: z.string().trim().max(120).optional().default(""),
  notes: z.string().trim().max(500).optional().default(""),
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().uuid(),
        amount: z.number().positive(),
      })
    )
    .default([]),
});

export const salesReturnSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid(),
  invoiceId: z.string().uuid().nullable().optional(),
  returnDate: z.string().optional(),
  reason: z.string().trim().max(120).optional().default("other"),
  restockItems: z.boolean().optional().default(true),
  notes: z.string().trim().max(500).optional().default(""),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
        taxRate: z.number().min(0).max(100).optional().default(0),
      })
    )
    .min(1),
});

export const applyAmountSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.number().positive(),
});

export const retainerSchema = z.object({
  customerId: z.string().uuid(),
  branchId: z.string().uuid().nullable().optional(),
  status: z.enum(["Draft", "Sent", "Paid"]).optional().default("Sent"),
  issueDate: z.string().optional(),
  currency: z.string().trim().max(10).optional().default("USD"),
  fxRate: z.number().positive().optional().default(1),
  amount: z.number().positive(),
  notes: z.string().trim().max(500).optional().default(""),
});

export const fulfillSalesOrderSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().positive() })).min(1),
});

// R6 Back-Office List / Pagination Query Schemas
export const productsListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["name", "sku", "sellingPrice", "costPrice", "createdAt"]).optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  isActive: z.enum(["true", "false"]).optional(),
});
export type ProductsListQuery = z.infer<typeof productsListQuerySchema>;

export const customersListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["name", "code", "createdAt"]).optional(),
});
export type CustomersListQuery = z.infer<typeof customersListQuerySchema>;

export const vendorsListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["name", "code", "createdAt"]).optional(),
});
export type VendorsListQuery = z.infer<typeof vendorsListQuerySchema>;

export const salesOrdersListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["orderDate", "soNumber", "totalAmount", "createdAt"]).optional(),
  customerId: optionalUuidQuery,
});
export type SalesOrdersListQuery = z.infer<typeof salesOrdersListQuerySchema>;

export const purchaseOrdersListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["orderDate", "poNumber", "totalAmount", "createdAt"]).optional(),
  vendorId: optionalUuidQuery,
});
export type PurchaseOrdersListQuery = z.infer<typeof purchaseOrdersListQuerySchema>;

export const vendorBillsListQuerySchema = offsetPageQuerySchema.extend({
  sortBy: z.enum(["billDate", "dueDate", "billNumber", "totalAmount", "createdAt"]).optional(),
  vendorId: optionalUuidQuery,
});
export type VendorBillsListQuery = z.infer<typeof vendorBillsListQuerySchema>;
