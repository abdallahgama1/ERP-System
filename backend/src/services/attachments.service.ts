import path from "node:path";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentListQuerySchema,
  type AttachmentAllowedMimeType,
  type AttachmentEntityType,
  type DocumentAttachmentDto,
  type PermissionModule,
} from "@erp/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  customers,
  documentAttachments,
  journalEntries,
  products,
  purchaseOrders,
  salesInvoices,
  salesOrders,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { assertBranchAccess } from "../middleware/auth.ts";
import { actorCompanyId, parseOrThrow } from "./stock-locks.ts";
import {
  buildStorageKey,
  deleteStorageObject,
  getStorageObject,
  putStorageObject,
  sanitizeFileName,
} from "./storage.service.ts";
import { scanAttachmentBuffer } from "./virus-scan.service.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_MIME_SET = new Set<string>(ATTACHMENT_ALLOWED_MIME_TYPES);

const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".sh",
  ".bat",
  ".cmd",
  ".msi",
  ".dll",
  ".com",
  ".scr",
  ".pif",
  ".html",
  ".htm",
  ".svg",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".php",
  ".jsp",
  ".asp",
  ".aspx",
  ".ps1",
  ".vbs",
  ".jar",
]);

export function resolveAttachmentPermissionModule(entityType: AttachmentEntityType): PermissionModule {
  switch (entityType) {
    case "invoice":
    case "sales_invoice":
    case "sales_order":
    case "customer":
      return "sales";
    case "vendor_bill":
    case "purchase_order":
    case "vendor":
      return "purchases";
    case "product":
      return "products";
    case "journal_entry":
      return "accounting";
  }
}

function assertAttachmentPermission(
  actor: AuthUser,
  entityType: AttachmentEntityType,
  intent: "view" | "upload" | "delete"
): void {
  if (actor.role === "admin") return;
  const mod = resolveAttachmentPermissionModule(entityType);
  const perms = actor.permissions[mod];
  const allowed =
    intent === "view"
      ? Boolean(perms?.view)
      : intent === "upload"
        ? Boolean(perms?.create || perms?.edit)
        : Boolean(perms?.delete);
  if (!allowed) {
    throw new AppError(403, `Forbidden: insufficient ${mod} permission for attachment ${intent}`, "FORBIDDEN");
  }
}

export function normalizeAttachmentEntityTypes(entityType: AttachmentEntityType): AttachmentEntityType[] {
  if (entityType === "invoice" || entityType === "sales_invoice") {
    return ["invoice", "sales_invoice"];
  }
  return [entityType];
}

