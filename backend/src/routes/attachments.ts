import type { FastifyInstance } from "fastify";
import { ATTACHMENT_MAX_BYTES } from "@erp/shared";
import { AppError } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import {
  deleteAttachment,
  getAttachmentForDownload,
  listAttachments,
  uploadAttachment,
} from "../services/attachments.service.ts";
import { sanitizeFileName } from "../services/storage.service.ts";

function buildContentDisposition(fileName: string): string {
  const safe = sanitizeFileName(fileName);
  const asciiFallback = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_") || "attachment";
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/attachments", { preHandler: requireAuth }, async (req) => {
    const attachments = await listAttachments(getDb(), req.authUser!, req.query);
    return { attachments };
  });

  app.post("/api/attachments", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw new AppError(400, "Expected multipart/form-data upload", "INVALID_CONTENT_TYPE");
    }

    let entityType = "";
    let entityId = "";
    let fileName = "";
    let mimeType = "";
    let fileBuffer: Buffer | null = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          const val = typeof part.value === "string" ? part.value : String(part.value ?? "");
          if (part.fieldname === "entityType") entityType = val;
          else if (part.fieldname === "entityId") entityId = val;
        } else if (part.type === "file") {
          if (fileBuffer !== null) {
            // Drain extra unexpected file parts safely
            part.file.resume();
            continue;
          }
          fileName = part.filename ?? "attachment";
          mimeType = part.mimetype ?? "application/octet-stream";

          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of part.file) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > ATTACHMENT_MAX_BYTES) {
              throw new AppError(
                413,
                `File exceeds maximum allowed size of ${ATTACHMENT_MAX_BYTES} bytes`,
                "FILE_TOO_LARGE"
              );
            }
            chunks.push(buf);
          }

          if (part.file.truncated) {
            throw new AppError(
              413,
              `File exceeds maximum allowed size of ${ATTACHMENT_MAX_BYTES} bytes`,
              "FILE_TOO_LARGE"
            );
          }
          fileBuffer = Buffer.concat(chunks);
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const code = (err as { code?: string; statusCode?: number })?.code;
      const status = (err as { statusCode?: number })?.statusCode;
      if (code === "FST_REQ_FILE_TOO_LARGE" || status === 413) {
        throw new AppError(
          413,
          `File exceeds maximum allowed size of ${ATTACHMENT_MAX_BYTES} bytes`,
          "FILE_TOO_LARGE"
        );
      }
      throw new AppError(400, err instanceof Error ? err.message : "Invalid multipart payload", "INVALID_MULTIPART");
    }

    if (!fileBuffer) {
      throw new AppError(400, "File field is required", "MISSING_FILE");
    }

    const attachment = await uploadAttachment(
      getDb(),
      req.authUser!,
      {
        entityType,
        entityId,
        fileName,
        mimeType,
        buffer: fileBuffer,
      },
      req.ip
    );

    return reply.status(201).send({ attachment });
  });

  app.get("/api/attachments/:id/download", { preHandler: requireAuth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { attachment, buffer } = await getAttachmentForDownload(getDb(), req.authUser!, id);

    reply.header("Content-Type", attachment.mimeType);
    reply.header("Content-Disposition", buildContentDisposition(attachment.fileName));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Length", String(buffer.length));
    return reply.send(buffer);
  });

  app.delete("/api/attachments/:id", { preHandler: requireAuth }, async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteAttachment(getDb(), req.authUser!, id, req.ip);
    return { ok: true };
  });
}
