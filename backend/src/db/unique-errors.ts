import { AppError } from "../db/helpers.ts";

export interface UniqueConstraintDescriptor {
  code: string;
  field: string;
  messageEn: string;
  messageAr: string;
}

const UNIQUE_CONSTRAINT_MAP: Record<string, UniqueConstraintDescriptor> = {
  branches_company_code_uq: {
    code: "DUPLICATE_BRANCH_CODE",
    field: "code",
    messageEn: "A branch with this code already exists in your company.",
    messageAr: "يوجد فرع بنفس الكود بالفعل في شركتك.",
  },
  branches_company_code_norm_uq: {
    code: "DUPLICATE_BRANCH_CODE",
    field: "code",
    messageEn: "A branch with this code already exists in your company.",
    messageAr: "يوجد فرع بنفس الكود بالفعل في شركتك.",
  },
  branches_company_name_norm_uq: {
    code: "DUPLICATE_BRANCH_NAME",
    field: "name",
    messageEn: "A branch with this name already exists in your company.",
    messageAr: "يوجد فرع بنفس الاسم بالفعل في شركتك.",
  },
  products_company_sku_uq: {
    code: "DUPLICATE_PRODUCT_SKU",
    field: "sku",
    messageEn: "A product with this SKU already exists in your company.",
    messageAr: "يوجد منتج بنفس رمز الصنف (SKU) بالفعل في شركتك.",
  },
  products_company_sku_norm_uq: {
    code: "DUPLICATE_PRODUCT_SKU",
    field: "sku",
    messageEn: "A product with this SKU already exists in your company.",
    messageAr: "يوجد منتج بنفس رمز الصنف (SKU) بالفعل في شركتك.",
  },
  products_company_barcode_norm_uq: {
    code: "DUPLICATE_PRODUCT_BARCODE",
    field: "barcode",
    messageEn: "A product with this barcode already exists in your company.",
    messageAr: "يوجد منتج بنفس الباركود بالفعل في شركتك.",
  },
  customers_company_code_uq: {
    code: "DUPLICATE_CUSTOMER_CODE",
    field: "code",
    messageEn: "A customer with this code already exists in your company.",
    messageAr: "يوجد عميل بنفس الكود بالفعل في شركتك.",
  },
  customers_company_code_norm_uq: {
    code: "DUPLICATE_CUSTOMER_CODE",
    field: "code",
    messageEn: "A customer with this code already exists in your company.",
    messageAr: "يوجد عميل بنفس الكود بالفعل في شركتك.",
  },
  vendors_company_code_uq: {
    code: "DUPLICATE_VENDOR_CODE",
    field: "code",
    messageEn: "A vendor with this code already exists in your company.",
    messageAr: "يوجد مورد بنفس الكود بالفعل في شركتك.",
  },
  vendors_company_code_norm_uq: {
    code: "DUPLICATE_VENDOR_CODE",
    field: "code",
    messageEn: "A vendor with this code already exists in your company.",
    messageAr: "يوجد مورد بنفس الكود بالفعل في شركتك.",
  },
  coa_company_code_uq: {
    code: "DUPLICATE_ACCOUNT_CODE",
    field: "code",
    messageEn: "An account with this code already exists in your chart of accounts.",
    messageAr: "يوجد حساب بنفس الكود بالفعل في دليل الحسابات.",
  },
  coa_company_code_norm_uq: {
    code: "DUPLICATE_ACCOUNT_CODE",
    field: "code",
    messageEn: "An account with this code already exists in your chart of accounts.",
    messageAr: "يوجد حساب بنفس الكود بالفعل في دليل الحسابات.",
  },
  cost_centers_company_code_uq: {
    code: "DUPLICATE_COST_CENTER_CODE",
    field: "code",
    messageEn: "A cost center with this code already exists in your company.",
    messageAr: "يوجد مركز تكلفة بنفس الكود بالفعل في شركتك.",
  },
  cost_centers_company_code_norm_uq: {
    code: "DUPLICATE_COST_CENTER_CODE",
    field: "code",
    messageEn: "A cost center with this code already exists in your company.",
    messageAr: "يوجد مركز تكلفة بنفس الكود بالفعل في شركتك.",
  },
  cost_centers_company_name_norm_uq: {
    code: "DUPLICATE_COST_CENTER_NAME",
    field: "name",
    messageEn: "A cost center with this name already exists in your company.",
    messageAr: "يوجد مركز تكلفة بنفس الاسم بالفعل في شركتك.",
  },
  tax_codes_company_code_uq: {
    code: "DUPLICATE_TAX_CODE",
    field: "code",
    messageEn: "A tax code with this code already exists in your company.",
    messageAr: "يوجد كود ضريبة بنفس الرمز بالفعل في شركتك.",
  },
  tax_codes_company_code_norm_uq: {
    code: "DUPLICATE_TAX_CODE",
    field: "code",
    messageEn: "A tax code with this code already exists in your company.",
    messageAr: "يوجد كود ضريبة بنفس الرمز بالفعل في شركتك.",
  },
  treasury_accounts_company_code_uq: {
    code: "DUPLICATE_TREASURY_CODE",
    field: "code",
    messageEn: "A treasury account with this code already exists in your company.",
    messageAr: "يوجد حساب خزينة أو بنك بنفس الكود بالفعل في شركتك.",
  },
  treasury_accounts_company_code_norm_uq: {
    code: "DUPLICATE_TREASURY_CODE",
    field: "code",
    messageEn: "A treasury account with this code already exists in your company.",
    messageAr: "يوجد حساب خزينة أو بنك بنفس الكود بالفعل في شركتك.",
  },
  treasury_accounts_company_name_norm_uq: {
    code: "DUPLICATE_TREASURY_NAME",
    field: "name",
    messageEn: "A treasury account with this name already exists in your company.",
    messageAr: "يوجد حساب خزينة أو بنك بنفس الاسم بالفعل في شركتك.",
  },
  treasury_accounts_company_iban_norm_uq: {
    code: "DUPLICATE_TREASURY_IBAN",
    field: "iban",
    messageEn: "A treasury account with this IBAN already exists in your company.",
    messageAr: "يوجد حساب بنكي بنفس رقم الآيبان (IBAN) بالفعل في شركتك.",
  },
  treasury_accounts_company_gl_uq: {
    code: "DUPLICATE_TREASURY_GL_ACCOUNT",
    field: "glAccountId",
    messageEn: "This GL account is already linked to another treasury account.",
    messageAr: "هذا الحساب المحاسبي مرتبط بالفعل بحساب خزينة أو بنك آخر.",
  },
  fixed_assets_company_code_uq: {
    code: "DUPLICATE_ASSET_CODE",
    field: "assetCode",
    messageEn: "A fixed asset with this asset code already exists in your company.",
    messageAr: "يوجد أصل ثابت بنفس الكود بالفعل في شركتك.",
  },
  fixed_assets_company_code_norm_uq: {
    code: "DUPLICATE_ASSET_CODE",
    field: "assetCode",
    messageEn: "A fixed asset with this asset code already exists in your company.",
    messageAr: "يوجد أصل ثابت بنفس الكود بالفعل في شركتك.",
  },
  fixed_assets_company_serial_norm_uq: {
    code: "DUPLICATE_ASSET_SERIAL",
    field: "serialNumber",
    messageEn: "A fixed asset with this serial number already exists in your company.",
    messageAr: "يوجد أصل ثابت بنفس الرقم التسلسلي بالفعل في شركتك.",
  },
  pos_terminals_company_code_uq: {
    code: "DUPLICATE_TERMINAL_CODE",
    field: "code",
    messageEn: "A POS terminal with this code already exists in your company.",
    messageAr: "توجد نقطة بيع بنفس الكود بالفعل في شركتك.",
  },
  pos_terminals_company_code_norm_uq: {
    code: "DUPLICATE_TERMINAL_CODE",
    field: "code",
    messageEn: "A POS terminal with this code already exists in your company.",
    messageAr: "توجد نقطة بيع بنفس الكود بالفعل في شركتك.",
  },
  pos_terminals_company_name_norm_uq: {
    code: "DUPLICATE_TERMINAL_NAME",
    field: "name",
    messageEn: "A POS terminal with this name already exists in your company.",
    messageAr: "توجد نقطة بيع بنفس الاسم بالفعل في شركتك.",
  },
  taxonomy_company_kind_name_uq: {
    code: "DUPLICATE_TAXONOMY_NAME",
    field: "name",
    messageEn: "An item with this name already exists in this category.",
    messageAr: "يوجد عنصر بنفس الاسم بالفعل في هذا التصنيف.",
  },
  taxonomy_company_kind_name_norm_uq: {
    code: "DUPLICATE_TAXONOMY_NAME",
    field: "name",
    messageEn: "An item with this name already exists in this category.",
    messageAr: "يوجد عنصر بنفس الاسم بالفعل في هذا التصنيف.",
  },
  custom_roles_company_name_uq: {
    code: "DUPLICATE_ROLE_NAME",
    field: "name",
    messageEn: "A role with this name already exists in your company.",
    messageAr: "يوجد دور صلاحيات بنفس الاسم بالفعل في شركتك.",
  },
  custom_roles_company_name_norm_uq: {
    code: "DUPLICATE_ROLE_NAME",
    field: "name",
    messageEn: "A role with this name already exists in your company.",
    messageAr: "يوجد دور صلاحيات بنفس الاسم بالفعل في شركتك.",
  },
  users_email_unique: {
    code: "EMAIL_EXISTS",
    field: "email",
    messageEn: "A user with this email already exists.",
    messageAr: "يوجد مستخدم بنفس البريد الإلكتروني بالفعل.",
  },
  companies_code_unique: {
    code: "DUPLICATE_COMPANY_CODE",
    field: "code",
    messageEn: "A company with this code already exists.",
    messageAr: "توجد شركة بنفس الكود بالفعل.",
  },
};

