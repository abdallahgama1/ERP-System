import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { Product } from "@/types";

interface ScannedProductDisplayProps {
  product: Product;
  onConfirm: (quantity: number) => void | Promise<unknown>;
  onCancel: () => void;
}

export const ScannedProductDisplay = ({
  product,
  onConfirm,
  onCancel,
}: ScannedProductDisplayProps) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [quantity, setQuantity] = useState<string>("");
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (quantityInputRef.current) {
      quantityInputRef.current.focus();
    }
  }, []);

  const confirmAction = useIdempotentAction(async () => {
    const parsedQuantity = parseInt(quantity || "0", 10);

    if (isNaN(parsedQuantity) || parsedQuantity === 0) {
      toast({
        title: t("scanner.invalidQuantity"),
        description: t("scanner.quantityNotZero"),
        variant: "destructive",
      });
      return;
    }

    if (Math.abs(parsedQuantity) > 10000) {
      toast({
        title: t("scanner.quantityTooLarge"),
        description: t("scanner.quantityRange"),
        variant: "destructive",
      });
      return;
    }

    await onConfirm(parsedQuantity);
  });

  const handleConfirm = () => {
    void confirmAction.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowDown", "ArrowUp", "Insert"].includes(e.key)) {
      e.preventDefault();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm();
    }

    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const parsedQty = parseInt(quantity || "0", 10);

  return (
    <div className="p-6 border-2 border-primary rounded-lg bg-card">
      <div className="flex items-center gap-3 mb-4">
        <Package className="h-6 w-6 text-primary" />
        <h3 className="text-xl font-semibold">{t("scanner.scannedProduct")}</h3>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <Label className="text-muted-foreground text-sm">{t("scanner.productName")}</Label>
          <p className="text-lg font-medium">{product.product_name}</p>
        </div>

        <div>
          <Label className="text-muted-foreground text-sm">{t("scanner.skuLabel")}</Label>
          <p className="text-lg font-medium">{product.product_sku}</p>
        </div>

        <div>
          <Label className="text-muted-foreground text-sm">{t("scanner.sellingPrice")}</Label>
          <p className="text-lg font-medium">{formatMoney(product.sellingPrice, settings.currency)}</p>
        </div>

        <div>
          <Label className="text-muted-foreground text-sm">{t("scanner.costPrice")}</Label>
          <p className="text-lg font-medium">{formatMoney(product.costPrice, settings.currency)}</p>
        </div>
      </div>

      <div className="space-y-2 mb-6">
        <Label htmlFor="countedQuantity" className="text-lg font-medium">
          {t("scanner.countedQuantity")}
        </Label>
        <Input
          id="countedQuantity"
          ref={quantityInputRef}
          type="number"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("scanner.quantityPlaceholder")}
          className="h-14 text-2xl text-center font-bold"
          autoComplete="off"
        />
        <p className="text-sm text-muted-foreground">
          {t("scanner.negativeHint")}
        </p>
      </div>

      <div className="flex gap-3">
        <SubmitButton
          type="button"
          onClick={handleConfirm}
          pending={confirmAction.isPending}
          isSlow={confirmAction.isSlow}
          size="lg"
          className="flex-1"
        >
          {parsedQty >= 0 ? t("scanner.addToSession") : t("scanner.recordShortage")}
        </SubmitButton>
        <Button onClick={onCancel} disabled={confirmAction.isPending} variant="outline" size="lg">
          {t("scanner.cancel")}
        </Button>
      </div>
    </div>
  );
};