export async function assertEntityBelongsToCompany(
  db: AppDatabase,
  actor: AuthUser,
  entityType: AttachmentEntityType,
  entityId: string
): Promise<{ companyId: string; branchId: string | null; label: string }> {
  if (!UUID_RE.test(entityId)) {
    throw new AppError(400, "Invalid entityId UUID", "VALIDATION_ERROR");
  }
  const companyId = actorCompanyId(actor);

  switch (entityType) {
    case "invoice":
    case "sales_invoice": {
      const [row] = await db
        .select({ id: salesInvoices.id, branchId: salesInvoices.branchId, label: salesInvoices.invoiceNumber })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.id, entityId), eq(salesInvoices.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Sales invoice not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return { companyId, branchId: row.branchId, label: row.label };
    }
    case "sales_order": {
      const [row] = await db
        .select({ id: salesOrders.id, branchId: salesOrders.branchId, label: salesOrders.soNumber })
        .from(salesOrders)
        .where(and(eq(salesOrders.id, entityId), eq(salesOrders.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Sales order not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return { companyId, branchId: row.branchId, label: row.label };
    }
    case "customer": {
      const [row] = await db
        .select({ id: customers.id, label: customers.name })
        .from(customers)
        .where(and(eq(customers.id, entityId), eq(customers.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Customer not found in active company", "NOT_FOUND");
      return { companyId, branchId: null, label: row.label };
    }
    case "vendor_bill": {
      const [row] = await db
        .select({ id: vendorBills.id, branchId: vendorBills.branchId, label: vendorBills.billNumber })
        .from(vendorBills)
        .where(and(eq(vendorBills.id, entityId), eq(vendorBills.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Vendor bill not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return { companyId, branchId: row.branchId, label: row.label };
    }
    case "purchase_order": {
      const [row] = await db
        .select({ id: purchaseOrders.id, branchId: purchaseOrders.branchId, label: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, entityId), eq(purchaseOrders.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Purchase order not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return { companyId, branchId: row.branchId, label: row.label };
    }
    case "vendor": {
      const [row] = await db
        .select({ id: vendors.id, label: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.id, entityId), eq(vendors.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Vendor not found in active company", "NOT_FOUND");
      return { companyId, branchId: null, label: row.label };
    }
    case "product": {
      const [row] = await db
        .select({ id: products.id, label: products.sku })
        .from(products)
        .where(and(eq(products.id, entityId), eq(products.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Product not found in active company", "NOT_FOUND");
      return { companyId, branchId: null, label: row.label };
    }
    case "journal_entry": {
      const [row] = await db
        .select({ id: journalEntries.id, branchId: journalEntries.branchId, label: journalEntries.entryNumber })
        .from(journalEntries)
        .where(and(eq(journalEntries.id, entityId), eq(journalEntries.companyId, companyId)))
        .limit(1);
      if (!row) throw new AppError(404, "Journal entry not found in active company", "NOT_FOUND");
      assertBranchAccess(actor, row.branchId);
      return { companyId, branchId: row.branchId, label: row.label };
    }
  }
}

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export function detectBinaryMagicKind(buffer: Buffer): string | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    return "application/zip";
  }
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return "application/x-msdownload";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return "application/x-elf";
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && (buffer[3] === 0xce || buffer[3] === 0xcf)) ||
      (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe))
  ) {
    return "application/x-mach-binary";
  }
  return null;
}

export function validateAttachmentBinary(
  fileName: string,
  mimeType: string,
  buffer: Buffer
): { safeFileName: string; normalizedMime: AttachmentAllowedMimeType } {
  if (!buffer || buffer.length === 0) {
    throw new AppError(400, "Uploaded file must not be empty", "EMPTY_FILE");
  }
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError(413, `File exceeds maximum allowed size of ${ATTACHMENT_MAX_BYTES} bytes`, "FILE_TOO_LARGE");
  }

  const normalizedMime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME_SET.has(normalizedMime)) {
    throw new AppError(415, `Unsupported attachment MIME type '${normalizedMime || "unknown"}'`, "UNSUPPORTED_MEDIA_TYPE");
  }

  const safeFileName = sanitizeFileName(fileName);
  const ext = path.posix.extname(safeFileName).toLowerCase();
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    throw new AppError(400, `File extension '${ext}' is not allowed`, "DISALLOWED_EXTENSION");
  }

  const detectedMagic = detectBinaryMagicKind(buffer);

  // Magic-byte verification against declared MIME type
  switch (normalizedMime as AttachmentAllowedMimeType) {
    case "application/pdf": {
      if (detectedMagic !== "application/pdf") {
        throw new AppError(400, "File content does not match PDF header signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case "image/png": {
      if (detectedMagic !== "image/png") {
        throw new AppError(400, "File content does not match PNG header signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case "image/jpeg": {
      if (detectedMagic !== "image/jpeg") {
        throw new AppError(400, "File content does not match JPEG header signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case "image/webp": {
      if (detectedMagic !== "image/webp") {
        throw new AppError(400, "File content does not match WebP header signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      if (detectedMagic !== "application/zip") {
        throw new AppError(400, "File content does not match OOXML/ZIP header signature", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
    case "text/plain":
    case "text/csv": {
      if (buffer.includes(0x00)) {
        throw new AppError(400, "Text/CSV files must not contain binary null bytes", "INVALID_FILE_SIGNATURE");
      }
      if (detectedMagic !== null) {
        throw new AppError(
          400,
          `Text/CSV file content matches disallowed binary signature (${detectedMagic})`,
          "INVALID_FILE_SIGNATURE"
        );
      }
      try {
        UTF8_FATAL_DECODER.decode(buffer);
      } catch {
        throw new AppError(400, "Text/CSV files must be valid UTF-8 text", "INVALID_FILE_SIGNATURE");
      }
      break;
    }
  }

  return { safeFileName, normalizedMime: normalizedMime as AttachmentAllowedMimeType };
}

function toAttachmentDto(row: typeof documentAttachments.$inferSelect): DocumentAttachmentDto {
  return {
    id: row.id,
    companyId: row.companyId,
    entityType: row.entityType as AttachmentEntityType,
    entityId: row.entityId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageDriver: row.storageDriver,
    uploadedBy: row.uploadedBy,
    uploadedByName: row.uploadedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function uploadAttachment(
  db: AppDatabase,
  actor: AuthUser,
  input: {
    entityType: string;
    entityId: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  },
  ipAddress?: string
): Promise<DocumentAttachmentDto> {
  const fields = parseOrThrow(
    attachmentListQuerySchema,
    { entityType: input.entityType, entityId: input.entityId },
    "Invalid attachment entity fields"
  );
  assertAttachmentPermission(actor, fields.entityType, "upload");

  const { safeFileName, normalizedMime } = validateAttachmentBinary(
    input.fileName,
    input.mimeType,
    input.buffer
  );

  const entityCtx = await assertEntityBelongsToCompany(db, actor, fields.entityType, fields.entityId);

  const scanResult = await scanAttachmentBuffer(input.buffer, {
    fileName: safeFileName,
    mimeType: normalizedMime,
    sizeBytes: input.buffer.length,
  });
  if (!scanResult.clean) {
    await writeAuditLog(db, {
      companyId: entityCtx.companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      branchId: entityCtx.branchId,
      action: "attachment.malware_rejected",
      entityType: fields.entityType,
      entityId: fields.entityId,
      entityLabel: safeFileName,
      details: {
        mimeType: normalizedMime,
        sizeBytes: input.buffer.length,
        scanner: scanResult.scanner,
        threat: scanResult.threat ?? "unknown",
      },
      ipAddress,
    });
    throw new AppError(422, "Uploaded file failed virus screening and was rejected", "MALWARE_DETECTED", {
      threat: scanResult.threat ?? "unknown",
      scanner: scanResult.scanner,
    });
  }

  const storageKey = buildStorageKey(entityCtx.companyId, fields.entityType, fields.entityId, safeFileName);
  const stored = await putStorageObject(storageKey, input.buffer, normalizedMime);

  try {
    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documentAttachments)
        .values({
          companyId: entityCtx.companyId,
          entityType: fields.entityType,
          entityId: fields.entityId,
          fileName: safeFileName,
          mimeType: normalizedMime,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageDriver: stored.driver,
          storageKey: stored.key,
          uploadedBy: actor.id,
          uploadedByName: actor.name,
        })
        .returning();

      await writeAuditLog(tx, {
        companyId: entityCtx.companyId,
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        branchId: entityCtx.branchId,
        action: "attachment.uploaded",
        entityType: fields.entityType,
        entityId: row.id,
        entityLabel: safeFileName,
        details: {
          parentEntityType: fields.entityType,
          parentEntityId: fields.entityId,
          parentLabel: entityCtx.label,
          mimeType: normalizedMime,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageDriver: stored.driver,
        },
        after: {
          id: row.id,
          entityType: row.entityType,
          entityId: row.entityId,
          fileName: row.fileName,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
          storageDriver: row.storageDriver,
        },
        ipAddress,
      });

      return row;
    });

    return toAttachmentDto(inserted);
  } catch (err) {
    await deleteStorageObject(stored.key, stored.driver).catch(() => {});
    throw err;
  }
}

export async function listAttachments(
  db: AppDatabase,
  actor: AuthUser,
  rawQuery: unknown
): Promise<DocumentAttachmentDto[]> {
  const query = parseOrThrow(attachmentListQuerySchema, rawQuery, "Invalid attachment query");
  assertAttachmentPermission(actor, query.entityType, "view");
  const companyId = actorCompanyId(actor);
  await assertEntityBelongsToCompany(db, actor, query.entityType, query.entityId);

  const entityTypes = normalizeAttachmentEntityTypes(query.entityType);
  const rows = await db
    .select()
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.companyId, companyId),
        inArray(documentAttachments.entityType, entityTypes),
        eq(documentAttachments.entityId, query.entityId)
      )
    )
    .orderBy(desc(documentAttachments.createdAt));

  return rows.map(toAttachmentDto);
}

export async function getAttachmentForDownload(
  db: AppDatabase,
  actor: AuthUser,
  attachmentId: string
): Promise<{ attachment: DocumentAttachmentDto; buffer: Buffer }> {
  if (!UUID_RE.test(attachmentId)) {
    throw new AppError(400, "Invalid attachment ID", "VALIDATION_ERROR");
  }
  const companyId = actorCompanyId(actor);

  const [row] = await db
    .select()
    .from(documentAttachments)
    .where(and(eq(documentAttachments.id, attachmentId), eq(documentAttachments.companyId, companyId)))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Attachment not found", "NOT_FOUND");
  }

  assertAttachmentPermission(actor, row.entityType as AttachmentEntityType, "view");
  const buffer = await getStorageObject(row.storageKey, row.storageDriver);
  return { attachment: toAttachmentDto(row), buffer };
}

export async function deleteAttachment(
  db: AppDatabase,
  actor: AuthUser,
  attachmentId: string,
  ipAddress?: string
): Promise<void> {
  if (!UUID_RE.test(attachmentId)) {
    throw new AppError(400, "Invalid attachment ID", "VALIDATION_ERROR");
  }
  const companyId = actorCompanyId(actor);

  const [existing] = await db
    .select()
    .from(documentAttachments)
    .where(and(eq(documentAttachments.id, attachmentId), eq(documentAttachments.companyId, companyId)))
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Attachment not found", "NOT_FOUND");
  }

  assertAttachmentPermission(actor, existing.entityType as AttachmentEntityType, "delete");

  await db.transaction(async (tx) => {
    await tx
      .delete(documentAttachments)
      .where(and(eq(documentAttachments.id, attachmentId), eq(documentAttachments.companyId, companyId)));

    await writeAuditLog(tx, {
      companyId,
      userId: actor.id,
      userName: actor.name,
      userRole: actor.role,
      action: "attachment.deleted",
      entityType: existing.entityType,
      entityId: existing.id,
      entityLabel: existing.fileName,
      before: {
        id: existing.id,
        entityType: existing.entityType,
        entityId: existing.entityId,
        fileName: existing.fileName,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        sha256: existing.sha256,
      },
      ipAddress,
    });
  });

  await deleteStorageObject(existing.storageKey, existing.storageDriver);
}

export async function loadAttachmentBuffersForEmail(
  db: AppDatabase,
  companyId: string,
  entityTypes: AttachmentEntityType[],
  entityId: string,
  options: { attachStoredFiles: boolean; attachmentIds: string[] }
): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
  const rowsMap = new Map<string, typeof documentAttachments.$inferSelect>();

  if (options.attachStoredFiles) {
    const storedRows = await db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.companyId, companyId),
          inArray(documentAttachments.entityType, entityTypes),
          eq(documentAttachments.entityId, entityId)
        )
      )
      .orderBy(desc(documentAttachments.createdAt));
    for (const r of storedRows) {
      rowsMap.set(r.id, r);
    }
  }

  if (options.attachmentIds.length > 0) {
    const uniqueIds = Array.from(new Set(options.attachmentIds));
    const requestedRows = await db
      .select()
      .from(documentAttachments)
      .where(and(eq(documentAttachments.companyId, companyId), inArray(documentAttachments.id, uniqueIds)));

    if (requestedRows.length !== uniqueIds.length) {
      throw new AppError(404, "One or more requested attachments were not found in active company", "NOT_FOUND");
    }
    for (const r of requestedRows) {
      rowsMap.set(r.id, r);
    }
  }

  const results: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  for (const row of rowsMap.values()) {
    const content = await getStorageObject(row.storageKey, row.storageDriver);
    results.push({
      filename: sanitizeFileName(row.fileName),
      content,
      contentType: row.mimeType,
    });
  }
  return results;
}
