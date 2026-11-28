import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation, useActionLocks } from "@/hooks/useIdempotentSubmit";
import type {
  EinvoiceQueueSummaryDto,
  EinvoiceSubmissionStatus,
  EtaSubmissionDetailDto,
  EtaSubmissionListItemDto,
  OffsetPageInfo,
} from "@erp/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileCode2,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TablePagination } from "@/components/TablePagination";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";

interface EinvoiceQueueListResponse {
  items: EtaSubmissionListItemDto[];
  submissions: EtaSubmissionListItemDto[];
  summary: EinvoiceQueueSummaryDto;
  pageInfo: OffsetPageInfo;
}

const DEFAULT_SUMMARY: EinvoiceQueueSummaryDto = {
  pending: 0,
  submitted: 0,
  accepted: 0,
  rejected: 0,
  failed: 0,
  total: 0,
  etaConfigured: false,
};

function getStatusBadgeVariant(status: EinvoiceSubmissionStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "accepted":
      return "default";
    case "rejected":
    case "failed":
      return "destructive";
    case "submitted":
      return "outline";
    default:
      return "secondary";
  }
}

function extractEtaValidationLines(responsePayload: Record<string, unknown> | null | undefined): string[] {
  if (!responsePayload || typeof responsePayload !== "object") return [];
  const rejected = Array.isArray(responsePayload.rejectedDocuments)
    ? responsePayload.rejectedDocuments
    : [];
  const lines: string[] = [];
  for (const doc of rejected) {
    if (!doc || typeof doc !== "object") continue;
    const err = (doc as Record<string, unknown>).error as Record<string, unknown> | undefined;
    const details = Array.isArray(err?.details) ? err.details : [];
    if (details.length > 0) {
      for (const d of details) {
        if (!d || typeof d !== "object") continue;
        const item = d as Record<string, unknown>;
        const code = typeof item.code === "string" && item.code.trim() ? `[${item.code.trim()}] ` : "";
        const loc =
          (typeof item.propertyPath === "string" && item.propertyPath.trim()) ||
          (typeof item.target === "string" && item.target.trim()) ||
          "";
        const msg =
          (typeof item.message === "string" && item.message.trim()) ||
          (typeof err?.message === "string" ? err.message.trim() : "");
        if (msg) lines.push(`${code}${loc ? `${loc}: ` : ""}${msg}`);
      }
    } else if (typeof err?.message === "string" && err.message.trim()) {
      lines.push(err.message.trim());
    }
  }
  return lines;
}

function formatRetryTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

