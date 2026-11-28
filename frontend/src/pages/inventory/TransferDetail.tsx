import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Send, PackageCheck, Ban, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { toast } from "sonner";
import { format } from "date-fns";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuditRecorder } from "@/hooks/queries/useAuditLogsCursorQuery";
import type { TransferShortageResolution, TransferStatus } from "@/types";

const statusVariant: Record<TransferStatus, "default" | "secondary" | "destructive" | "outline"> = {
  Draft: "outline",
  "In Transit": "secondary",
  Received: "default",
  Cancelled: "destructive",
};

export default function TransferDetail() {
  const { t } = useTranslation();
  const { transferId } = useParams();
  const navigate = useNavigate();
  const { transfers, dispatchTransfer, receiveTransfer, cancelTransfer } = useInventoryScope({ transfers: true, products: true, directoryBranches: true });
  const { user } = useAuth();
  const { can } = usePermissions();
  const { record } = useAuditRecorder();

  const transfer = transfers.find((x) => x.id === transferId);
  const [receivedMap, setReceivedMap] = useState<Record<string, number>>({});
  const [shortageResolution, setShortageResolution] = useState<
    Exclude<TransferShortageResolution, "none"> | ""
  >("");
  const [cancelOpen, setCancelOpen] = useState(false);

  const initialReceived = useMemo(() => {
    if (!transfer) return {};
    const out: Record<string, number> = {};
    transfer.items.forEach((i) => {
      out[i.id] = i.quantity;
    });
    return out;
  }, [transfer]);

  const dispatchAction = useIdempotentAction(async () => {
    if (!transfer) return;
    const res = await dispatchTransfer(transfer.id, user?.name);
    if (!res.ok) {
      toast.error(res.error);
      return res;
    }
    record("transfers", `Transfer ${transfer.reference} dispatched`, {
      entity: "Transfer",
      entityId: transfer.reference,
      user: user?.name,
    });
    toast.success(t("transfers.dispatched", "Transfer dispatched"));
    return { ok: true };
  });

  const receiveAction = useIdempotentAction(async () => {
    if (!transfer) return;
    const shortage =
      transfer.status === "In Transit" &&
      transfer.items.some((i) => (receivedMap[i.id] ?? initialReceived[i.id] ?? i.quantity) < i.quantity);
    if (shortage && !shortageResolution) {
      toast.error(
        t(
          "transfers.shortageResolutionRequired",
          "Select how to handle short-received quantities before receiving.",
        ),
      );
      return;
    }
    const receivedByProduct: Record<string, number> = {};
    for (const i of transfer.items) {
      receivedByProduct[i.productId] = receivedMap[i.id] ?? initialReceived[i.id] ?? i.quantity;
    }
    const res = await receiveTransfer(
      transfer.id,
      receivedByProduct,
      shortage && shortageResolution ? shortageResolution : undefined,
      user?.name,
    );
    if (!res.ok) {
      toast.error(res.error);
      return res;
    }
    record("transfers", `Transfer ${transfer.reference} received`, {
      entity: "Transfer",
      entityId: transfer.reference,
      user: user?.name,
      meta: shortage ? { shortageResolution } : undefined,
    });
    toast.success(t("transfers.received", "Transfer received"));
    return { ok: true };
  });

  if (!transfer) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t("transfers.notFound", "Transfer not found")}</p>
        <Button variant="outline" asChild className="mt-4">
          <Link to="/inventory/transfers">
            <ArrowLeft className="h-4 w-4 me-2" />
            {t("common.back")}
          </Link>
        </Button>
      </div>
    );
  }

  const hasShortage =
    transfer.status === "In Transit" &&
    transfer.items.some((i) => (receivedMap[i.id] ?? initialReceived[i.id] ?? i.quantity) < i.quantity);

  const onCancel = async () => {
    const res = await cancelTransfer(transfer.id, user?.name);
    setCancelOpen(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    record("transfers", `Transfer ${transfer.reference} cancelled`, {
      entity: "Transfer",
      entityId: transfer.reference,
      user: user?.name,
    });
    toast.success(t("transfers.cancelled", "Transfer cancelled"));
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/inventory/transfers")}>
            <ArrowLeft className="h-4 w-4 me-2" />
            {t("common.back")}
          </Button>
          <h1 className="text-2xl font-bold">{transfer.reference}</h1>
          <Badge variant={statusVariant[transfer.status]}>
            {t(`transfers.status.${transfer.status}`, transfer.status)}
          </Badge>
        </div>
        <div className="flex gap-2">
          {transfer.status === "Draft" && can("inventory", "edit") && (
            <SubmitButton
              type="button"
              pending={dispatchAction.isPending}
              isSlow={dispatchAction.isSlow}
              onClick={() => void dispatchAction.run()}
            >
              <Send className="h-4 w-4 me-2" />
              {t("transfers.dispatch", "Dispatch")}
            </SubmitButton>
          )}
          {transfer.status === "In Transit" && can("inventory", "edit") && (
            <SubmitButton
              type="button"
              pending={receiveAction.isPending}
              isSlow={receiveAction.isSlow}
              onClick={() => void receiveAction.run()}
            >
              <PackageCheck className="h-4 w-4 me-2" />
              {t("transfers.receive", "Receive")}
            </SubmitButton>
          )}
          {(transfer.status === "Draft" || transfer.status === "In Transit") && can("inventory", "delete") && (
            <Button
              variant="destructive"
              disabled={dispatchAction.isPending || receiveAction.isPending}
              onClick={() => setCancelOpen(true)}
            >
              <Ban className="h-4 w-4 me-2" />
              {t("transfers.cancel", "Cancel")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("transfers.source", "Source")}</div>
          <div className="font-semibold mt-1">{transfer.sourceBranchName}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("transfers.destination", "Destination")}</div>
          <div className="font-semibold mt-1">{transfer.destBranchName}</div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("transfers.created", "Created")}</div>
          <div className="font-semibold mt-1 text-sm">
            {format(new Date(transfer.createdAt), "MMM d, yyyy HH:mm")}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">{t("transfers.createdBy", "Created by")}</div>
          <div className="font-semibold mt-1">{transfer.createdBy || "—"}</div>
        </Card>
      </div>

      <Card className="p-4 space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("movements.product")}</TableHead>
              <TableHead className="text-right">{t("transfers.dispatched", "Dispatched")}</TableHead>
              <TableHead className="text-right">{t("transfers.receivedQty", "Received Qty")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transfer.items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="font-medium">{i.product_name}</div>
                  <div className="text-xs text-muted-foreground">{i.product_sku}</div>
                </TableCell>
                <TableCell className="text-right font-mono">{i.quantity}</TableCell>
                <TableCell className="text-right">
                  {transfer.status === "In Transit" ? (
                    <Input
                      type="number"
                      min={0}
                      max={i.quantity}
                      className="w-24 ms-auto text-right"
                      value={receivedMap[i.id] ?? i.quantity}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(i.quantity, raw)) : 0;
                        setReceivedMap({ ...receivedMap, [i.id]: clamped });
                      }}
                    />
                  ) : (
                    <span className="font-mono">{i.receivedQty}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {hasShortage && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              {t(
                "transfers.shortageDetected",
                "Received quantity is less than dispatched quantity. Choose how to reconcile the missing units:",
              )}
            </div>
            <div className="max-w-sm space-y-1">
              <Label>{t("transfers.shortageDisposition", "Shortage Disposition")} *</Label>
              <Select
                value={shortageResolution}
                onValueChange={(v) =>
                  setShortageResolution(v as Exclude<TransferShortageResolution, "none">)
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("transfers.selectDisposition", "Select disposition...")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="return_to_source">
                    {t(
                      "transfers.returnToSource",
                      "Return missing units to source branch",
                    )}
                  </SelectItem>
                  <SelectItem value="write_off_in_transit">
                    {t(
                      "transfers.writeOffInTransit",
                      "Write off missing units as in-transit loss",
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {transfer.shortageResolution && transfer.shortageResolution !== "none" && (
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("transfers.shortageDisposition", "Shortage Disposition")}:
            </span>{" "}
            {transfer.shortageResolution === "return_to_source"
              ? t("transfers.returnToSource", "Return missing units to source branch")
              : t("transfers.writeOffInTransit", "Write off missing units as in-transit loss")}
          </div>
        )}

        {transfer.notes && (
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{t("common.note", "Note")}:</span>{" "}
            {transfer.notes}
          </div>
        )}
      </Card>

      <ConfirmDeleteDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={onCancel}
        title={t("transfers.cancelTitle", "Cancel this transfer?")}
        description={t("transfers.cancelDesc", "Any in-transit goods will be returned to the source branch.")}
      />
    </div>
  );
}
