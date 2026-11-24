import {
  createPrintTemplateSchema,
  emailDocumentParamsSchema,
  emailDocumentSchema,
  PRINT_TEMPLATE_DOC_TYPES,
  updatePrintTemplateSchema,
  type AttachmentEntityType,
  type EmailDocumentResponseDto,
  type EmailableDocumentType,
  type PermissionModule,
  type PrintTemplateConfig,
  type PrintTemplateDocType,
  type PrintTemplateDto,
} from "@erp/shared";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  companies,
  journalEntries,
  printTemplates,
  purchaseOrders,
  salesInvoices,
  salesOrders,
  vendorBills,
} from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, num, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { loadAttachmentBuffersForEmail } from "./attachments.service.ts";
import { sendEmail } from "./email.service.ts";
import { actorCompanyId, parseOrThrow } from "./stock-locks.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_TYPE_SET = new Set<string>(PRINT_TEMPLATE_DOC_TYPES);

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_TEMPLATE_TAGS = new Set([
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "small",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "img",
]);

const VOID_TEMPLATE_TAGS = new Set(["br", "hr", "img"]);

const ALLOWED_TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align"]),
  table: new Set(["width", "align"]),
  div: new Set(["align"]),
  p: new Set(["align"]),
  h1: new Set(["align"]),
  h2: new Set(["align"]),
  h3: new Set(["align"]),
  h4: new Set(["align"]),
};

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_IMG_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_ALIGN_VALUES = new Set(["left", "center", "right", "justify"]);

function decodeHtmlEntitiesForSchemeCheck(raw: string): string {
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");
  // Strip ASCII control characters and whitespace that browsers ignore inside URL schemes
  return Array.from(decoded)
    .filter((ch) => ch.charCodeAt(0) > 32)
    .join("");
}

function isSafeUrl(rawUrl: string, allowedProtocols: ReadonlySet<string>): boolean {
  const normalized = decodeHtmlEntitiesForSchemeCheck(rawUrl.trim());
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return allowedProtocols.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

function sanitizeTagAttributes(tagName: string, rawAttrs: string): string {
  const allowed = ALLOWED_TAG_ATTRS[tagName];
  if (!allowed || !rawAttrs.trim()) return "";

  const sanitizedParts: string[] = [];
  const attrRegex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    const attrName = match[1]!.toLowerCase();
    // Explicitly block all event handlers and disallowed attributes
    if (attrName.startsWith("on") || !allowed.has(attrName)) {
      continue;
    }
    const rawVal = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!rawVal) continue;

    if (attrName === "href") {
      if (!isSafeUrl(rawVal, SAFE_URL_PROTOCOLS)) continue;
      sanitizedParts.push(`href="${escapeHtml(rawVal)}"`);
      continue;
    }
    if (attrName === "src") {
      if (!isSafeUrl(rawVal, SAFE_IMG_PROTOCOLS)) continue;
      sanitizedParts.push(`src="${escapeHtml(rawVal)}"`);
      continue;
    }
    if (attrName === "align") {
      const lowerVal = rawVal.toLowerCase();
      if (!SAFE_ALIGN_VALUES.has(lowerVal)) continue;
      sanitizedParts.push(`align="${lowerVal}"`);
      continue;
    }
    if (attrName === "width" || attrName === "height") {
      if (!/^\d{1,4}(?:px|%)?$/i.test(rawVal)) continue;
      sanitizedParts.push(`${attrName}="${escapeHtml(rawVal)}"`);
      continue;
    }
    if (attrName === "colspan" || attrName === "rowspan") {
      if (!/^\d{1,2}$/.test(rawVal)) continue;
      sanitizedParts.push(`${attrName}="${rawVal}"`);
      continue;
    }
    sanitizedParts.push(`${attrName}="${escapeHtml(rawVal)}"`);
  }

  return sanitizedParts.length > 0 ? ` ${sanitizedParts.join(" ")}` : "";
}

/**
 * Sanitizes print template header/footer HTML for safe inclusion in outbound emails.
 * Strips dangerous elements (with contents), all event handlers, javascript:/data: URLs,
 * and any tags/attributes outside the strict allow-list.
 */
