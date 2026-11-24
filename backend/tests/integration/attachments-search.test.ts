import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { DEFAULT_COMPANY_ID } from "@erp/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

function extractSessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === "erp_session")?.value;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function buildMinimalPdf(label = "M3 Test PDF"): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\n%%EOF\n`, "utf8");
}

function buildMinimalPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64"
  );
}

function buildMinimalZip(marker = "ooxml"): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, "utf8")]);
}

function buildMultipartBody(params: {
  fields: Record<string, string>;
  file?: { fieldName?: string; fileName: string; mimeType: string; content: Buffer };
}): { boundary: string; payload: Buffer } {
  const boundary = `----ErpTestBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [k, v] of Object.entries(params.fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
        "utf8"
      )
    );
  }

  if (params.file) {
    const fieldName = params.file.fieldName ?? "file";
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${params.file.fileName}"\r\nContent-Type: ${params.file.mimeType}\r\n\r\n`,
        "utf8"
      )
    );
    chunks.push(params.file.content);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { boundary, payload: Buffer.concat(chunks) };
}

describe.skipIf(!testDbUrl)(
  "Wave 1 M3 — Domain Tenancy, Pluggable Storage/Attachments, Search, Exports, Saved Views, Print Templates & Emailing",
  () => {
    let app: FastifyInstance;
    let tempUploadsDir = "";
    let setEmailTransportForTests: typeof import("../../src/services/email.service.ts").setEmailTransportForTests;
    let setS3ClientOverrideForTests: typeof import("../../src/services/storage.service.ts").setS3ClientOverrideForTests;
    let setStorageConfigOverrideForTests: typeof import("../../src/services/storage.service.ts").setStorageConfigOverrideForTests;

    beforeAll(async () => {
      const storageMod = await import("../../src/services/storage.service.ts");
      const emailMod = await import("../../src/services/email.service.ts");
      setS3ClientOverrideForTests = storageMod.setS3ClientOverrideForTests;
      setStorageConfigOverrideForTests = storageMod.setStorageConfigOverrideForTests;
      setEmailTransportForTests = emailMod.setEmailTransportForTests;

      tempUploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-m3-uploads-"));
      setStorageConfigOverrideForTests({ driver: "local", localDir: tempUploadsDir });

      const { buildApp } = await import("../../src/app.ts");
      app = await buildApp({ logger: false });
      await app.ready();

      const { getDb } = await import("../../src/db/index.ts");
      const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
      await assertTestDatabaseName(getDb(), testDbUrl!);
    });

    afterAll(async () => {
      setEmailTransportForTests?.(null);
      setS3ClientOverrideForTests?.(null);
      setStorageConfigOverrideForTests?.(null);
      if (tempUploadsDir) {
        await fs.rm(tempUploadsDir, { recursive: true, force: true }).catch(() => {});
      }
      if (app) await app.close();
      const { closeDatabase } = await import("../../src/db/index.ts");
      await closeDatabase();
    });

    it("exercises local & S3 attachments, search, CSV/XLSX exports, saved views, print templates, emailing & multi-company domain isolation", async () => {
      const { getDb } = await import("../../src/db/index.ts");
      const { resetTestDatabase } = await import("../helpers/db-reset.ts");
      const db = getDb();
      await resetTestDatabase(db);

      // -----------------------------------------------------------------------
      // 1. Bootstrap Admin in COMP-01 + create master/transactional records
      // -----------------------------------------------------------------------
      const signupRes = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: {
          name: "M3 Admin",
          email: "m3-admin@test.local",
          password: "Password123!",
        },
      });
      expect(signupRes.statusCode).toBe(201);
      const adminCookie = extractSessionCookie(signupRes)!;
      expect(adminCookie).toBeTruthy();

      const authHeaders = (cookie = adminCookie) => ({ cookie: `erp_session=${cookie}` });

      const brRes = await app.inject({ method: "GET", url: "/api/branches", headers: authHeaders() });
      expect(brRes.statusCode).toBe(200);
      const hq1 = (brRes.json() as { branches: Array<{ id: string }> }).branches[0]!.id;

      // Create products (including CSV quoting + formula injection payloads)
      const p1Res = await app.inject({
        method: "POST",
        url: "/api/products",
        headers: authHeaders(),
        payload: {
          sku: "LSR-X9",
          name: "Laser Printer X9",
          costPrice: 50,
          sellingPrice: 100,
          initialStock: [{ branchId: hq1, quantity: 20, unitCost: 50 }],
        },
      });
      expect(p1Res.statusCode).toBe(201);
      const prod1 = (p1Res.json() as { product: { id: string; sku: string } }).product;

      // Verify product update records beforeJson/afterJson/changedFields (EF6)
      const p1Upd = await app.inject({
        method: "PUT",
        url: `/api/products/${prod1.id}`,
        headers: authHeaders(),
        payload: { sellingPrice: 145 },
      });
      expect(p1Upd.statusCode).toBe(200);

      const auditRes = await app.inject({
        method: "GET",
        url: `/api/audit-logs?q=${encodeURIComponent(prod1.sku)}`,
        headers: authHeaders(),
      });
      expect(auditRes.statusCode).toBe(200);
      const auditEntries = (
        auditRes.json() as {
          entries: Array<{
            entityId: string;
            beforeJson: Record<string, unknown> | null;
            afterJson: Record<string, unknown> | null;
            changedFields: string[];
          }>;
        }
      ).entries;
      const prodCreateAudit = auditEntries.find((e) => e.entityId === prod1.id && e.beforeJson === null);
      expect(prodCreateAudit?.afterJson).toBeTruthy();
      const prodUpdateAudit = auditEntries.find(
        (e) => e.entityId === prod1.id && e.beforeJson !== null && e.changedFields.includes("sellingPrice")
      );
      expect(prodUpdateAudit?.beforeJson?.sellingPrice).toBe(100);
      expect(prodUpdateAudit?.afterJson?.sellingPrice).toBe(145);

      const pFormulaRes = await app.inject({
        method: "POST",
        url: "/api/products",
        headers: authHeaders(),
        payload: {
          sku: "=CMD|'/C calc'!A0",
          name: 'Widget, "Pro"',
          costPrice: 10,
          sellingPrice: 20,
        },
      });
      expect(pFormulaRes.statusCode).toBe(201);

      const custRes = await app.inject({
        method: "POST",
        url: "/api/customers",
        headers: authHeaders(),
        payload: { name: "Acme Retail Corp", email: "client@example.com", creditLimit: 10000 },
      });
      expect(custRes.statusCode).toBe(201);
      const cust1 = (custRes.json() as { customer: { id: string } }).customer;

      const vendRes = await app.inject({
        method: "POST",
        url: "/api/vendors",
        headers: authHeaders(),
        payload: { name: "Comp1 Vendor" },
      });
      expect(vendRes.statusCode).toBe(201);
      const vend1 = (vendRes.json() as { vendor: { id: string } }).vendor;

      const invRes = await app.inject({
        method: "POST",
        url: "/api/sales-invoices",
        headers: authHeaders(),
        payload: {
          customerId: cust1.id,
          branchId: hq1,
          status: "Sent",
          dueDate: "2027-12-31",
          lines: [{ productId: prod1.id, quantity: 2, unitPrice: 145, taxRate: 0 }],
        },
      });
      expect(invRes.statusCode).toBe(201);
      const inv1 = (invRes.json() as { invoice: { id: string; invoiceNumber: string } }).invoice;

      const billRes = await app.inject({
        method: "POST",
        url: "/api/vendor-bills",
        headers: authHeaders(),
        payload: {
          vendorId: vend1.id,
          branchId: hq1,
          dueDate: "2027-12-31",
          lines: [{ productId: prod1.id, quantity: 3, unitCost: 50, taxRate: 0 }],
        },
      });
      expect(billRes.statusCode).toBe(201);
      const bill1 = (billRes.json() as { bill: { id: string; billNumber: string } }).bill;

      const accRes = await app.inject({ method: "GET", url: "/api/accounting/accounts", headers: authHeaders() });
      expect(accRes.statusCode).toBe(200);
      const accounts1 = (accRes.json() as { accounts: Array<{ id: string }> }).accounts;
      expect(accounts1.length).toBeGreaterThanOrEqual(2);

      const jeRes = await app.inject({
        method: "POST",
        url: "/api/accounting/journal-entries",
        headers: authHeaders(),
        payload: {
          branchId: hq1,
          memo: "Secret Ledger Memo Comp1",
          lines: [
            { accountId: accounts1[0]!.id, branchId: hq1, debit: 150, credit: 0 },
            { accountId: accounts1[1]!.id, branchId: hq1, debit: 0, credit: 150 },
          ],
        },
      });
      expect(jeRes.statusCode).toBe(201);
      const je1 = (jeRes.json() as { entry: { id: string } }).entry;

      // -----------------------------------------------------------------------
      // 2. Local Storage Attachments: Upload, List, SHA-256 Download, Rejections, Delete
      // -----------------------------------------------------------------------
      const pdfBytes = buildMinimalPdf("Invoice Attachment Test");
      const pdfSha = sha256Hex(pdfBytes);

      const uploadPart = buildMultipartBody({
        fields: { entityType: "invoice", entityId: inv1.id },
        file: { fileName: "receipt-test.pdf", mimeType: "application/pdf", content: pdfBytes },
      });
      const upRes = await app.inject({
        method: "POST",
        url: "/api/attachments",
        headers: {
          ...authHeaders(),
          "content-type": `multipart/form-data; boundary=${uploadPart.boundary}`,
        },
        payload: uploadPart.payload,
      });
      expect(upRes.statusCode).toBe(201);
      const att1 = (
        upRes.json() as {
          attachment: { id: string; sha256: string; storageDriver: string; sizeBytes: number; fileName: string };
        }
      ).attachment;
      expect(att1.storageDriver).toBe("local");
      expect(att1.sha256).toBe(pdfSha);
      expect(att1.sizeBytes).toBe(pdfBytes.length);

      // List attachments
      const listAttRes = await app.inject({
        method: "GET",
        url: `/api/attachments?entityType=invoice&entityId=${inv1.id}`,
        headers: authHeaders(),
      });
      expect(listAttRes.statusCode).toBe(200);
      expect((listAttRes.json() as { attachments: Array<{ id: string }> }).attachments).toHaveLength(1);

      // Download & verify headers + byte equality + SHA-256
      const dlRes = await app.inject({
        method: "GET",
        url: `/api/attachments/${att1.id}/download`,
        headers: authHeaders(),
      });
      expect(dlRes.statusCode).toBe(200);
      expect(String(dlRes.headers["content-disposition"])).toMatch(/attachment/i);
      expect(String(dlRes.headers["x-content-type-options"]).toLowerCase()).toBe("nosniff");
      expect(String(dlRes.headers["content-type"])).toBe("application/pdf");
      expect(sha256Hex(dlRes.rawPayload)).toBe(pdfSha);
      expect(dlRes.rawPayload.equals(pdfBytes)).toBe(true);

      // All remaining allowed MIME types (png, jpeg, webp, csv, txt, xlsx, docx)
      const allowedSamples = [
        { entityType: "product", entityId: prod1.id, fileName: "spec.png", mimeType: "image/png", content: buildMinimalPng() },
        { entityType: "product", entityId: prod1.id, fileName: "photo.jpg", mimeType: "image/jpeg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
        { entityType: "product", entityId: prod1.id, fileName: "img.webp", mimeType: "image/webp", content: Buffer.from("RIFF\x00\x00\x00\x00WEBP") },
        { entityType: "vendor_bill", entityId: bill1.id, fileName: "bill.txt", mimeType: "text/plain", content: Buffer.from("bill proof") },
        { entityType: "journal_entry", entityId: je1.id, fileName: "ledger.csv", mimeType: "text/csv", content: Buffer.from("a,b\n1,2\n") },
        { entityType: "product", entityId: prod1.id, fileName: "sheet.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: buildMinimalZip("xlsx") },
        { entityType: "product", entityId: prod1.id, fileName: "doc.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: buildMinimalZip("docx") },
      ];
      for (const sample of allowedSamples) {
        const mp = buildMultipartBody({
          fields: { entityType: sample.entityType, entityId: sample.entityId },
          file: { fileName: sample.fileName, mimeType: sample.mimeType, content: sample.content },
        });
        const r = await app.inject({
          method: "POST",
          url: "/api/attachments",
          headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${mp.boundary}` },
          payload: mp.payload,
        });
        expect(r.statusCode).toBe(201);
      }

      // Rejections: disallowed MIME, blocked extension, empty file, >10MB, bad entityType, path traversal sanitized
      for (const bad of [
        { fileName: "evil.html", mimeType: "text/html", content: Buffer.from("<script>1</script>"), statuses: [400, 415] },
        { fileName: "evil.svg", mimeType: "image/svg+xml", content: Buffer.from("<svg/>"), statuses: [400, 415] },
        { fileName: "evil.exe", mimeType: "text/plain", content: Buffer.from("MZ"), statuses: [400] },
        { fileName: "empty.txt", mimeType: "text/plain", content: Buffer.alloc(0), statuses: [400] },
        { fileName: "too-big.txt", mimeType: "text/plain", content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x41), statuses: [400, 413] },
      ]) {
        const mp = buildMultipartBody({
          fields: { entityType: "product", entityId: prod1.id },
          file: { fileName: bad.fileName, mimeType: bad.mimeType, content: bad.content },
        });
        const r = await app.inject({
          method: "POST",
          url: "/api/attachments",
          headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${mp.boundary}` },
          payload: mp.payload,
        });
        expect(bad.statuses).toContain(r.statusCode);
      }

      const travMp = buildMultipartBody({
        fields: { entityType: "product", entityId: prod1.id },
        file: { fileName: "../../evil.pdf", mimeType: "application/pdf", content: pdfBytes },
      });
      const travRes = await app.inject({
        method: "POST",
        url: "/api/attachments",
        headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${travMp.boundary}` },
        payload: travMp.payload,
      });
      expect(travRes.statusCode).toBe(201);
      expect((travRes.json() as { attachment: { fileName: string } }).attachment.fileName).not.toContain("..");

      // -----------------------------------------------------------------------
      // 3. S3 Storage Driver via Mocked S3Client
      // -----------------------------------------------------------------------
      const s3Store = new Map<string, Buffer>();
      let putCount = 0;
      let getCount = 0;
      let deleteCount = 0;
      setS3ClientOverrideForTests({
        async send(command: unknown) {
          if (command instanceof PutObjectCommand) {
            putCount++;
            const key = String(command.input.Key);
            const body = Buffer.isBuffer(command.input.Body)
              ? command.input.Body
              : Buffer.from(command.input.Body as Uint8Array);
            s3Store.set(key, body);
            return {};
          }
          if (command instanceof GetObjectCommand) {
            getCount++;
            const key = String(command.input.Key);
            const data = s3Store.get(key);
            if (!data) {
              const err = new Error("NoSuchKey");
              err.name = "NoSuchKey";
              throw err;
            }
            return {
              Body: {
                transformToByteArray: async () => new Uint8Array(data),
              },
            };
          }
          if (command instanceof DeleteObjectCommand) {
            deleteCount++;
            s3Store.delete(String(command.input.Key));
            return {};
          }
          throw new Error("Unexpected S3 command");
        },
      });
      setStorageConfigOverrideForTests({ driver: "s3", localDir: tempUploadsDir });

      const s3Pdf = buildMinimalPdf("S3 Mock Attachment");
      const s3Mp = buildMultipartBody({
        fields: { entityType: "invoice", entityId: inv1.id },
        file: { fileName: "s3-doc.pdf", mimeType: "application/pdf", content: s3Pdf },
      });
      const s3UpRes = await app.inject({
        method: "POST",
        url: "/api/attachments",
        headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${s3Mp.boundary}` },
        payload: s3Mp.payload,
      });
      expect(s3UpRes.statusCode).toBe(201);
      const s3Att = (s3UpRes.json() as { attachment: { id: string; storageDriver: string; sha256: string } }).attachment;
      expect(s3Att.storageDriver).toBe("s3");
      expect(putCount).toBe(1);

      const s3DlRes = await app.inject({
        method: "GET",
        url: `/api/attachments/${s3Att.id}/download`,
        headers: authHeaders(),
      });
      expect(s3DlRes.statusCode).toBe(200);
      expect(getCount).toBe(1);
      expect(s3DlRes.rawPayload.equals(s3Pdf)).toBe(true);

      const s3DelRes = await app.inject({
        method: "DELETE",
        url: `/api/attachments/${s3Att.id}`,
        headers: authHeaders(),
      });
      expect(s3DelRes.statusCode).toBe(200);
      expect(deleteCount).toBe(1);

      // Restore local driver
      setS3ClientOverrideForTests(null);
      setStorageConfigOverrideForTests({ driver: "local", localDir: tempUploadsDir });

      // -----------------------------------------------------------------------
      // 4. Print Templates CRUD & Document Emailing with Mocked Transport
      // -----------------------------------------------------------------------
      const badLogoRes = await app.inject({
        method: "POST",
        url: "/api/print-templates",
        headers: authHeaders(),
        payload: { documentType: "invoice", name: "Bad", logoUrl: "javascript:alert(1)" },
      });
      expect(badLogoRes.statusCode).toBe(400);

      const tpl1Res = await app.inject({
        method: "POST",
        url: "/api/print-templates",
        headers: authHeaders(),
        payload: {
          documentType: "invoice",
          name: "Modern Invoice A4",
          headerHtml: "<div>Acme Header</div>",
          footerHtml: "<div>Thank you</div>",
          logoUrl: "/logo.png",
          accentColor: "#1d4ed8",
          isDefault: true,
        },
      });
      expect(tpl1Res.statusCode).toBe(201);
      const tpl1 = (tpl1Res.json() as { template: { id: string } }).template;

      const sentMails: Array<{
        to: string;
        cc?: string;
        subject: string;
        html?: string;
        attachments?: Array<{ filename: string; content: Buffer | string }>;
      }> = [];
      setEmailTransportForTests({
        async sendMail(mail) {
          sentMails.push(mail);
          return { messageId: "<mock-msg-001@test.local>" };
        },
      });

      const emailRes = await app.inject({
        method: "POST",
        url: `/api/documents/invoice/${inv1.id}/email`,
        headers: authHeaders(),
        payload: {
          to: ["client@example.com"],
          cc: ["finance@example.com"],
          subject: `Invoice ${inv1.invoiceNumber}`,
          message: "Please find your invoice attached.",
          attachStoredFiles: true,
          templateId: tpl1.id,
        },
      });
      expect(emailRes.statusCode).toBe(200);
      const emailJson = emailRes.json() as {
        sent: boolean;
        recipients: string[];
        attachmentCount: number;
        messageId?: string;
      };
      expect(emailJson.sent).toBe(true);
      expect(emailJson.recipients).toContain("client@example.com");
      expect(emailJson.recipients).toContain("finance@example.com");
      expect(emailJson.attachmentCount).toBeGreaterThanOrEqual(1);
      expect(emailJson.messageId).toBe("<mock-msg-001@test.local>");
      expect(sentMails).toHaveLength(1);
      expect(sentMails[0]!.html).toContain("Acme Header");
      expect(sentMails[0]!.attachments?.length).toBeGreaterThanOrEqual(1);

      // CRLF subject injection rejected
      const crlfEmail = await app.inject({
        method: "POST",
        url: `/api/documents/invoice/${inv1.id}/email`,
        headers: authHeaders(),
        payload: { to: "good@example.com", subject: "Hi\r\nBcc: evil@evil.com" },
      });
      expect(crlfEmail.statusCode).toBe(400);

      setEmailTransportForTests(null);

      // -----------------------------------------------------------------------
      // 5. Global Search & Exports (CSV RFC-4180 + formula neutralization + XLSX)
      // -----------------------------------------------------------------------
      expect((await app.inject({ method: "GET", url: "/api/search?q=", headers: authHeaders() })).statusCode).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/search?q=Laser&limit=51", headers: authHeaders() })).statusCode
      ).toBe(400);

      const searchRes = await app.inject({
        method: "GET",
        url: "/api/search?q=%20%20Laser%20%20&limit=5",
        headers: authHeaders(),
      });
      expect(searchRes.statusCode).toBe(200);
      const searchJson = searchRes.json() as { query: string; results: Array<{ type: string; title: string }> };
      expect(searchJson.query).toBe("Laser");
      expect(searchJson.results.some((r) => r.type === "product" && r.title === "Laser Printer X9")).toBe(true);

      // Special SQL/XSS chars handled safely
      const specialSearch = await app.inject({
        method: "GET",
        url: `/api/search?q=${encodeURIComponent(`%_'"<script>alert(1)</script>`)}`,
        headers: authHeaders(),
      });
      expect(specialSearch.statusCode).toBe(200);

      // CSV export: quoting + formula neutralization
      const csvRes = await app.inject({
        method: "GET",
        url: "/api/exports/products?format=csv",
        headers: authHeaders(),
      });
      expect(csvRes.statusCode).toBe(200);
      expect(String(csvRes.headers["content-type"])).toMatch(/text\/csv/i);
      expect(String(csvRes.headers["content-disposition"])).toMatch(/attachment/i);
      expect(String(csvRes.headers["x-content-type-options"]).toLowerCase()).toBe("nosniff");
      expect(csvRes.body).toContain('"Widget, ""Pro"""');
      expect(csvRes.body).toContain("'=CMD|'/C calc'!A0");

      // XLSX export: valid ZIP magic bytes + readable workbook
      const xlsxRes = await app.inject({
        method: "GET",
        url: "/api/exports/products?format=xlsx",
        headers: authHeaders(),
      });
      expect(xlsxRes.statusCode).toBe(200);
      expect(xlsxRes.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsxRes.rawPayload as unknown as ArrayBuffer);
      expect(wb.worksheets[0]!.rowCount).toBeGreaterThanOrEqual(3);

      // Invalid resource/format
      expect(
        (await app.inject({ method: "GET", url: "/api/exports/nonexistent?format=csv", headers: authHeaders() }))
          .statusCode
      ).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/exports/products?format=pdf", headers: authHeaders() })).statusCode
      ).toBe(400);

      // -----------------------------------------------------------------------
      // 6. Saved Views CRUD & Duplicate Conflict
      // -----------------------------------------------------------------------
      const svCreate = await app.inject({
        method: "POST",
        url: "/api/saved-views",
        headers: authHeaders(),
        payload: {
          resource: "products",
          name: "Compact View",
          configJson: { columns: { sku: true, name: true }, sortBy: "name", sortDir: "asc", pageSize: 25 },
          isDefault: true,
        },
      });
      expect(svCreate.statusCode).toBe(201);
      const svId = (svCreate.json() as { view: { id: string } }).view.id;

      const svDup = await app.inject({
        method: "POST",
        url: "/api/saved-views",
        headers: authHeaders(),
        payload: { resource: "products", name: "Compact View", configJson: {} },
      });
      expect(svDup.statusCode).toBe(409);

      const svUpd = await app.inject({
        method: "PUT",
        url: `/api/saved-views/${svId}`,
        headers: authHeaders(),
        payload: { name: "Compact View v2" },
      });
      expect(svUpd.statusCode).toBe(200);

      // -----------------------------------------------------------------------
      // 7. RBAC Scoping (Accountant & Cashier)
      // -----------------------------------------------------------------------
      const rolesRes = await app.inject({ method: "GET", url: "/api/custom-roles", headers: authHeaders() });
      const rolesList = (rolesRes.json() as { roles: Array<{ id: string; name: string }> }).roles;
      const accountantRoleId = rolesList.find((r) => r.name === "Accountant")!.id;
      const cashierRoleId = rolesList.find((r) => r.name === "Cashier")!.id;

      const createAccUser = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: authHeaders(),
        payload: {
          name: "RO Accountant",
          email: "ro-acc@test.local",
          password: "Password123!",
          role: "user",
          branchScopeMode: "selected",
          branchIds: [hq1],
          defaultBranchId: hq1,
        },
      });
      expect(createAccUser.statusCode).toBe(201);
      const accUserId = (createAccUser.json() as { user: { id: string } }).user.id;
      await app.inject({
        method: "PUT",
        url: `/api/users/${accUserId}/custom-role`,
        headers: authHeaders(),
        payload: { customRoleId: accountantRoleId },
      });

      const accLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "ro-acc@test.local", password: "Password123!" },
      });
      const accCookie = extractSessionCookie(accLogin)!;

      // Accountant can download invoice attachment (200), cannot upload/delete (403)
      expect(
        (await app.inject({ method: "GET", url: `/api/attachments/${att1.id}/download`, headers: authHeaders(accCookie) }))
          .statusCode
      ).toBe(200);
      const blockedUp = buildMultipartBody({
        fields: { entityType: "invoice", entityId: inv1.id },
        file: { fileName: "no.txt", mimeType: "text/plain", content: Buffer.from("no") },
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/attachments",
            headers: {
              ...authHeaders(accCookie),
              "content-type": `multipart/form-data; boundary=${blockedUp.boundary}`,
            },
            payload: blockedUp.payload,
          })
        ).statusCode
      ).toBe(403);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/attachments/${att1.id}`, headers: authHeaders(accCookie) }))
          .statusCode
      ).toBe(403);

      // Cross-user saved view modify blocked
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/saved-views/${svId}`,
            headers: authHeaders(accCookie),
            payload: { name: "Hijack" },
          })
        ).statusCode
      ).toBe(404);

      // Cashier cannot see journal entries in search or export journal-entries/audit-logs
      const createCashier = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: authHeaders(),
        payload: {
          name: "Cashier User",
          email: "cashier-m3@test.local",
          password: "Password123!",
          role: "user",
          branchScopeMode: "selected",
          branchIds: [hq1],
          defaultBranchId: hq1,
        },
      });
      const cashierId = (createCashier.json() as { user: { id: string } }).user.id;
      await app.inject({
        method: "PUT",
        url: `/api/users/${cashierId}/custom-role`,
        headers: authHeaders(),
        payload: { customRoleId: cashierRoleId },
      });
      const cashierLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "cashier-m3@test.local", password: "Password123!" },
      });
      const cashierCookie = extractSessionCookie(cashierLogin)!;

      const cashierSearch = await app.inject({
        method: "GET",
        url: "/api/search?q=Secret",
        headers: authHeaders(cashierCookie),
      });
      expect(cashierSearch.statusCode).toBe(200);
      expect(
        (cashierSearch.json() as { results: Array<{ type: string }> }).results.some((r) => r.type === "journal_entry")
      ).toBe(false);
      expect(
        (await app.inject({ method: "GET", url: "/api/exports/journal-entries?format=csv", headers: authHeaders(cashierCookie) }))
          .statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/print-templates",
            headers: authHeaders(cashierCookie),
            payload: { documentType: "invoice", name: "Unauth" },
          })
        ).statusCode
      ).toBe(403);

      // -----------------------------------------------------------------------
      // 8. Multi-Company Isolation (COMP-02 vs COMP-01)
      // -----------------------------------------------------------------------
      const comp2Res = await app.inject({
        method: "POST",
        url: "/api/companies",
        headers: authHeaders(),
        payload: { code: "COMP-02", name: "Subsidiary Beta", baseCurrency: "EUR" },
      });
      expect(comp2Res.statusCode).toBe(201);
      const comp2 = (comp2Res.json() as { company: { id: string } }).company;

      const swRes = await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        headers: authHeaders(),
        payload: { companyId: comp2.id },
      });
      expect(swRes.statusCode).toBe(200);

      // Lists in COMP-02 must exclude all COMP-01 records
      const [p2List, c2List, i2List, b2List, br2List] = await Promise.all([
        app.inject({ method: "GET", url: "/api/products", headers: authHeaders() }),
        app.inject({ method: "GET", url: "/api/customers", headers: authHeaders() }),
        app.inject({ method: "GET", url: "/api/sales-invoices", headers: authHeaders() }),
        app.inject({ method: "GET", url: "/api/vendor-bills", headers: authHeaders() }),
        app.inject({ method: "GET", url: "/api/branches", headers: authHeaders() }),
      ]);
      expect((p2List.json() as { products: Array<{ id: string }> }).products.some((p) => p.id === prod1.id)).toBe(false);
      expect((c2List.json() as { customers: Array<{ id: string }> }).customers.some((c) => c.id === cust1.id)).toBe(false);
      expect((i2List.json() as { invoices: Array<{ id: string }> }).invoices.some((i) => i.id === inv1.id)).toBe(false);
      expect((b2List.json() as { bills: Array<{ id: string }> }).bills.some((b) => b.id === bill1.id)).toBe(false);
      expect((br2List.json() as { branches: Array<{ id: string }> }).branches.some((b) => b.id === hq1)).toBe(false);

      // Cross-company IDOR checks: invoice, product, attachment, email, search, export
      expect((await app.inject({ method: "GET", url: `/api/sales-invoices/${inv1.id}`, headers: authHeaders() })).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/products/${prod1.id}`,
            headers: authHeaders(),
            payload: { name: "Hijacked" },
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: `/api/attachments/${att1.id}/download`, headers: authHeaders() })).statusCode
      ).toBe(404);
      expect(
        (await app.inject({ method: "DELETE", url: `/api/attachments/${att1.id}`, headers: authHeaders() })).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/documents/invoice/${inv1.id}/email`,
            headers: authHeaders(),
            payload: { to: "x@example.com", subject: "Cross tenant" },
          })
        ).statusCode
      ).toBe(404);

      const comp2Search = await app.inject({ method: "GET", url: "/api/search?q=Laser", headers: authHeaders() });
      expect((comp2Search.json() as { results: Array<{ id: string }> }).results.some((r) => r.id === prod1.id)).toBe(false);

      const comp2Csv = await app.inject({ method: "GET", url: "/api/exports/products?format=csv", headers: authHeaders() });
      expect(comp2Csv.body).not.toContain("LSR-X9");

      // Switch back to COMP-01 and delete attachment + saved view cleanly
      await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        headers: authHeaders(),
        payload: { companyId: DEFAULT_COMPANY_ID },
      });

      const delAtt = await app.inject({
        method: "DELETE",
        url: `/api/attachments/${att1.id}`,
        headers: authHeaders(),
      });
      expect(delAtt.statusCode).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: `/api/attachments/${att1.id}/download`, headers: authHeaders() })).statusCode
      ).toBe(404);

      const delSv = await app.inject({
        method: "DELETE",
        url: `/api/saved-views/${svId}`,
        headers: authHeaders(),
      });
      expect(delSv.statusCode).toBe(200);
    });
  }
);
