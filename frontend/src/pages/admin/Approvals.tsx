import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppRole, ApprovalEntityType } from "@erp/shared";
import { CheckCircle2, ClipboardCheck, ShieldAlert, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import {
  useApprovalMutations,
  useApprovalRequestsQuery,
  useApprovalRulesQuery,
  type ApprovalRequestDto,
  type ApprovalRuleDto,
} from "@/hooks/queries/useApprovalsQueries";

export default function Approvals() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { role } = usePermissions();
  const { settings } = useSettings();

  const { data: requests = [], isLoading: loadingRequests } = useApprovalRequestsQuery();
  const { data: rules = [], isLoading: loadingRules } = useApprovalRulesQuery();
  const { upsertRule, decideRequest } = useApprovalMutations();
  const rowLocks = useActionLocks();

  const [decisionTarget, setDecisionTarget] = useState<{
    req: ApprovalRequestDto;
    decision: "approved" | "rejected";
  } | null>(null);
  const [comment, setComment] = useState("");
  const [ruleDrafts, setRuleDrafts] = useState<
    Record<string, { minAmount: string; requiredRole: AppRole; isActive: boolean }>
  >({});

  const isAdmin = role === "admin";
  const canReview = role === "admin" || role === "manager";
  const pendingCount = useMemo(
    () => requests.filter((r) => r.status === "pending").length,
    [requests]
  );

  const getDraft = (rule: ApprovalRuleDto) =>
    ruleDrafts[rule.entityType] ?? {
      minAmount: String(rule.minAmount),
      requiredRole: rule.requiredRole,
      isActive: rule.isActive,
    };

  const setDraft = (
    entityType: ApprovalEntityType,
    rule: ApprovalRuleDto,
    patch: Partial<{ minAmount: string; requiredRole: AppRole; isActive: boolean }>
  ) => {
    const cur = getDraft(rule);
    setRuleDrafts((prev) => ({ ...prev, [entityType]: { ...cur, ...patch } }));
  };

  const handleSaveRule = async (rule: ApprovalRuleDto) => {
    const draft = getDraft(rule);
    try {
      await upsertRule.mutateAsync({
        entityType: rule.entityType,
        minAmount: Math.max(0, Number(draft.minAmount) || 0),
        requiredRole: draft.requiredRole,
        isActive: draft.isActive,
        description: rule.description,
      });
      toast({ title: t("approvals.ruleSaved", "Approval rule updated") });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleConfirmDecision = async () => {
    if (!decisionTarget) return;
    try {
      await decideRequest.mutateAsync({
        id: decisionTarget.req.id,
        decision: decisionTarget.decision,
        comment: comment.trim(),
      });
      toast({
        title:
          decisionTarget.decision === "approved"
            ? t("approvals.approvedToast", "Request approved and posted")
            : t("approvals.rejectedToast", "Request rejected"),
      });
      setDecisionTarget(null);
      setComment("");
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardCheck className="h-7 w-7 text-primary" />
          {t("approvals.title", "Approvals & Controls")}
        </h1>
        <p className="text-muted-foreground">
          {t(
            "approvals.description",
            "Review pending operational requests under maker-checker rules and configure monetary thresholds."
          )}
        </p>
      </div>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">
            {t("approvals.queueTab", "Approval Queue")} ({pendingCount})
          </TabsTrigger>
          <TabsTrigger value="rules">
            {t("approvals.rulesTab", "Threshold Rules")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <Card>
            <CardHeader>
              <CardTitle>{t("approvals.requestsTitle", "Approval Requests")}</CardTitle>
              <CardDescription>
                {t(
                  "approvals.requestsDesc",
                  "Approved items execute and post to inventory and GL atomically."
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingRequests ? (
                <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
              ) : requests.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">
                  {t("approvals.noRequests", "No approval requests yet.")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("approvals.document", "Document")}</TableHead>
                      <TableHead>{t("approvals.type", "Type")}</TableHead>
                      <TableHead>{t("approvals.requestedBy", "Requested By")}</TableHead>
                      <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                      <TableHead>{t("approvals.reviewedBy", "Reviewed By")}</TableHead>
                      <TableHead className="text-end">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {requests.map((req) => (
                      <TableRow key={req.id}>
                        <TableCell className="font-mono font-medium">{req.entityNumber}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {t(`approvals.entities.${req.entityType}`, req.entityType.replace(/_/g, " "))}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div>{req.requestedByName || "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(req.requestedAt).toLocaleString()}
                          </div>
                        </TableCell>
                        <TableCell className="text-end font-mono font-medium">
                          {formatMoney(req.amount, settings.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              req.status === "approved"
                                ? "default"
                                : req.status === "rejected"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {t(`approvals.statuses.${req.status}`, req.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {req.reviewedByName ? (
                            <div>
                              <div className="text-sm">{req.reviewedByName}</div>
                              {req.decisionComment && (
                                <div className="text-xs text-muted-foreground">{req.decisionComment}</div>
                              )}
                            </div>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          {canReview && req.status === "pending" && (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => {
                                  setDecisionTarget({ req, decision: "approved" });
                                  setComment("");
                                }}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 me-1" />
                                {t("approvals.approve", "Approve")}
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                  setDecisionTarget({ req, decision: "rejected" });
                                  setComment("");
                                }}
                              >
                                <XCircle className="h-3.5 w-3.5 me-1" />
                                {t("approvals.reject", "Reject")}
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" />
                {t("approvals.rulesTitle", "Approval Threshold Rules")}
              </CardTitle>
              <CardDescription>
                {t(
                  "approvals.rulesDesc",
                  "Documents reaching or exceeding an active rule's threshold enter the pending approval queue."
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingRules ? (
                <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("approvals.type", "Document Type")}</TableHead>
                      <TableHead className="w-40">{t("approvals.minAmount", "Min Amount")}</TableHead>
                      <TableHead className="w-40">{t("approvals.requiredRole", "Approver Role")}</TableHead>
                      <TableHead className="w-24">{t("common.active")}</TableHead>
                      <TableHead className="w-28 text-end">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => {
                      const draft = getDraft(rule);
                      return (
                        <TableRow key={rule.id}>
                          <TableCell>
                            <div className="font-medium">
                              {t(`approvals.entities.${rule.entityType}`, rule.entityType.replace(/_/g, " "))}
                            </div>
                            <div className="text-xs text-muted-foreground">{rule.description}</div>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              disabled={!isAdmin}
                              value={draft.minAmount}
                              onChange={(e) =>
                                setDraft(rule.entityType, rule, { minAmount: e.target.value })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              disabled={!isAdmin}
                              value={draft.requiredRole}
                              onValueChange={(val) =>
                                setDraft(rule.entityType, rule, { requiredRole: val as AppRole })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="manager">Manager / Admin</SelectItem>
                                <SelectItem value="admin">Admin Only</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Switch
                              disabled={!isAdmin}
                              checked={draft.isActive}
                              onCheckedChange={(checked) =>
                                setDraft(rule.entityType, rule, { isActive: checked })
                              }
                            />
                          </TableCell>
                          <TableCell className="text-end">
                            {isAdmin && (
                              <SubmitButton
                                type="button"
                                size="sm"
                                variant="outline"
                                hideSlowText
                                pending={rowLocks.isPending(`rule:${rule.id}`)}
                                onClick={() => void rowLocks.runLocked(`rule:${rule.id}`, () => handleSaveRule(rule))}
                              >
                                {t("common.save")}
                              </SubmitButton>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!decisionTarget} onOpenChange={(open) => { if (!open && !decideRequest.isPending) setDecisionTarget(null); }}>
        <DialogContent locked={decideRequest.isPending} className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decisionTarget?.decision === "approved"
                ? t("approvals.confirmApprove", "Approve Request")
                : t("approvals.confirmReject", "Reject Request")}{" "}
              {decisionTarget?.req.entityNumber}
            </DialogTitle>
            <DialogDescription>
              {decisionTarget?.decision === "approved"
                ? t("approvals.approveDesc", "This will immediately post the document and any inventory/GL effects.")
                : t("approvals.rejectDesc", "The document will be marked rejected and will not post stock or GL entries.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="approval-comment">{t("approvals.comment", "Decision Comment")}</Label>
            <Textarea
              id="approval-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder={t("approvals.commentPlaceholder", "Optional audit note")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={decideRequest.isPending} onClick={() => setDecisionTarget(null)}>
              {t("common.cancel")}
            </Button>
            <SubmitButton
              type="button"
              variant={decisionTarget?.decision === "approved" ? "default" : "destructive"}
              pending={decideRequest.isPending}
              onClick={() => void handleConfirmDecision()}
            >
              {decisionTarget?.decision === "approved"
                ? t("approvals.approve", "Approve")
                : t("approvals.reject", "Reject")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