export function sanitizeTemplateHtml(rawHtml: string): string {
  if (!rawHtml) return "";

  // 1. Remove HTML comments and dangerous elements along with their inner contents
  let cleaned = rawHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\s*(script|style|iframe|object|embed|svg|math|form|noscript|template|textarea|select|button|input|meta|link|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      ""
    )
    .replace(
      /<\s*(script|style|iframe|object|embed|svg|math|form|noscript|template|textarea|select|button|input|meta|link|base)\b[^>]*\/?>/gi,
      ""
    );

  // 2. Filter remaining tags against the allow-list and sanitize attributes
  cleaned = cleaned.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g, (_full, slash: string, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!SAFE_TEMPLATE_TAGS.has(tag)) {
      return "";
    }
    if (slash === "/") {
      return VOID_TEMPLATE_TAGS.has(tag) ? "" : `</${tag}>`;
    }
    const safeAttrs = sanitizeTagAttributes(tag, rawAttrs);
    return VOID_TEMPLATE_TAGS.has(tag) ? `<${tag}${safeAttrs} />` : `<${tag}${safeAttrs}>`;
  });

  return cleaned.trim();
}

function toPrintTemplateDto(row: typeof printTemplates.$inferSelect): PrintTemplateDto {
  const rawCfg = (row.configJson ?? {}) as Partial<PrintTemplateConfig>;
  return {
    id: row.id,
    companyId: row.companyId,
    documentType: row.documentType as PrintTemplateDocType,
    name: row.name,
    headerHtml: row.headerHtml,
    footerHtml: row.footerHtml,
    logoUrl: row.logoUrl,
    accentColor: row.accentColor,
    customCss: row.customCss,
    configJson: {
      showLogo: rawCfg.showLogo ?? true,
      showTaxNumber: rawCfg.showTaxNumber ?? true,
      showQrCode: rawCfg.showQrCode ?? true,
      paperSize: rawCfg.paperSize ?? "A4",
      fontFamily: rawCfg.fontFamily ?? "Inter",
    },
    isDefault: row.isDefault,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPrintTemplates(
  db: AppDatabase,
  actor: AuthUser,
  rawQuery?: { documentType?: string }
): Promise<PrintTemplateDto[]> {
  const companyId = actorCompanyId(actor);
  const conds = [eq(printTemplates.companyId, companyId)];
  if (rawQuery?.documentType) {
    if (!DOC_TYPE_SET.has(rawQuery.documentType)) {
      throw new AppError(400, "Invalid print template documentType", "VALIDATION_ERROR");
    }
    conds.push(eq(printTemplates.documentType, rawQuery.documentType));
  }

  const rows = await db
    .select()
    .from(printTemplates)
    .where(and(...conds))
    .orderBy(asc(printTemplates.documentType), desc(printTemplates.isDefault), asc(printTemplates.name));

  return rows.map(toPrintTemplateDto);
}

export async function createPrintTemplate(
  db: AppDatabase,
  actor: AuthUser,
  rawBody: unknown,
  ipAddress?: string
): Promise<PrintTemplateDto> {
  const data = parseOrThrow(createPrintTemplateSchema, rawBody, "Invalid print template payload");
  const companyId = actorCompanyId(actor);

  const created = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: printTemplates.id })
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.companyId, companyId),
          eq(printTemplates.documentType, data.documentType),
          eq(printTemplates.name, data.name)
        )
      )
      .limit(1);
    if (dup) {
      throw new AppError(409, `Print template '${data.name}' already exists for ${data.documentType}`, "DUPLICATE_TEMPLATE");
    }

    if (data.isDefault) {
      await tx
        .update(printTemplates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(printTemplates.companyId, companyId),
            eq(printTemplates.documentType, data.documentType),
            eq(printTemplates.isDefault, true)
          )
        );
    }

    const [row] = await tx
      .insert(printTemplates)
      .values({
        companyId,
        documentType: data.documentType,
        name: data.name,
        headerHtml: data.headerHtml,
        footerHtml: data.footerHtml,
        logoUrl: data.logoUrl,
        accentColor: data.accentColor,
        customCss: data.customCss,
        configJson: data.configJson as Record<string, unknown>,
        isDefault: data.isDefault,
        isActive: data.isActive,
      })
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "print_template.created",
      entityType: "settings",
      entityId: row.id,
      entityLabel: `${row.documentType}: ${row.name}`,
      after: {
        id: row.id,
        documentType: row.documentType,
        name: row.name,
        accentColor: row.accentColor,
        isDefault: row.isDefault,
        isActive: row.isActive,
      },
      ipAddress,
    });

    return row;
  });

  return toPrintTemplateDto(created);
}

