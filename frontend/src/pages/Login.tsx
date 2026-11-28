import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const { login, mfaRequired, verifyMfaLogin, clearMfaChallenge } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const loginAction = useIdempotentAction(async () => {
    const result = await login(email, password);
    if (result.mfaRequired) {
      setMfaCode("");
      return;
    }
    toast.success(t("auth.welcomeBack"));
    navigate("/");
  });

  const verifyMfaAction = useIdempotentAction(async (cleaned: string) => {
    await verifyMfaLogin(cleaned);
    toast.success(t("auth.welcomeBack"));
    navigate("/");
  });

  const forgotAction = useIdempotentAction(async (targetEmail: string) => {
    await apiRequest<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: { email: targetEmail },
    });
    toast.success(
      t(
        "auth.resetLinkRequested",
        "If an active account matches this email, a reset link was generated. Contact an administrator if you need a direct link."
      )
    );
    setForgotMode(false);
    setResetEmail("");
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginAction.isPending) return;
    try {
      await loginAction.run();
    } catch (error: unknown) {
      const apiMsg = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const errMsg = error instanceof Error ? error.message : "";
      toast.error(apiMsg || errMsg || t("auth.loginFailed"));
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifyMfaAction.isPending) return;
    const cleaned = mfaCode.trim();
    if (!cleaned) return;
    try {
      await verifyMfaAction.run(cleaned);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : "";
      toast.error(errMsg || t("mfa.invalidCode", "Invalid verification or recovery code"));
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (forgotAction.isPending) return;
    if (!resetEmail.trim()) return;
    try {
      await forgotAction.run(resetEmail.trim());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/20 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center flex items-center justify-center gap-2">
            {mfaRequired && <ShieldCheck className="h-6 w-6 text-primary" />}
            {mfaRequired
              ? t("mfa.challengeTitle", "Two-Factor Verification")
              : forgotMode
                ? t("auth.resetPassword")
                : t("auth.signIn")}
          </CardTitle>
          <CardDescription className="text-center">
            {mfaRequired
              ? t(
                  "mfa.challengeDescription",
                  "Enter the 6-digit code from your authenticator app or a single-use recovery code."
                )
              : forgotMode
                ? t("auth.resetPasswordDescription")
                : t("auth.signInDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mfaRequired ? (
            <form onSubmit={handleVerifyMfa} className="space-y-4" data-testid="mfa-challenge-form">
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t("mfa.verificationCode", "Verification Code")}</Label>
                <Input
                  id="mfa-code"
                  name="mfaCode"
                  type="text"
                  autoComplete="one-time-code"
                  placeholder={t("mfa.codePlaceholder", "000000 or recovery code")}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <SubmitButton
                type="submit"
                className="w-full"
                pending={verifyMfaAction.isPending}
                pendingText={t("mfa.verifying", "Verifying...")}
              >
                {t("mfa.verifyAndContinue", "Verify & Continue")}
              </SubmitButton>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={verifyMfaAction.isPending}
                onClick={() => {
                  clearMfaChallenge();
                  setMfaCode("");
                }}
              >
                {t("auth.backToSignIn", "Back to Sign In")}
              </Button>
            </form>
          ) : forgotMode ? (
            <form onSubmit={handleForgot} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email">{t("common.email")}</Label>
                <Input
                  id="reset-email"
                  type="email"
                  placeholder="john.doe@example.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
              </div>
              <SubmitButton
                type="submit"
                className="w-full"
                pending={forgotAction.isPending}
                pendingText={t("auth.signingIn")}
              >
                {t("auth.sendResetLink")}
              </SubmitButton>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={forgotAction.isPending}
                onClick={() => setForgotMode(false)}
              >
                {t("auth.signIn")}
              </Button>
            </form>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("common.email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="john.doe@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">{t("common.password")}</Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setForgotMode(true)}
                    >
                      {t("auth.forgotPassword")}
                    </button>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <SubmitButton
                  type="submit"
                  className="w-full"
                  pending={loginAction.isPending}
                  pendingText={t("auth.signingIn")}
                >
                  {t("auth.signIn")}
                </SubmitButton>
              </form>
              <div className="mt-4 text-center text-sm">
                {t("auth.noAccount")}{" "}
                <Link to="/signup" className="text-primary hover:underline">
                  {t("auth.signUp")}
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
