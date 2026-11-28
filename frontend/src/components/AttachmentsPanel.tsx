import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  type AttachmentEntityType,
  type DocumentAttachmentDto,
  type PermissionModule,
} from "@erp/shared";
import { usePermissions } from "@/contexts/PermissionsContext";
import {
  useAttachmentMutations,
  useAttachmentsQuery,
  validateAttachmentFile,
} from "@/hooks/queries/useAttachmentsQueries";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface AttachmentsPanelProps {
  entityType: AttachmentEntityType;
  entityId: string;
  canUpload?: boolean;
  canDelete?: boolean;
  className?: string;
}

function resolvePermissionModule(entityType: AttachmentEntityType): PermissionModule {
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function shortMimeBadge(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "image/png") return "PNG";
  if (mimeType === "image/jpeg") return "JPEG";
  if (mimeType === "image/webp") return "WEBP";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType.includes("spreadsheetml")) return "XLSX";
  if (mimeType.includes("wordprocessingml")) return "DOCX";
  if (mimeType === "text/plain") return "TXT";
  return "FILE";
}

export function AttachmentsPanel({
  entityType,
  entityId,
  canUpload: canUploadProp,
  canDelete: canDeleteProp,
  className,
}: AttachmentsPanelProps) {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentAttachmentDto | null>(null);

  const permModule = resolvePermissionModule(entityType);
  const canUpload = canUploadProp ?? (can(permModule, "create") || can(permModule, "edit"));
  const canDelete = canDeleteProp ?? can(permModule, "delete");

  const attachmentsQuery = useAttachmentsQuery(entityType, entityId);
  const { uploadAttachment, deleteAttachment, downloadAttachment } = useAttachmentMutations(
    entityType,
    entityId
  );

  const attachments = attachmentsQuery.data?.attachments ?? [];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setValidationError(null);
    const check = validateAttachmentFile(file);
    if (!check.valid && "reason" in check) {
      let msg: string;
      if (check.reason === "empty") {
        msg = t("attachments.emptyFile", "Cannot upload an empty file.");
      } else if (check.reason === "too_large") {
        msg = t("attachments.fileTooLarge", "File exceeds the 10 MB maximum limit.");
      } else {
        msg = t("attachments.invalidType", {
          defaultValue: 'File type "{{type}}" is not allowed.',
          type: check.mimeType,
        });
      }
      setValidationError(msg);
      toast.error(msg);
      return;
    }

    try {
      await uploadAttachment.mutateAsync(file);
      toast.success(t("attachments.uploaded", "Attachment uploaded"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error", "Error");
      setValidationError(msg);
      toast.error(msg);
    }
  };

  const handleDownload = async (att: DocumentAttachmentDto) => {
    try {
      await downloadAttachment(att.id, att.fileName);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("attachments.downloadFailed", "Failed to download attachment")
      );
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAttachment.mutateAsync(deleteTarget.id);
      toast.success(t("attachments.deleted", "Attachment deleted"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error", "Error"));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <Card className={className} data-testid="attachments-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Paperclip className="h-4 w-4" />
            <span>{t("attachments.title", "Attachments")}</span>
            <Badge variant="secondary">{attachments.length}</Badge>
          </CardTitle>
          <CardDescription className="text-xs mt-1">
            {t("attachments.allowedHint", "PDF, PNG, JPEG, WEBP, CSV, XLSX, DOCX, or TXT up to 10 MB")}
          </CardDescription>
        </div>
        {canUpload && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={ATTACHMENT_ALLOWED_MIME_TYPES.join(",")}
              onChange={(e) => void handleFileChange(e)}
              data-testid="attachment-file-input"
            />
            <SubmitButton
              type="button"
              size="sm"
              variant="outline"
              pending={uploadAttachment.isPending}
              pendingText={t("attachments.uploading", "Uploading...")}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4 me-1.5" />
              {t("attachments.upload", "Upload File")}
            </SubmitButton>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {validationError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        {attachmentsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : attachments.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("attachments.empty", "No attachments yet.")}
          </p>
        ) : (
          <div className="divide-y rounded-md border">
            {attachments.map((att) => (
              <div key={att.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{att.fileName}</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                        {shortMimeBadge(att.mimeType)}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatFileSize(att.sizeBytes)} · {att.uploadedByName} ·{" "}
                      {att.createdAt.slice(0, 10)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("common.download", "Download")}
                    onClick={() => void handleDownload(att)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {canDelete && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t("common.delete", "Delete")}
                      onClick={() => setDeleteTarget(att)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title={t("attachments.deleteConfirmTitle", "Delete Attachment")}
        itemName={deleteTarget?.fileName}
      />
    </Card>
  );
}