function extractPgUniqueMeta(err: unknown): { pgCode: string | null; constraintName: string | null } {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor && typeof cursor === "object"; depth++) {
    const obj = cursor as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (obj.code === "23505") {
      const constraintName =
        typeof obj.constraint_name === "string"
          ? obj.constraint_name
          : typeof obj.constraint === "string"
            ? obj.constraint
            : null;
      return { pgCode: "23505", constraintName };
    }
    cursor = obj.cause;
  }
  return { pgCode: null, constraintName: null };
}

export function mapPgUniqueViolationToAppError(err: unknown): AppError | null {
  const { pgCode, constraintName } = extractPgUniqueMeta(err);
  if (pgCode !== "23505") return null;

  const descriptor = constraintName ? UNIQUE_CONSTRAINT_MAP[constraintName] : undefined;
  if (descriptor) {
    return new AppError(409, descriptor.messageEn, descriptor.code, {
      field: descriptor.field,
      constraint: constraintName,
      messageEn: descriptor.messageEn,
      messageAr: descriptor.messageAr,
    });
  }

  return new AppError(409, "A record with the same unique identifier already exists.", "DUPLICATE_RECORD", {
    constraint: constraintName,
    messageEn: "A record with the same unique identifier already exists.",
    messageAr: "يوجد سجل بنفس المعرّف الفريد بالفعل.",
  });
}
