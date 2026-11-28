import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { toast } from "sonner";
import {
  emailDocumentSchema,
  type DocumentAttachmentDto,
  type EmailableDocumentType,
  type EmailDocumentResponseDto,
} from "@erp/shared";
import {
  useEmailDocumentMutation,
  usePrintTemplatesQuery,
} from "@/hooks/queries/usePrintTemplatesQueries";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export interface EmailDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentType: EmailableDocumentType;
  documentId: string;
  documentNumber?: string;
  defaultRecipient?: string;
  defaultSubject?: string;
  attachments?: DocumentAttachmentDto[];
  onSent?: (result: EmailDocumentResponseDto) => void;
}

function parseEmailList(raw: string): string[] {
  return raw
    .split(/[;,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function EmailDocumentDialog({
  open,
  onOpenChange,
  documentType,
  documentId,
  documentNumber,
  defaultRecipient = "",
  defaultSubject,
  attachments = [],
  onSent,
}: EmailDocumentDialogProps) {
  const { t } = useTranslation();
  const templatesQuery = usePrintTemplatesQuery(documentType, open);
  const emailMutation = useEmailDocumentMutation();

  const computedDefaultSubject =
    defaultSubject ?? `${documentType.replace(/_/g, " ").toUpperCase()} ${documentNumber ?? ""}`.trim();

  const [toRaw, setToRaw] = useState(defaultRecipient);
  const [ccRaw, setCcRaw] = useState("");
  const [subject, setSubject] = useState(computedDefaultSubject);
  const [message, setMessage] = useState("");
  const [attachStoredFiles, setAttachStoredFiles] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>("__default__");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setToRaw(defaultRecipient);
      setCcRaw("");
      setSubject(computedDefaultSubject);
      setMessage("");
      setAttachStoredFiles(false);
      setSelectedAttachmentIds([]);
      setTemplateId("__default__");
      setFormError(null);
    }
  }, [open, defaultRecipient, computedDefaultSubject]);

  const templates = templatesQuery.data?.templates ?? [];

  const toggleAttachment = (id: string) => {
    setSelectedAttachmentIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const toList = parseEmailList(toRaw);
    const ccList = parseEmailList(ccRaw);

    if (toList.length === 0) {
      setFormError(t("emailDocument.invalidRecipients", "Enter at least one valid email address."));
      return;
    }

    if (/[\r\n]/.test(subject) || !subject.trim()) {
      setFormError(t("emailDocument.invalidSubject", "Subject is required and cannot contain line breaks."));
      return;
    }

    const payload = {
      to: toList,
      cc: ccList,
      subject: subject.trim(),
      message: message.trim(),
      attachStoredFiles,
      attachmentIds: selectedAttachmentIds,
      ...(templateId !== "__default__" ? { templateId } : {}),
    };

    const parsed = emailDocumentSchema.safeParse(payload);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? t("emailDocument.invalidRecipients", "Enter at least one valid email address."));
      return;
    }

    try {
      const result = await emailMutation.mutateAsync({
        documentType,
        documentId,
        body: parsed.data,
      });
      toast.success(
        t("emailDocument.sentSuccess", {
          defaultValue: "Email sent to {{count}} recipient(s)",
          count: result.recipients.length,
        })
      );
      onSent?.(result);
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("common.error", "Error");
      setFormError(msg);
      toast.error(msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && emailMutation.isPending) return; onOpenChange(next); }}>
      <DialogContent locked={emailMutation.isPending} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            <span>{t("emailDocument.title", "Email Document")}</span>
          </DialogTitle>
          <DialogDescription>
            {t("emailDocument.description", {
              defaultValue: "Send {{document}} to one or more recipients.",
              document: documentNumber || documentType.replace(/_/g, " "),
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {formError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email-doc-to">{t("emailDocument.to", "Recipients (To)")}</Label>
            <Input
              id="email-doc-to"
              value={toRaw}
              onChange={(e) => setToRaw(e.target.value)}
              placeholder={t("emailDocument.toPlaceholder", "client@example.com, billing@example.com")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email-doc-cc">{t("emailDocument.cc", "CC (Optional)")}</Label>
            <Input
              id="email-doc-cc"
              value={ccRaw}
              onChange={(e) => setCcRaw(e.target.value)}
              placeholder={t("emailDocument.ccPlaceholder", "manager@example.com")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email-doc-subject">{t("emailDocument.subject", "Subject")}</Label>
            <Input
              id="email-doc-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("emailDocument.subjectPlaceholder", "Invoice #INV-0001")}
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email-doc-message">{t("emailDocument.message", "Message")}</Label>
            <Textarea
              id="email-doc-message"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("emailDocument.messagePlaceholder", "Please find the attached document...")}
              maxLength={5000}
            />
          </div>

          {templates.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="email-doc-template">{t("emailDocument.template", "Print Template")}</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="email-doc-template">
                  <SelectValue placeholder={t("emailDocument.defaultTemplate", "Default Template")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    {t("emailDocument.defaultTemplate", "Default Template")}
                  </SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="attach-stored-files" className="text-sm font-normal cursor-pointer">
              {t("emailDocument.attachStoredFiles", "Attach stored document files / PDF")}
            </Label>
            <Switch
              id="attach-stored-files"
              checked={attachStoredFiles}
              onCheckedChange={setAttachStoredFiles}
            />
          </div>

          {attachments.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t("emailDocument.selectAttachments", "Select stored attachments")}
              </p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {attachments.map((att) => (
                  <div key={att.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`email-att-${att.id}`}
                      checked={selectedAttachmentIds.includes(att.id)}
                      onCheckedChange={() => toggleAttachment(att.id)}
                    />
                    <Label htmlFor={`email-att-${att.id}`} className="truncate font-normal cursor-pointer">
                      {att.fileName}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={emailMutation.isPending} onClick={() => onOpenChange(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <SubmitButton
              type="submit"
              pending={emailMutation.isPending}
              pendingText={t("emailDocument.sending", "Sending...")}
            >
              {t("emailDocument.send", "Send Email")}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
