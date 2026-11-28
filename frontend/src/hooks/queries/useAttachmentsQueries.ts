import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  attachmentFileMetaSchema,
  type AttachmentEntityType,
  type DocumentAttachmentDto,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import {
  apiDownloadBlob,
  apiMultipartRequest,
  apiRequest,
  triggerBlobDownload,
} from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export type AttachmentValidationResult =
  | { valid: true }
  | { valid: false; reason: "empty" | "too_large" | "invalid_type"; mimeType: string };

export function validateAttachmentFile(file: File): AttachmentValidationResult {
  if (file.size <= 0) {
    return { valid: false, reason: "empty", mimeType: file.type || "unknown" };
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { valid: false, reason: "too_large", mimeType: file.type || "unknown" };
  }
  if (!(ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { valid: false, reason: "invalid_type", mimeType: file.type || "unknown" };
  }
  const parsed = attachmentFileMetaSchema.safeParse({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  });
  if (!parsed.success) {
    return { valid: false, reason: "invalid_type", mimeType: file.type || "unknown" };
  }
  return { valid: true };
}

export function useAttachmentsQuery(entityType: AttachmentEntityType, entityId: string, enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: erpQueryKeys.attachments.list(entityType, entityId),
    queryFn: () =>
      apiRequest<{ attachments: DocumentAttachmentDto[] }>(
        `/api/attachments?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`
      ),
    enabled: Boolean(user) && enabled && Boolean(entityType) && Boolean(entityId),
  });
}

export function useAttachmentMutations(entityType: AttachmentEntityType, entityId: string) {
  const queryClient = useQueryClient();

  const invalidateAttachments = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.attachments.list(entityType, entityId) });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      const check = validateAttachmentFile(file);
      if (!check.valid && "reason" in check) {
        throw new Error(`Invalid attachment (${check.reason})`);
      }
      const formData = new FormData();
      formData.append("entityType", entityType);
      formData.append("entityId", entityId);
      formData.append("file", file);
      return apiMultipartRequest<{ attachment: DocumentAttachmentDto }>("/api/attachments", formData);
    },
    onSuccess: invalidateAttachments,
  });

  const deleteAttachment = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/attachments/${id}`, { method: "DELETE" }),
    onSuccess: invalidateAttachments,
  });

  const downloadAttachment = async (id: string, fallbackName: string) => {
    const { blob, fileName } = await apiDownloadBlob(`/api/attachments/${id}/download`, {
      fallbackFileName: fallbackName,
    });
    triggerBlobDownload(blob, fileName ?? fallbackName);
  };

  return {
    uploadAttachment,
    deleteAttachment,
    downloadAttachment,
  };
}
