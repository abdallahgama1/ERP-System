import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Delete, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface PosCashierOption {
  id: string;
  name: string;
  email: string;
  role: string;
  hasPin: boolean;
}

interface PinLockOverlayProps {
  open: boolean;
  isHardLocked: boolean;
  cashiers: PosCashierOption[];
  activeCashierName: string;
  onUnlock: (pin: string, userId?: string) => Promise<void>;
  onCancel?: () => void;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"];

export function PinLockOverlay({
  open,
  isHardLocked,
  cashiers,
  activeCashierName,
  onUnlock,
  onCancel,
}: PinLockOverlayProps) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string>("auto");
  const [error, setError] = useState<string | null>(null);

  const unlockAction = useIdempotentAction(async () => {
    setError(null);
    await onUnlock(pin, selectedUserId === "auto" ? undefined : selectedUserId);
    setPin("");
  });
  const busy = unlockAction.isPending;

  if (!open) return null;

  const handleDigit = (key: string) => {
    setError(null);
    if (key === "C") {
      setPin("");
      return;
    }
    if (key === "⌫") {
      setPin((prev) => prev.slice(0, -1));
      return;
    }
    if (pin.length < 6) {
      setPin((prev) => prev + key);
    }
  };

  const handleSubmit = async () => {
    if (busy) return;
    if (pin.length < 4) {
      setError(t("pos.pinMinLength", "Enter a 4 to 6 digit PIN"));
      return;
    }
    try {
      await unlockAction.run();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pos.invalidPin", "Invalid cashier PIN"));
      setPin("");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="POS Terminal PIN Lock"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm p-4"
    >
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="text-center space-y-1">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            {isHardLocked ? <Lock className="h-6 w-6" /> : <KeyRound className="h-6 w-6" />}
          </div>
          <CardTitle>
            {isHardLocked
              ? t("pos.terminalLocked", "Register Locked")
              : t("pos.switchCashier", "Switch Cashier")}
          </CardTitle>
          <CardDescription>
            {t("pos.currentCashier", "Active")}: {activeCashierName}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {cashiers.length > 0 && (
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger aria-label="Select cashier">
                <SelectValue placeholder={t("pos.anyCashierByPin", "Match cashier by PIN")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("pos.anyCashierByPin", "Auto-detect cashier by PIN")}</SelectItem>
                {cashiers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.hasPin ? "" : "(no PIN)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Masked PIN dots */}
          <div className="flex justify-center gap-3 py-2" aria-label="PIN entry display">
            {[0, 1, 2, 3, 4, 5].map((idx) => (
              <div
                key={idx}
                className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${
                  idx < pin.length ? "bg-primary border-primary" : "border-muted-foreground/40"
                }`}
              />
            ))}
          </div>

          {error && <p className="text-xs text-center text-destructive font-medium">{error}</p>}

          <div className="grid grid-cols-3 gap-2">
            {DIGITS.map((key) => (
              <Button
                key={key}
                type="button"
                variant={key === "C" || key === "⌫" ? "secondary" : "outline"}
                className="h-12 text-lg font-semibold"
                disabled={busy}
                onClick={() => handleDigit(key)}
              >
                {key === "⌫" ? <Delete className="h-5 w-5" /> : key}
              </Button>
            ))}
          </div>

          <div className="flex gap-2 pt-1">
            {!isHardLocked && onCancel && (
              <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
              </Button>
            )}
            <SubmitButton
              type="button"
              className="flex-1 gap-2"
              pending={busy}
              disabled={pin.length < 4}
              onClick={() => void handleSubmit()}
            >
              <ShieldCheck className="h-4 w-4" />
              {t("pos.unlock", "Unlock")}
            </SubmitButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
