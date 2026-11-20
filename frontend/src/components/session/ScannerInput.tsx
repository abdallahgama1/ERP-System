import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Scan, Search, X, Camera, CameraOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Product } from "@/types";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { feedback } from "@/lib/feedback";

interface ScannerInputProps {
  onProductScanned: (product: Product) => void;
  products: Product[];
  disabled?: boolean;
}

interface SearchSuggestion {
  productId: string;
  productName: string;
  sku: string;
}

export const ScannerInput = ({
  onProductScanned,
  products,
  disabled = false,
}: ScannerInputProps) => {
  const { t } = useTranslation();
  const [skuInput, setSkuInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<SearchSuggestion[]>([]);
  const skuInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const [isScanning, setIsScanning] = useState(false);
  const scannerBuffer = useRef("");
  const scannerTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanDelay = 100;

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  useEffect(() => {
    if (searchQuery.trim() && products.length > 0) {
      const filtered = products
        .filter(
          (product) =>
            product.product_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            product.product_sku.toLowerCase().includes(searchQuery.toLowerCase())
        )
        .slice(0, 10)
        .map((product) => ({
          productId: product.productId,
          productName: product.product_name,
          sku: product.product_sku,
        }));

      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setFilteredSuggestions([]);
      setShowSuggestions(false);
    }
  }, [searchQuery, products]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        !searchRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Global keydown listener for scanner
  useEffect(() => {
    if (disabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F10") {
        event.preventDefault();
        return;
      }

      // Ignore events from input fields
      if (
        event.target instanceof HTMLInputElement &&
        (event.target.id === "productSearch" || event.target.id === "skuInput")
      ) {
        return;
      }

      if (event.key.length === 1 || event.key === "Enter") {
        setIsScanning(true);
        scannerBuffer.current += event.key;

        if (scannerTimeout.current) {
          clearTimeout(scannerTimeout.current);
        }

        scannerTimeout.current = setTimeout(() => {
          const finalInput = scannerBuffer.current;
          scannerBuffer.current = "";
          setIsScanning(false);
          processScannerInput(finalInput);
        }, scanDelay);
      } else {
        setIsScanning(false);
        scannerBuffer.current = "";
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (scannerTimeout.current) {
        clearTimeout(scannerTimeout.current);
      }
    };
  }, [disabled]);

  const processScannerInput = (input: string) => {
    let cleanedInput = input.replace(/Enter/g, "");
    cleanedInput = cleanedInput.trim();
    cleanedInput = cleanedInput.replace(/[^a-zA-Z0-9-]/g, "");

    if (cleanedInput.length > 0) {
      setSkuInput(cleanedInput);
      handleScan(cleanedInput);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleScan(skuInput);
  };

  const handleScan = (sku: string) => {
    const trimmedSku = sku.trim().toUpperCase();

    if (!trimmedSku) {
      feedback.error();
      toast({
        title: t("scanner.invalidInput"),
        description: t("scanner.enterSkuFirst"),
        variant: "destructive",
      });
      return;
    }

    if (trimmedSku.length < 2) {
      feedback.error();
      toast({
        title: t("scanner.invalidSku"),
        description: t("scanner.skuMinLength"),
        variant: "destructive",
      });
      return;
    }

    const matchedProduct = products.find(
      (product) => product.product_sku.toUpperCase() === trimmedSku
    );

    if (!matchedProduct) {
      feedback.error();
      toast({
        title: t("scanner.productNotFound"),
        description: t("scanner.noProductWithSku", { sku: trimmedSku }),
        variant: "destructive",
      });
      return;
    }

    feedback.success();
    onProductScanned(matchedProduct);
    setSkuInput("");
    setSearchQuery("");
  };

  const handleSuggestionClick = (suggestion: SearchSuggestion) => {
    setSkuInput(suggestion.sku);
    setSearchQuery("");
    setShowSuggestions(false);
    skuInputRef.current?.focus();
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    if (value && skuInput) {
      setSkuInput("");
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setShowSuggestions(false);
    searchRef.current?.focus();
  };

  useEffect(() => {
    if (!disabled) {
      skuInputRef.current?.focus();
    }
  }, [disabled]);

  // Stop camera whenever it's toggled off, unmounted, or disabled
  const stopCamera = () => {
    try {
      controlsRef.current?.stop();
    } catch {
      // ignore
    }
    controlsRef.current = null;
  };

  useEffect(() => {
    if (!cameraOn) {
      stopCamera();
      return;
    }
    if (disabled) return;

    let cancelled = false;
    setCameraError(null);
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    (async () => {
      try {
        const videoEl = videoRef.current;
        if (!videoEl) return;
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoEl,
          (result) => {
            if (!result) return;
            const code = result.getText();
            const now = Date.now();
            // Debounce duplicates from continuous scan
            if (
              code === lastScanRef.current.code &&
              now - lastScanRef.current.at < 1500
            ) {
              return;
            }
            lastScanRef.current = { code, at: now };
            handleScan(code);
          }
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("scanner.cameraError");
        setCameraError(message);
        setCameraOn(false);
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, disabled]);

  useEffect(() => () => stopCamera(), []);

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-card">
      {/* Search by Product Name */}
      <div className="relative">
        <Label htmlFor="productSearch" className="text-sm font-medium">
          {t("scanner.searchByName")}
        </Label>
        <div className="relative mt-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="productSearch"
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder={t("scanner.searchPlaceholder")}
            className="ps-10 pe-10 h-12 text-lg"
            autoComplete="off"
            disabled={disabled}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Suggestions Dropdown */}
        {showSuggestions && (
          <div
            ref={suggestionsRef}
            className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-60 overflow-auto"
          >
            {filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion.productId}
                type="button"
                onClick={() => handleSuggestionClick(suggestion)}
                className="w-full px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none border-b border-border last:border-b-0"
              >
                <div className="font-medium">{suggestion.productName}</div>
                <div className="text-sm text-muted-foreground">{suggestion.sku}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* OR Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-border" />
        <span className="text-sm text-muted-foreground">{t("scanner.or")}</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Scanner Input */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="flex gap-2">
          <div className="flex-1">
            <Label htmlFor="skuInput" className="text-sm font-medium">
              {t("scanner.scannerInput")}
            </Label>
            <Input
              id="skuInput"
              ref={skuInputRef}
              type="text"
              value={skuInput}
              onChange={(e) => setSkuInput(e.target.value)}
              placeholder={t("scanner.skuPlaceholder")}
              className="mt-1 h-12 text-lg"
              autoComplete="off"
              disabled={disabled}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" size="lg" className="h-12" disabled={disabled}>
              <Scan className="me-2 h-4 w-4" />
              {t("scanner.scanProduct")}
            </Button>
          </div>
        </div>
      </form>

      {isScanning && (
        <div className="text-sm text-muted-foreground animate-pulse">
          {t("scanner.scanning")}
        </div>
      )}

      {/* Camera scan mode */}
      <div className="pt-2 border-t">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm font-medium">{t("scanner.cameraMode")}</Label>
          <Button
            type="button"
            variant={cameraOn ? "destructive" : "secondary"}
            size="sm"
            onClick={() => setCameraOn((v) => !v)}
            disabled={disabled}
          >
            {cameraOn ? (
              <>
                <CameraOff className="me-2 h-4 w-4" />
                {t("scanner.stopCamera")}
              </>
            ) : (
              <>
                <Camera className="me-2 h-4 w-4" />
                {t("scanner.startCamera")}
              </>
            )}
          </Button>
        </div>
        {cameraOn && (
          <div className="relative rounded-md overflow-hidden bg-black aspect-video">
            <video
              ref={videoRef}
              className="w-full h-full object-cover"
              playsInline
              muted
            />
            <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-0.5 bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
          </div>
        )}
        {cameraError && (
          <p className="text-xs text-destructive mt-1">{cameraError}</p>
        )}
        {cameraOn && (
          <p className="text-xs text-muted-foreground mt-1">
            {t("scanner.pointCameraAtBarcode")}
          </p>
        )}
      </div>
    </div>
  );
};
