import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [isSendingReset, setIsSendingReset] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await login(email, password);
      toast.success(t("auth.welcomeBack"));
      navigate("/");
    } catch (error: unknown) {
      const apiMsg = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const errMsg = error instanceof Error ? error.message : "";
      toast.error(apiMsg || errMsg || t("auth.loginFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) return;
    setIsSendingReset(true);
    try {
      await apiRequest<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
        method: "POST",
        body: { email: resetEmail.trim() },
      });
      toast.success(
        t(
          "auth.resetLinkRequested",
          "If an active account matches this email, a reset link was generated. Contact an administrator if you need a direct link."
        )
      );
      setForgotMode(false);
      setResetEmail("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setIsSendingReset(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/20 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">
            {forgotMode ? t("auth.resetPassword") : t("auth.signIn")}
          </CardTitle>
          <CardDescription className="text-center">
            {forgotMode ? t("auth.resetPasswordDescription") : t("auth.signInDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {forgotMode ? (
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
              <Button type="submit" className="w-full" disabled={isSendingReset}>
                {isSendingReset ? t("auth.signingIn") : t("auth.sendResetLink")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
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
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? t("auth.signingIn") : t("auth.signIn")}
                </Button>
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
