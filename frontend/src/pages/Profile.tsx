import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import type { MfaEnrollResponseDto } from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { useMfaMutations, useMfaStatusQuery } from "@/hooks/queries/useMfaQueries";
import {
  useActiveSessionsQuery,
  useRevokeOtherSessionsMutation,
  useRevokeSessionMutation,
} from "@/hooks/queries/useSessionsMgmtQueries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy, KeyRound, Laptop, LogOut, Mail, RefreshCw, Shield, ShieldCheck, User } from "lucide-react";

export default function Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout, customRoleName } = useAuth();

  const mfaStatusQuery = useMfaStatusQuery();
  const { enrollMfa, verifyEnrollMfa, disableMfa, regenerateRecoveryCodes } = useMfaMutations();
  const sessionsQuery = useActiveSessionsQuery();
  const revokeSession = useRevokeSessionMutation();
  const revokeOtherSessions = useRevokeOtherSessionsMutation();
  const rowLocks = useActionLocks();

  const [enrollment, setEnrollment] = useState<MfaEnrollResponseDto | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodesDisplay, setRecoveryCodesDisplay] = useState<string[] | null>(null);

  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [regenDialogOpen, setRegenDialogOpen] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");

  const mfaStatus = mfaStatusQuery.data;
  const isMfaEnabled = Boolean(mfaStatus?.enabled ?? user?.mfaEnabled);
  const sessions = sessionsQuery.data?.sessions ?? [];
  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  useEffect(() => {
    let active = true;
    if (!enrollment?.otpauthUrl) {
      setQrDataUrl(null);
      return;
    }
    void import("qrcode")
      .then((QRCode) => QRCode.toDataURL(enrollment.otpauthUrl, { width: 192, margin: 1 }))
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [enrollment?.otpauthUrl]);

  const getInitials = (name: string) =>
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

  const getRoleLabel = (role?: string) => {
    if (customRoleName) return customRoleName;
    switch (role) {
      case "admin":
        return t("users.admin");
      case "manager":
        return t("users.manager");
      default:
        return t("users.user");
    }
  };

  const handleStartEnroll = async () => {
    try {
      const res = await enrollMfa.mutateAsync();
      setEnrollment(res);
      setTotpCode("");
      setRecoveryCodesDisplay(res.recoveryCodes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleVerifyEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpCode.trim()) return;
    try {
      await verifyEnrollMfa.mutateAsync({ code: totpCode.trim() });
      toast.success(t("mfa.enabledSuccess", "Two-factor authentication enabled"));
      setEnrollment(null);
      setTotpCode("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("mfa.invalidCode", "Invalid verification code"));
    }
  };

  const handleDisableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmPassword) return;
    try {
      await disableMfa.mutateAsync({ password: confirmPassword });
      toast.success(t("mfa.disabledSuccess", "Two-factor authentication disabled"));
      setDisableDialogOpen(false);
      setConfirmPassword("");
      setRecoveryCodesDisplay(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleRegenerateCodes = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmPassword) return;
    try {
      const res = await regenerateRecoveryCodes.mutateAsync({ password: confirmPassword });
      setRecoveryCodesDisplay(res.recoveryCodes);
      toast.success(t("mfa.recoveryRegenerated", "Recovery codes regenerated. Save them safely."));
      setRegenDialogOpen(false);
      setConfirmPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleRevokeSession = async (sessionId: string, isCurrent: boolean) => {
    try {
      await revokeSession.mutateAsync(sessionId);
      toast.success(t("sessionsMgmt.revoked", "Session revoked"));
      if (isCurrent) {
        await logout();
        navigate("/login");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleRevokeOthers = async () => {
    try {
      const res = await revokeOtherSessions.mutateAsync();
      toast.success(
        t("sessionsMgmt.revokedOthers", {
          defaultValue: "Revoked {{count}} other session(s)",
          count: res.revokedCount ?? otherSessionsCount,
        })
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      toast.success(`${label} copied`);
    });
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("profile.title")}</h1>
        <p className="text-muted-foreground">{t("profile.description")}</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t("profile.personalInfo")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <Avatar className="h-24 w-24 border-4 border-border">
                <AvatarImage src={undefined} alt={user?.name || "User"} />
                <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">
                  {user?.name ? getInitials(user.name) : "U"}
                </AvatarFallback>
              </Avatar>

              <div className="space-y-4 flex-1">
                <div className="flex items-center gap-3">
                  <User className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t("profile.fullName")}</p>
                    <p className="font-medium">{user?.name || t("profile.unknownUser")}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t("profile.emailAddress")}</p>
                    <p className="font-medium">{user?.email || t("profile.noEmail")}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t("common.role")}</p>
                    <Badge variant="secondary" className="capitalize">
                      {getRoleLabel(user?.role)}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("profile.accountStatus")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t("profile.accountStatus")}</span>
              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">
                {t("common.active")}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t("profile.emailVerified")}</span>
              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">
                {t("profile.verified")}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t("profile.twoFactorAuth")}</span>
              <Badge variant={isMfaEnabled ? "default" : "outline"} data-testid="profile-mfa-status">
                {isMfaEnabled ? t("profile.enabled", "Enabled") : t("profile.disabled")}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Two-Factor Authentication Card */}
        <Card data-testid="profile-mfa-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              {t("profile.twoFactorAuth", "Two-Factor Authentication (2FA)")}
            </CardTitle>
            <CardDescription>
              {t(
                "mfa.description",
                "Protect your account with an RFC 6238 TOTP authenticator app and single-use recovery codes."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isMfaEnabled ? (
              <div className="space-y-4">
                <div className="rounded-md border p-3 text-sm space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t("common.status", "Status")}</span>
                    <Badge>{t("profile.enabled", "Enabled")}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {t("mfa.recoveryCodesRemaining", "Recovery codes remaining")}
                    </span>
                    <span className="font-mono font-medium">
                      {mfaStatus?.recoveryCodesRemaining ?? 0}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setConfirmPassword("");
                      setRegenDialogOpen(true);
                    }}
                  >
                    <RefreshCw className="h-4 w-4 me-2" />
                    {t("mfa.regenerateRecoveryCodes", "Regenerate Recovery Codes")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setConfirmPassword("");
                      setDisableDialogOpen(true);
                    }}
                  >
                    {t("mfa.disable2fa", "Disable 2FA")}
                  </Button>
                </div>
              </div>
            ) : enrollment ? (
              <div className="space-y-4">
                {qrDataUrl && (
                  <div className="flex justify-center">
                    <img
                      src={qrDataUrl}
                      alt="TOTP QR Code"
                      className="rounded-md border p-2 bg-white"
                      width={192}
                      height={192}
                    />
                  </div>
                )}
                <div className="space-y-1.5 text-xs">
                  <Label>{t("mfa.setupUri", "Authenticator Setup Secret / URI")}</Label>
                  <div className="flex items-center gap-2">
                    <Input value={enrollment.secretMasked} readOnly className="font-mono text-xs" />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => copyText(enrollment.otpauthUrl, "Authenticator URI")}
                      aria-label={t("common.copy", "Copy")}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <form onSubmit={handleVerifyEnroll} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="mfa-verify-code">
                      {t("mfa.enterCodeToVerify", "Enter 6-digit verification code")}
                    </Label>
                    <Input
                      id="mfa-verify-code"
                      inputMode="numeric"
                      placeholder="000000"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value)}
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <SubmitButton type="submit" size="sm" pending={verifyEnrollMfa.isPending}>
                      {t("mfa.verifyAndEnable", "Verify & Enable")}
                    </SubmitButton>
                    <Button type="button" variant="ghost" size="sm" disabled={verifyEnrollMfa.isPending} onClick={() => setEnrollment(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </form>
              </div>
            ) : (
              <SubmitButton type="button" onClick={() => void handleStartEnroll()} pending={enrollMfa.isPending}>
                <KeyRound className="h-4 w-4 me-2" />
                {t("mfa.setup2fa", "Enable Two-Factor Auth")}
              </SubmitButton>
            )}

            {recoveryCodesDisplay && recoveryCodesDisplay.length > 0 && (
              <Alert data-testid="mfa-recovery-codes">
                <KeyRound className="h-4 w-4" />
                <AlertTitle>{t("mfa.saveRecoveryCodes", "Save your recovery codes")}</AlertTitle>
                <AlertDescription className="space-y-2 mt-2">
                  <p className="text-xs">
                    {t(
                      "mfa.recoveryHint",
                      "Each code can be used once if you lose access to your authenticator device."
                    )}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 font-mono text-xs bg-muted/60 p-2 rounded">
                    {recoveryCodesDisplay.map((code) => (
                      <span key={code}>{code}</span>
                    ))}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(recoveryCodesDisplay.join("\n"), "Recovery codes")}
                  >
                    <Copy className="h-3.5 w-3.5 me-1.5" />
                    {t("mfa.copyAllCodes", "Copy All Codes")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Active Sessions Card */}
        <Card className="md:col-span-2" data-testid="profile-sessions-card">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Laptop className="h-5 w-5 text-primary" />
                {t("sessionsMgmt.title", "Active Sessions")}
              </CardTitle>
              <CardDescription>
                {t("sessionsMgmt.description", "Manage devices and browsers currently signed into your account.")}
              </CardDescription>
            </div>
            <SubmitButton
              type="button"
              variant="outline"
              size="sm"
              pending={revokeOtherSessions.isPending}
              disabled={otherSessionsCount === 0}
              onClick={() => void handleRevokeOthers()}
            >
              <LogOut className="h-4 w-4 me-2" />
              {t("sessionsMgmt.revokeAllOthers", "Revoke All Other Sessions")}
            </SubmitButton>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sessionsMgmt.device", "Device / Agent")}</TableHead>
                  <TableHead>{t("sessionsMgmt.ipAddress", "IP Address")}</TableHead>
                  <TableHead>{t("sessionsMgmt.lastActivity", "Last Active")}</TableHead>
                  <TableHead>{t("sessionsMgmt.created", "Signed In")}</TableHead>
                  <TableHead className="text-end">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      {t("common.loading")}
                    </TableCell>
                  </TableRow>
                ) : sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                      {t("sessionsMgmt.empty", "No active sessions found.")}
                    </TableCell>
                  </TableRow>
                ) : (
                  sessions.map((sess) => (
                    <TableRow key={sess.id}>
                      <TableCell className="max-w-[260px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {sess.userAgent || t("sessionsMgmt.unknownDevice", "Unknown device")}
                          </span>
                          {sess.isCurrent && (
                            <Badge variant="default" className="shrink-0">
                              {t("sessionsMgmt.currentSession", "Current session")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {sess.ipAddress || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(new Date(sess.lastActivityAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(new Date(sess.createdAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-end">
                        <SubmitButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          hideSlowText
                          className="text-destructive hover:text-destructive"
                          pending={rowLocks.isPending(`revoke:${sess.id}`)}
                          onClick={() =>
                            void rowLocks.runLocked(`revoke:${sess.id}`, () =>
                              handleRevokeSession(sess.id, sess.isCurrent)
                            )
                          }
                        >
                          {t("sessionsMgmt.revoke", "Revoke")}
                        </SubmitButton>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Disable 2FA Dialog */}
      <Dialog open={disableDialogOpen} onOpenChange={(o) => { if (!o && disableMfa.isPending) return; setDisableDialogOpen(o); }}>
        <DialogContent locked={disableMfa.isPending}>
          <DialogHeader>
            <DialogTitle>{t("mfa.disable2fa", "Disable Two-Factor Authentication")}</DialogTitle>
            <DialogDescription>
              {t("mfa.confirmPasswordDisable", "Enter your account password to disable 2FA.")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleDisableMfa} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="disable-mfa-password">{t("common.password")}</Label>
              <Input
                id="disable-mfa-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={disableMfa.isPending} onClick={() => setDisableDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <SubmitButton type="submit" variant="destructive" pending={disableMfa.isPending}>
                {t("mfa.disable2fa", "Disable 2FA")}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Regenerate Recovery Codes Dialog */}
      <Dialog open={regenDialogOpen} onOpenChange={(o) => { if (!o && regenerateRecoveryCodes.isPending) return; setRegenDialogOpen(o); }}>
        <DialogContent locked={regenerateRecoveryCodes.isPending}>
          <DialogHeader>
            <DialogTitle>{t("mfa.regenerateRecoveryCodes", "Regenerate Recovery Codes")}</DialogTitle>
            <DialogDescription>
              {t(
                "mfa.confirmPasswordRegen",
                "Enter your password to invalidate existing recovery codes and generate 8 new ones."
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRegenerateCodes} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="regen-mfa-password">{t("common.password")}</Label>
              <Input
                id="regen-mfa-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={regenerateRecoveryCodes.isPending} onClick={() => setRegenDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <SubmitButton type="submit" pending={regenerateRecoveryCodes.isPending}>
                {t("mfa.regenerate", "Regenerate")}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
