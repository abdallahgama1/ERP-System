import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export default function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { signup } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const signupAction = useIdempotentAction(async () => {
    const { needsConfirmation } = await signup(name, email, password);
    if (needsConfirmation) {
      toast.success(t("auth.confirmEmailSent"));
      navigate("/login");
    } else {
      toast.success(t("auth.accountCreated"));
      navigate("/");
    }
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signupAction.isPending) return;

    if (password.length < 8) {
      toast.error(t("settings.passwordMinLength", "Password must be at least 8 characters."));
      return;
    }

    if (password !== confirmPassword) {
      toast.error(t("auth.passwordsNoMatch"));
      return;
    }

    try {
      await signupAction.run();
    } catch (error: unknown) {
      const apiMsg = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const errMsg = error instanceof Error ? error.message : "";
      toast.error(apiMsg || errMsg || t("auth.signupFailed"));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/20 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">{t("auth.createAccount")}</CardTitle>
          <CardDescription className="text-center">{t("auth.signUpDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t("common.name")}</Label>
              <Input
                id="name"
                type="text"
                placeholder={t("auth.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t("common.email")}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t("auth.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("common.password")}</Label>
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
              <Label htmlFor="confirmPassword">{t("auth.confirmPassword")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            <SubmitButton
              type="submit"
              className="w-full"
              pending={signupAction.isPending}
              pendingText={t("auth.creatingAccount")}
            >
              {t("auth.signUp")}
            </SubmitButton>
          </form>
          <div className="mt-4 text-center text-sm">
            {t("auth.haveAccount")}{" "}
            <Link to="/login" className="text-primary hover:underline">
              {t("auth.signIn")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