export async function updatePrintTemplate(
  db: AppDatabase,
  actor: AuthUser,
  templateId: string,
  rawBody: unknown,
  ipAddress?: string
): Promise<PrintTemplateDto> {
  if (!UUID_RE.test(templateId)) {
    throw new AppError(400, "Invalid print template ID", "VALIDATION_ERROR");
  }
  const data = parseOrThrow(updatePrintTemplateSchema, rawBody, "Invalid print template update");
  const companyId = actorCompanyId(actor);

  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(printTemplates)
      .where(and(eq(printTemplates.id, templateId), eq(printTemplates.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "Print template not found", "NOT_FOUND");
    }

    if (data.name && data.name !== existing.name) {
      const [dup] = await tx
        .select({ id: printTemplates.id })
        .from(printTemplates)
        .where(
          and(
            eq(printTemplates.companyId, companyId),
            eq(printTemplates.documentType, existing.documentType),
            eq(printTemplates.name, data.name),
            ne(printTemplates.id, templateId)
          )
        )
        .limit(1);
      if (dup) {
        throw new AppError(409, `Print template '${data.name}' already exists`, "DUPLICATE_TEMPLATE");
      }
    }

    if (data.isDefault === true) {
      await tx
        .update(printTemplates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(printTemplates.companyId, companyId),
            eq(printTemplates.documentType, existing.documentType),
            eq(printTemplates.isDefault, true),
            ne(printTemplates.id, templateId)
          )
        );
    }

    const [row] = await tx
      .update(printTemplates)
      .set({
        name: data.name ?? existing.name,
        headerHtml: data.headerHtml ?? existing.headerHtml,
        footerHtml: data.footerHtml ?? existing.footerHtml,
        logoUrl: data.logoUrl ?? existing.logoUrl,
        accentColor: data.accentColor ?? existing.accentColor,
        customCss: data.customCss ?? existing.customCss,
        configJson: (data.configJson ?? existing.configJson) as Record<string, unknown>,
        isDefault: data.isDefault ?? existing.isDefault,
        isActive: data.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(printTemplates.id, templateId))
      .returning();

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "print_template.updated",
      entityType: "settings",
      entityId: row.id,
      entityLabel: `${row.documentType}: ${row.name}`,
      before: {
        name: existing.name,
        headerHtml: existing.headerHtml,
        footerHtml: existing.footerHtml,
        accentColor: existing.accentColor,
        isDefault: existing.isDefault,
        isActive: existing.isActive,
      },
      after: {
        name: row.name,
        headerHtml: row.headerHtml,
        footerHtml: row.footerHtml,
        accentColor: row.accentColor,
        isDefault: row.isDefault,
        isActive: row.isActive,
      },
      ipAddress,
    });

    return row;
  });

  return toPrintTemplateDto(updated);
}

export async function deletePrintTemplate(
  db: AppDatabase,
  actor: AuthUser,
  templateId: string,
  ipAddress?: string
): Promise<void> {
  if (!UUID_RE.test(templateId)) {
    throw new AppError(400, "Invalid print template ID", "VALIDATION_ERROR");
  }
  const companyId = actorCompanyId(actor);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(printTemplates)
      .where(and(eq(printTemplates.id, templateId), eq(printTemplates.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, "Print template not found", "NOT_FOUND");
    }

    await tx
      .delete(printTemplates)
      .where(and(eq(printTemplates.id, templateId), eq(printTemplates.companyId, companyId)));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "print_template.deleted",
      entityType: "settings",
      entityId: existing.id,
      entityLabel: `${existing.documentType}: ${existing.name}`,
      before: {
        id: existing.id,
        documentType: existing.documentType,
        name: existing.name,
      },
      ipAddress,
    });
  });
}