export default function EInvoiceQueue() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [selectedItem, setSelectedItem] = useState<EtaSubmissionListItemDto | null>(null);
  const rowLocks = useActionLocks();

  const queryParams = {
    status: statusFilter,
    q: searchQuery.trim(),
    page,
    pageSize: 25,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: erpQueryKeys.einvoicing.submissions(queryParams),
    queryFn: () => {
      const searchParams = new URLSearchParams();
      if (statusFilter && statusFilter !== "all") {
        searchParams.set("status", statusFilter);
      }
      if (searchQuery.trim()) {
        searchParams.set("q", searchQuery.trim());
      }
      searchParams.set("page", String(page));
      searchParams.set("pageSize", "25");
      const qs = searchParams.toString();
      return apiRequest<EinvoiceQueueListResponse>(
        `/api/einvoicing/submissions${qs ? `?${qs}` : ""}`
      );
    },
  });

  const { data: detailData, isLoading: loadingDetail } = useQuery({
    queryKey: erpQueryKeys.einvoicing.detail(selectedItem?.id ?? ""),
    queryFn: () =>
      apiRequest<{ submission?: EtaSubmissionDetailDto } & EtaSubmissionDetailDto>(
        `/api/einvoicing/submissions/${selectedItem!.id}`
      ),
    enabled: Boolean(selectedItem?.id),
  });

  const resolvedDetail: EtaSubmissionDetailDto | null = detailData
    ? (detailData.submission ?? detailData)
    : null;

  const invalidateQueue = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.einvoicing.all });
  };

  const processNowMutation = useMutation({
    mutationFn: () =>
      apiRequest<{
        skipped: boolean;
        reason?: string;
        processed: number;
        accepted: number;
        rejected: number;
        failed: number;
        etaConfigured: boolean;
      }>("/api/einvoicing/submissions/process-now", {
        method: "POST",
        body: {},
      }),
    onSuccess: (res) => {
      invalidateQueue();
      if (res.skipped && res.reason === "eta_not_configured") {
        toast({
          title: t("einvoicing.unconfiguredTitle", "ETA Egypt API Credentials Not Configured"),
          description: t(
            "einvoicing.unconfiguredDesc",
            "ETA OAuth client credentials are not configured on this server. E-Receipts remain safely queued locally."
          ),
        });
      } else {
        toast({
          title: t("einvoicing.processedToast", "ETA Queue Processed"),
          description: `Processed: ${res.processed} (Accepted: ${res.accepted}, Rejected: ${res.rejected}, Failed: ${res.failed})`,
        });
      }
    },
    onError: (err) => {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    },
  });

  const retrySingleMutation = useMutation({
    mutationFn: (submissionId: string) =>
      apiRequest<{
        queued: number;
        processed: number;
        etaConfigured: boolean;
        message: string;
      }>(`/api/einvoicing/submissions/${submissionId}/retry`, {
        method: "POST",
        body: { resetAttempts: true },
      }),
    onSuccess: (res) => {
      invalidateQueue();
      toast({
        title: t("einvoicing.retryQueuedToast", "Submission Queued for Retry"),
        description: res.message,
      });
    },
    onError: (err) => {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    },
  });

  const retryAllMutation = useMutation({
    mutationFn: () =>
      apiRequest<{
        queued: number;
        processed: number;
        etaConfigured: boolean;
        message: string;
      }>("/api/einvoicing/submissions/retry", {
        method: "POST",
        body: { resetAttempts: true },
      }),
    onSuccess: (res) => {
      invalidateQueue();
      toast({
        title: t("einvoicing.retryQueuedToast", "Submissions Queued for Retry"),
        description: res.message,
      });
    },
    onError: (err) => {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    },
  });

  const submissions = data?.items ?? data?.submissions ?? [];
  const summary = data?.summary ?? DEFAULT_SUMMARY;
  const pageInfo = data?.pageInfo;
  const effectiveDetailError = resolvedDetail?.lastError ?? selectedItem?.lastError ?? null;
  const effectiveDetailNextRetry = resolvedDetail?.nextRetryAt ?? selectedItem?.nextRetryAt ?? null;
  const structuredEtaErrors = extractEtaValidationLines(resolvedDetail?.responsePayloadJson);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-7 w-7 text-primary" />
            {t("einvoicing.title", "E-Invoicing & ETA Queue")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t(
              "einvoicing.description",
              "Monitor Egyptian Tax Authority (ETA e-Receipt v1.2) sale ('S') and return ('R') submissions, inspect payloads, and trigger manual polling or retries."
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {(summary.failed > 0 || summary.rejected > 0) && (
            <SubmitButton
              type="button"
              variant="outline"
              data-testid="retry-all-failed-btn"
              pending={retryAllMutation.isPending}
              onClick={() => retryAllMutation.mutate()}
            >
              <RotateCcw className="h-4 w-4 me-2" />
              {t("einvoicing.retryAll", "Retry Failed & Rejected")}
            </SubmitButton>
          )}
          <SubmitButton
            type="button"
            variant="default"
            pending={processNowMutation.isPending}
            onClick={() => processNowMutation.mutate()}
          >
            <RefreshCw className="h-4 w-4 me-2" />
            {t("einvoicing.processNow", "Process Queue / Poll ETA")}
          </SubmitButton>
        </div>
      </div>

      {!summary.etaConfigured && (
        <div
          role="status"
          data-testid="eta-unconfigured-banner"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
        >
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-amber-900 dark:text-amber-200">
              {t("einvoicing.unconfiguredTitle", "ETA Egypt API Credentials Not Configured")}
            </div>
            <p className="text-amber-800/90 dark:text-amber-300/90 mt-0.5">
              {t(
                "einvoicing.unconfiguredDesc",
                "ETA OAuth client credentials are not configured on this server. E-Receipts ('S' Sales and 'R' Returns) are safely queued locally in pending status until credentials are provided."
              )}
            </p>
          </div>
        </div>
      )}

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center justify-between">
              <span>Pending</span>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="kpi-pending">
              {summary.pending}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center justify-between">
              <span>Submitted</span>
              <Send className="h-4 w-4 text-blue-500" />
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="kpi-submitted">
              {summary.submitted}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center justify-between">
              <span>Accepted</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="kpi-accepted">
              {summary.accepted}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center justify-between">
              <span>Rejected</span>
              <XCircle className="h-4 w-4 text-destructive" />
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="kpi-rejected">
              {summary.rejected}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center justify-between">
              <span>Failed</span>
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </CardDescription>
            <CardTitle className="text-2xl font-mono" data-testid="kpi-failed">
              {summary.failed}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filters & Queue Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder={t("einvoicing.searchPlaceholder", "Search document #, UUID, or error...")}
                className="ps-9"
              />
            </div>

            <div className="flex items-center gap-3">
              <Select
                value={statusFilter}
                onValueChange={(val) => {
                  setStatusFilter(val);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-52" aria-label="Status filter">
                  <span className="text-muted-foreground me-1">Status:</span>
                  <SelectValue placeholder={t("einvoicing.allStatuses", "All Statuses")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="accepted">Accepted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-muted-foreground">
              {t("common.loading", "Loading...")}
            </div>
          ) : submissions.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {t("einvoicing.empty", "No e-invoice or e-receipt submissions found.")}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document #</TableHead>
                    <TableHead>Receipt Type</TableHead>
                    <TableHead>Document UUID</TableHead>
                    <TableHead className="text-end">Total</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>{t("einvoicing.etaErrorAndRetry", "ETA Error / Next Retry")}</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submissions.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono font-medium">
                        {item.documentNumber ?? "—"}
                        {item.branchName && (
                          <div className="text-xs font-sans text-muted-foreground">
                            {item.branchName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          {item.etaDocumentTypeCode === "I" ? (
                            <Badge variant="outline" className="border-blue-500/50 text-blue-700 dark:text-blue-300">
                              {t("einvoicing.b2bInvoice", "I · Invoice")}
                            </Badge>
                          ) : item.etaDocumentTypeCode === "C" ? (
                            <Badge variant="outline" className="border-purple-500/50 text-purple-700 dark:text-purple-300">
                              {t("einvoicing.b2bCreditNote", "C · Credit Note")}
                            </Badge>
                          ) : item.etaDocumentTypeCode === "D" ? (
                            <Badge variant="outline" className="border-indigo-500/50 text-indigo-700 dark:text-indigo-300">
                              {t("einvoicing.b2bDebitNote", "D · Debit Note")}
                            </Badge>
                          ) : item.receiptType === "R" ? (
                            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-300">
                              {t("einvoicing.returnReceipt", "R · Return")}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-emerald-500/50 text-emerald-700 dark:text-emerald-300">
                              {t("einvoicing.saleReceipt", "S · Sale")}
                            </Badge>
                          )}
                          {item.documentType === "invoice" && item.signatureStatus && (
                            <span className="text-[11px] text-muted-foreground font-mono">
                              {item.signatureStatus === "signed"
                                ? "Signed CAdES-BES"
                                : item.signatureStatus === "unsigned_v0_9"
                                  ? "v0.9 Unsigned"
                                  : "Awaiting Signer"}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[180px] truncate" title={item.documentUuid}>
                        {item.documentUuid}
                      </TableCell>
                      <TableCell className="text-end font-mono">
                        {item.totalAmount !== null
                          ? formatMoney(item.totalAmount, item.currency ?? "EGP")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(item.status)}>
                          {item.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[300px]">
                        {item.lastError ? (
                          <div
                            data-testid="submission-error-text"
                            className="text-xs text-destructive whitespace-normal break-words leading-snug"
                            title={item.lastError}
                          >
                            {item.lastError}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        {item.nextRetryAt && item.status !== "accepted" && item.status !== "rejected" && (
                          <div
                            data-testid="submission-next-retry"
                            className="text-[11px] text-muted-foreground font-mono mt-1 flex items-center gap-1"
                          >
                            <Clock className="h-3 w-3 shrink-0" />
                            <span>
                              {t("einvoicing.nextRetry", "Next retry")}: {formatRetryTimestamp(item.nextRetryAt)}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {item.attempts}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedItem(item)}
                          >
                            <Eye className="h-3.5 w-3.5 me-1" />
                            {t("einvoicing.viewPayload", "View Payload")}
                          </Button>
                          {item.status !== "accepted" && (
                            <SubmitButton
                              type="button"
                              size="sm"
                              variant="ghost"
                              hideSlowText
                              pending={rowLocks.isPending(`retry:${item.id}`)}
                              onClick={() =>
                                void rowLocks.runLocked(`retry:${item.id}`, () =>
                                  retrySingleMutation.mutateAsync(item.id)
                                )
                              }
                            >
                              <RotateCcw className="h-3.5 w-3.5 me-1" />
                              {t("einvoicing.retry", "Retry")}
                            </SubmitButton>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <TablePagination
                pageInfo={pageInfo}
                onPageChange={(nextPage) => setPage(nextPage)}
              />
            </>
          )}
          {isFetching && !isLoading && (
            <div className="text-xs text-muted-foreground text-end mt-2">
              Refreshing...
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payload Inspection Modal */}
      <Dialog
        open={Boolean(selectedItem)}
        onOpenChange={(open) => {
          if (!open) setSelectedItem(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCode2 className="h-5 w-5 text-primary" />
              {t("einvoicing.payloadDialogTitle", "E-Receipt Submission Payload")} ·{" "}
              <span className="font-mono">{selectedItem?.documentNumber ?? "Receipt"}</span>
            </DialogTitle>
            <DialogDescription>
              documentUuid:{" "}
              <span className="font-mono text-xs break-all">
                {selectedItem?.documentUuid}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 rounded-md border p-3 bg-muted/40">
              <div>
                <span className="text-muted-foreground">Document:</span>{" "}
                <span className="font-mono font-medium">
                  {selectedItem?.documentNumber ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Document Type:</span>{" "}
                <span className="font-mono font-medium">
                  {selectedItem?.etaDocumentTypeCode === "I"
                    ? "I (B2B Invoice)"
                    : selectedItem?.etaDocumentTypeCode === "C"
                      ? "C (Credit Note)"
                      : selectedItem?.etaDocumentTypeCode === "D"
                        ? "D (Debit Note)"
                        : selectedItem?.receiptType === "R"
                          ? "R (POS Return)"
                          : "S (POS Sale)"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span>{" "}
                <span className="font-medium">{selectedItem?.status}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Submission UUID:</span>{" "}
                <span className="font-mono text-xs">
                  {resolvedDetail?.submissionUuid ?? selectedItem?.submissionUuid ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">{t("einvoicing.nextRetry", "Next retry")}:</span>{" "}
                <span className="font-mono text-xs">
                  {formatRetryTimestamp(effectiveDetailNextRetry) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Attempts:</span>{" "}
                <span className="font-mono text-xs">
                  {resolvedDetail?.attempts ?? selectedItem?.attempts ?? 0}
                </span>
              </div>
            </div>

            {(effectiveDetailError || structuredEtaErrors.length > 0) && (
              <div
                data-testid="detail-eta-error"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive space-y-2"
              >
                {effectiveDetailError && (
                  <div className="break-words">
                    <strong>{t("einvoicing.etaErrorLabel", "ETA Error")}:</strong> {effectiveDetailError}
                  </div>
                )}
                {structuredEtaErrors.length > 0 && (
                  <div data-testid="detail-eta-validation-errors">
                    <div className="font-semibold mb-1">
                      {t("einvoicing.etaValidationDetails", "ETA Validation Details")}:
                    </div>
                    <ul className="list-disc ps-4 space-y-0.5 font-mono">
                      {structuredEtaErrors.map((line, idx) => (
                        <li key={idx} className="break-words">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div>
              <h4 className="font-semibold mb-1.5">
                {t("einvoicing.requestPayload", "Canonical Request Payload (ETA v1.2)")}
              </h4>
              {loadingDetail && !resolvedDetail ? (
                <div className="rounded-md bg-muted p-4 text-xs font-mono">
                  Loading receipt payload for {selectedItem?.documentNumber} ({selectedItem?.documentUuid})...
                </div>
              ) : (
                <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto max-h-72">
                  {JSON.stringify(resolvedDetail?.requestPayloadJson ?? {}, null, 2)}
                </pre>
              )}
            </div>

            <div>
              <h4 className="font-semibold mb-1.5">
                {t("einvoicing.responsePayload", "ETA Gateway Response Payload")}
              </h4>
              {resolvedDetail?.responsePayloadJson ? (
                <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto max-h-56">
                  {JSON.stringify(resolvedDetail.responsePayloadJson, null, 2)}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {t("einvoicing.noResponseYet", "No remote response recorded yet (queued locally).")}
                </p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
