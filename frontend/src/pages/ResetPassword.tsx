import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const tokenFromUrl = searchParams.get("token")?.trim() ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenFromUrl) {
      toast.error(t("auth.resetMissingToken", "Password reset token is missing from the URL."));
      return;
    }
    if (password.length < 8) {
      toast.error(t("settings.passwordMinLength"));
      return;
    }
    if (password !== confirm) {
      toast.error(t("auth.passwordsNoMatch"));
      return;
    }

    setSaving(true);
    try {
      await apiRequest<{ ok: boolean }>("/api/auth/reset-password", {
        method: "POST",
        body: { token: tokenFromUrl, newPassword: password },
      });
      toast.success(t("settings.passwordUpdated"));
      navigate("/login");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/20 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">{t("auth.resetPassword")}</CardTitle>
          <CardDescription className="text-center">
            {tokenFromUrl
              ? t("auth.chooseNewPassword", "Enter a new password for your account.")
              : t(
                  "auth.resetLinkInvalid",
                  "Open the full password reset link provided by your administrator or request a reset token from the sign-in page."
                )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokenFromUrl ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">{t("settings.newPassword")}</Label>
                <Input
                  id="password"
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">{t("auth.confirmPassword")}</Label>
                <Input
                  id="confirm"
                  type="password"
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? t("common.saving", "Saving...") : t("settings.updatePassword")}
              </Button>
            </form>
          ) : (
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">{t("auth.signIn")}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