function assertEmailDocumentPermission(actor: AuthUser, docType: EmailableDocumentType): void {
  if (actor.role === "admin") return;
  const requiredModules: PermissionModule[] =
    docType === "invoice" || docType === "sales_order"
      ? ["sales"]
      : docType === "receipt"
        ? ["pos", "sales"]
        : docType === "purchase_order" || docType === "vendor_bill"
          ? ["purchases"]
          : ["accounting"];

  const allowed = requiredModules.some((mod) => Boolean(actor.permissions[mod]?.view));
  if (!allowed) {
    throw new AppError(403, `Forbidden: insufficient permissions to email ${docType}`, "FORBIDDEN");
  }
}

interface LoadedDocumentSummary {
  docNumber: string;
  branchId: string | null;
  status: string;
  currency: string;
  total: number | null;
  dateIso: string;
  attachmentEntityTypes: AttachmentEntityType[];
}

async function loadDocumentForEmail(
  db: AppDatabase,
  actor: AuthUser,
  companyId: string,
  docType: EmailableDocumentType,
  docId: string
): Promise<LoadedDocumentSummary> {
  switch (docType) {
    case "invoice":
    case "receipt": {
      const [row] = await db
        .select()
        .from(salesInvoices)
        .where(and(eq(salesInvoices.id, docId), eq(salesInvoices.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Invoice/receipt not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return {
        docNumber: row.invoiceNumber,
        branchId: row.branchId,
        status: row.status,
        currency: row.currency,
        total: num(row.totalAmount),
        dateIso: row.invoiceDate.toISOString().slice(0, 10),
        attachmentEntityTypes: ["invoice", "sales_invoice"],
      };
    }
    case "sales_order": {
      const [row] = await db
        .select()
        .from(salesOrders)
        .where(and(eq(salesOrders.id, docId), eq(salesOrders.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Sales order not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return {
        docNumber: row.soNumber,
        branchId: row.branchId,
        status: row.status,
        currency: row.currency,
        total: num(row.totalAmount),
        dateIso: row.orderDate.toISOString().slice(0, 10),
        attachmentEntityTypes: ["sales_order"],
      };
    }
    case "purchase_order": {
      const [row] = await db
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, docId), eq(purchaseOrders.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Purchase order not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return {
        docNumber: row.poNumber,
        branchId: row.branchId,
        status: row.status,
        currency: row.currency,
        total: num(row.totalAmount),
        dateIso: row.orderDate.toISOString().slice(0, 10),
        attachmentEntityTypes: ["purchase_order"],
      };
    }
    case "vendor_bill": {
      const [row] = await db
        .select()
        .from(vendorBills)
        .where(and(eq(vendorBills.id, docId), eq(vendorBills.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Vendor bill not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return {
        docNumber: row.billNumber,
        branchId: row.branchId,
        status: row.status,
        currency: row.currency,
        total: num(row.totalAmount),
        dateIso: row.billDate.toISOString().slice(0, 10),
        attachmentEntityTypes: ["vendor_bill"],
      };
    }
    case "journal_entry": {
      const [row] = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.id, docId), eq(journalEntries.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Journal entry not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return {
        docNumber: row.entryNumber,
        branchId: row.branchId,
        status: row.status,
        currency: "",
        total: null,
        dateIso: row.entryDate.toISOString().slice(0, 10),
        attachmentEntityTypes: ["journal_entry"],
      };
    }
  }
}

export async function emailDocument(
  db: AppDatabase,
  actor: AuthUser,
  rawParams: unknown,
  rawBody: unknown,
  ipAddress?: string
): Promise<EmailDocumentResponseDto & { ok: true }> {
  const { type, id } = parseOrThrow(emailDocumentParamsSchema, rawParams, "Invalid document type or ID");
  const body = parseOrThrow(emailDocumentSchema, rawBody, "Invalid email payload");
  assertEmailDocumentPermission(actor, type);

  const companyId = actorCompanyId(actor);
  const doc = await loadDocumentForEmail(db, actor, companyId, type, id);

  // Resolve print template (explicit templateId or company default)
  let template: typeof printTemplates.$inferSelect | null = null;
  if (body.templateId) {
    const [found] = await db
      .select()
      .from(printTemplates)
      .where(and(eq(printTemplates.id, body.templateId), eq(printTemplates.companyId, companyId)))
      .limit(1);
    if (!found) {
      throw new AppError(404, "Print template not found in active company", "NOT_FOUND");
    }
    template = found;
  } else {
    const [defTpl] = await db
      .select()
      .from(printTemplates)
      .where(
        and(
          eq(printTemplates.companyId, companyId),
          eq(printTemplates.documentType, type),
          eq(printTemplates.isDefault, true),
          eq(printTemplates.isActive, true)
        )
      )
      .limit(1);
    template = defTpl ?? null;
  }

  const [companyRow] = await db
    .select({ name: companies.name, legalName: companies.legalName, taxRegistrationNumber: companies.taxRegistrationNumber })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const attachments = await loadAttachmentBuffersForEmail(db, companyId, doc.attachmentEntityTypes, id, {
    attachStoredFiles: body.attachStoredFiles,
    attachmentIds: body.attachmentIds,
  });

  const toList = Array.isArray(body.to) ? body.to : [body.to];
  const ccList = body.cc ?? [];
  const allRecipients = Array.from(new Set([...toList, ...ccList]));

  const accent = template?.accentColor ?? "#0f172a";
  const companyDisplay = companyRow?.legalName || companyRow?.name || "ERP";
  const totalLine = doc.total !== null ? `${doc.currency} ${doc.total.toFixed(2)}` : "";

  const textLines = [
    `${companyDisplay}`,
    `Document: ${type.replace(/_/g, " ").toUpperCase()} ${doc.docNumber}`,
    `Date: ${doc.dateIso}`,
    `Status: ${doc.status}`,
    ...(totalLine ? [`Total: ${totalLine}`] : []),
    ...(body.message ? ["", body.message] : []),
  ];

  const sanitizedHeaderHtml = template?.headerHtml ? sanitizeTemplateHtml(template.headerHtml) : "";
  const sanitizedFooterHtml = template?.footerHtml ? sanitizeTemplateHtml(template.footerHtml) : "";

  const html = `<!doctype html>
<html>
<body style="font-family: Inter, Arial, sans-serif; color: #0f172a; margin: 0; padding: 24px;">
  <div style="max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-top: 4px solid ${escapeHtml(accent)}; border-radius: 6px; padding: 20px;">
    ${sanitizedHeaderHtml ? `<div>${sanitizedHeaderHtml}</div>` : `<h2 style="margin:0 0 8px;color:${escapeHtml(accent)};">${escapeHtml(companyDisplay)}</h2>`}
    <p style="margin: 12px 0;"><strong>${escapeHtml(type.replace(/_/g, " ").toUpperCase())} ${escapeHtml(doc.docNumber)}</strong></p>
    <p style="margin: 4px 0; font-size: 14px; color: #475569;">Date: ${escapeHtml(doc.dateIso)} · Status: ${escapeHtml(doc.status)}${totalLine ? ` · Total: ${escapeHtml(totalLine)}` : ""}</p>
    ${body.message ? `<div style="margin-top: 16px; white-space: pre-wrap;">${escapeHtml(body.message)}</div>` : ""}
    ${sanitizedFooterHtml ? `<div style="margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 12px;">${sanitizedFooterHtml}</div>` : ""}
  </div>
</body>
</html>`;

  const emailResult = await sendEmail({
    to: toList,
    cc: ccList,
    subject: body.subject,
    text: textLines.join("\n"),
    html,
    attachments,
  });

  await writeAuditLog(db, {
    companyId,
    userId: actor.id,
    userName: actor.name,
    userRole: actor.role,
    branchId: doc.branchId,
    action: "document.emailed",
    entityType: type,
    entityId: id,
    entityLabel: doc.docNumber,
    details: {
      recipients: allRecipients,
      subject: body.subject,
      attachmentCount: attachments.length,
      templateId: template?.id ?? null,
      sent: emailResult.sent,
      skippedReason: emailResult.skippedReason ?? null,
    },
    ipAddress,
  });

  return {
    ok: true,
    sent: emailResult.sent,
    recipients: allRecipients,
    subject: body.subject,
    attachmentCount: attachments.length,
    ...(emailResult.messageId ? { messageId: emailResult.messageId } : {}),
  };
}
