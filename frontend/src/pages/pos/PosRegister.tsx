import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Barcode,
  Calculator,
  CloudOff,
  CreditCard,
  KeyRound,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
  User as UserIcon,
  Wifi,
} from "lucide-react";
import {
  calculateLineAmounts,
  roundCurrency,
  type PosCashMovementType,
  type PosCheckoutInput,
  type PosPaymentMethod,
} from "@erp/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useToast } from "@/hooks/use-toast";
import { matchProductByScanCode, useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import { apiRequest } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import { feedback } from "@/lib/feedback";
import {
  listOfflineOutbox,
  loadPosCatalogCache,
  loadPosState,
  savePosCatalogCache,
  savePosState,
  type PosCatalogCustomer,
  type PosCatalogProduct,
  type PosReceiptPreview,
} from "@/lib/pos/posDb";
import { enqueueOfflineSale, flushPosOutbox } from "@/lib/pos/outboxManager";
import { SplitTenderDialog } from "@/components/pos/SplitTenderDialog";
import { ShiftReconciliationDialog, type PosShiftDto } from "@/components/pos/ShiftReconciliationDialog";
import { ThermalReceiptPrintView } from "@/components/pos/ThermalReceiptPrintView";
import { PinLockOverlay, type PosCashierOption } from "@/components/pos/PinLockOverlay";
import type { User } from "@/types";

interface PosTerminalDto {
  id: string;
  branchId: string;
  branchName: string;
  code: string;
  name: string;
  isActive: boolean;
  receiptHeader: string;
  receiptFooter: string;
  paperWidthMm: number;
  defaultCustomerId: string | null;
  activeShift: PosShiftDto | null;
}

interface CartLine {
  product: PosCatalogProduct;
  quantity: number;
  discount: number;
}

export default function PosRegister() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user, posSession, applyPosSessionUpdate } = useAuth();
  const { branches, activeBranchId } = useBranch();
  const { can } = usePermissions();
  const { settings, companyMeta } = useSettings();

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [terminals, setTerminals] = useState<PosTerminalDto[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>("");
  const [activeShift, setActiveShift] = useState<PosShiftDto | null>(null);
  const [products, setProducts] = useState<PosCatalogProduct[]>([]);
  const [customers, setCustomers] = useState<PosCatalogCustomer[]>([]);
  const [cashiers, setCashiers] = useState<PosCashierOption[]>([]);
  const [catalogMeta, setCatalogMeta] = useState<{
    currency: string;
    companyName: string;
    taxRegistrationNumber: string;
    syncedAt: string;
  }>({
    currency: settings.currency || "USD",
    companyName: companyMeta?.companyName || "Count It Keep It",
    taxRegistrationNumber: "",
    syncedAt: "",
  });

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [outboxCount, setOutboxCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  const [tenderOpen, setTenderOpen] = useState(false);
  const [shiftDialogOpen, setShiftDialogOpen] = useState(false);
  const [pinOverlayOpen, setPinOverlayOpen] = useState(false);
  const [setPinOpen, setSetPinOpen] = useState(false);
  const [newPinValue, setNewPinValue] = useState("");
  const [createTermOpen, setCreateTermOpen] = useState(false);
  const [newTermCode, setNewTermCode] = useState("REG-01");
  const [newTermName, setNewTermName] = useState("Front Counter Register 1");
  const [newTermBranchId, setNewTermBranchId] = useState("");
  const [lastReceipt, setLastReceipt] = useState<PosReceiptPreview | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedTerminal = useMemo(
    () => terminals.find((term) => term.id === selectedTerminalId) ?? null,
    [selectedTerminalId, terminals]
  );

  const isHardLocked = Boolean(posSession?.isLocked);
  const currency = catalogMeta.currency || settings.currency || "USD";
  const fmt = useCallback((n: number) => formatMoney(n, currency), [currency]);

  // Monitor online/offline state
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const refreshOutboxCount = useCallback(async (termId?: string) => {
    try {
      const items = await listOfflineOutbox(termId || undefined);
      setOutboxCount(items.length);
    } catch {
      // ignore idb errors in restricted contexts
    }
  }, []);

  // Load terminals on mount (or cached terminal when offline)
  const loadTerminals = useCallback(async () => {
    try {
      const res = await apiRequest<{ terminals: PosTerminalDto[] }>("/api/pos/terminals");
      setTerminals(res.terminals);
      await savePosState("terminals", res.terminals);

      const savedTermId = await loadPosState<string>("selected_terminal_id");
      const preferred =
        res.terminals.find((term) => term.id === (posSession?.terminalId || savedTermId)) ??
        res.terminals[0];
      if (preferred) {
        setSelectedTerminalId(preferred.id);
        setActiveShift(preferred.activeShift);
        await savePosState("selected_terminal_id", preferred.id);
        if (preferred.activeShift) {
          await savePosState(`active_shift:${preferred.id}`, preferred.activeShift);
        }
      }
    } catch {
      const cachedTerms = await loadPosState<PosTerminalDto[]>("terminals");
      const savedTermId = await loadPosState<string>("selected_terminal_id");
      if (cachedTerms && cachedTerms.length > 0) {
        setTerminals(cachedTerms);
        const preferred = cachedTerms.find((term) => term.id === savedTermId) ?? cachedTerms[0];
        setSelectedTerminalId(preferred.id);
        const cachedShift = await loadPosState<PosShiftDto>(`active_shift:${preferred.id}`);
        setActiveShift(cachedShift ?? preferred.activeShift ?? null);
      }
    }
  }, [posSession?.terminalId]);

  useEffect(() => {
    if (user && !isHardLocked) {
      void loadTerminals();
    }
  }, [isHardLocked, loadTerminals, user]);

  // Set default branch for terminal creation modal
  useEffect(() => {
    if (!newTermBranchId && branches.length > 0) {
      const def =
        (activeBranchId !== "all" ? branches.find((b) => b.id === activeBranchId) : undefined) ??
        branches.find((b) => b.isDefault) ??
        branches[0];
      if (def) setNewTermBranchId(def.id);
    }
  }, [activeBranchId, branches, newTermBranchId]);

  // Load catalog + active shift + cashiers when terminal changes
  const loadTerminalContext = useCallback(
    async (term: PosTerminalDto) => {
      await refreshOutboxCount(term.id);
      try {
        await apiRequest("/api/pos/terminal/bind", {
          method: "POST",
          body: { terminalId: term.id },
        });
        const [catalogRes, shiftRes, cashiersRes] = await Promise.all([
          apiRequest<{
            branchId: string;
            currency: string;
            einvoicingMode: string;
            companyName: string;
            taxRegistrationNumber: string;
            syncedAt: string;
            products: PosCatalogProduct[];
            customers: PosCatalogCustomer[];
          }>(`/api/pos/catalog?branchId=${term.branchId}`),
          apiRequest<{ shift: PosShiftDto | null }>(`/api/pos/shifts/active?terminalId=${term.id}`),
          apiRequest<{ cashiers: PosCashierOption[] }>(`/api/pos/cashiers?branchId=${term.branchId}`),
        ]);

        setProducts(catalogRes.products);
        setCustomers(catalogRes.customers);
        setCashiers(cashiersRes.cashiers);
        setActiveShift(shiftRes.shift);
        setCatalogMeta({
          currency: catalogRes.currency,
          companyName: catalogRes.companyName,
          taxRegistrationNumber: catalogRes.taxRegistrationNumber,
          syncedAt: catalogRes.syncedAt,
        });

        const defaultCust =
          catalogRes.customers.find((c) => c.id === term.defaultCustomerId) ??
          catalogRes.customers.find((c) => c.isWalkIn) ??
          catalogRes.customers[0];
        if (defaultCust) setSelectedCustomerId(defaultCust.id);

        await savePosCatalogCache(catalogRes.products, catalogRes.customers, {
          branchId: catalogRes.branchId,
          currency: catalogRes.currency,
          einvoicingMode: catalogRes.einvoicingMode,
          companyName: catalogRes.companyName,
          taxRegistrationNumber: catalogRes.taxRegistrationNumber,
          syncedAt: catalogRes.syncedAt,
        });
        await savePosState(`active_shift:${term.id}`, shiftRes.shift);
      } catch {
        // Offline fallback from IndexedDB
        const cached = await loadPosCatalogCache();
        if (cached.products.length > 0) {
          setProducts(cached.products);
          setCustomers(cached.customers);
          if (cached.meta) {
            setCatalogMeta({
              currency: cached.meta.currency,
              companyName: cached.meta.companyName,
              taxRegistrationNumber: cached.meta.taxRegistrationNumber,
              syncedAt: cached.meta.syncedAt,
            });
          }
          const defaultCust =
            cached.customers.find((c) => c.isWalkIn) ?? cached.customers[0];
          if (defaultCust) setSelectedCustomerId(defaultCust.id);
        }
        const cachedShift = await loadPosState<PosShiftDto | null>(`active_shift:${term.id}`);
        if (cachedShift) setActiveShift(cachedShift);
      }
    },
    [refreshOutboxCount]
  );

  useEffect(() => {
    if (selectedTerminal && !isHardLocked) {
      void loadTerminalContext(selectedTerminal);
    }
  }, [isHardLocked, loadTerminalContext, selectedTerminal]);

  // Flush offline outbox cleanly
  const handleSyncOutbox = useCallback(async () => {
    if (!selectedTerminal || isSyncing || !navigator.onLine) return;
    const pending = await listOfflineOutbox(selectedTerminal.id);
    if (pending.length === 0) return;

    setIsSyncing(true);
    try {
      const summary = await flushPosOutbox(selectedTerminal.id);
      await refreshOutboxCount(selectedTerminal.id);
      if (summary.synced + summary.conflicts + summary.deduplicated > 0) {
        toast({
          title: t("pos.syncComplete", "Offline sales synced"),
          description: `${summary.synced} synced, ${summary.conflicts} conflict(s), ${summary.deduplicated} deduplicated`,
        });
        await loadTerminalContext(selectedTerminal);
      }
    } catch (err) {
      toast({
        title: t("pos.syncFailed", "Sync postponed"),
        description: err instanceof Error ? err.message : "Network unavailable",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, loadTerminalContext, refreshOutboxCount, selectedTerminal, t, toast]);

  useEffect(() => {
    if (isOnline && selectedTerminal && outboxCount > 0) {
      void handleSyncOutbox();
    }
  }, [handleSyncOutbox, isOnline, outboxCount, selectedTerminal]);

  useEffect(() => {
    if (!selectedTerminal) return;
    const timer = setInterval(() => {
      if (navigator.onLine) {
        void handleSyncOutbox();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [handleSyncOutbox, selectedTerminal]);

  // Cart manipulation
  const addToCart = useCallback(
    (product: PosCatalogProduct) => {
      feedback.success();
      setCart((prev) => {
        const existing = prev.find((l) => l.product.id === product.id);
        if (existing) {
          return prev.map((l) =>
            l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l
          );
        }
        return [...prev, { product, quantity: 1, discount: 0 }];
      });
    },
    []
  );

  // Fast keyboard-wedge barcode scan
  useBarcodeScanner({
    enabled: !isHardLocked && !pinOverlayOpen && !tenderOpen && !shiftDialogOpen,
    ignoreAllInputs: true,
    onScan: (code) => {
      const matched = matchProductByScanCode(products, code);
      if (!matched) {
        feedback.error();
        toast({
          title: t("scanner.productNotFound", "Product not found"),
          description: code,
          variant: "destructive",
        });
        return;
      }
      addToCart(matched);
    },
  });

  // Keyboard shortcuts (F2 search, F9 charge, Ctrl+L lock)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "F9" && cart.length > 0 && activeShift && !isHardLocked) {
        e.preventDefault();
        setTenderOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void handleLockTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.nameAr.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ? p.barcode.toLowerCase().includes(q) : false)
      );
    });
  }, [categoryFilter, products, search]);

  const cartSummary = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    const computedLines = cart.map((item) => {
      const calc = calculateLineAmounts(
        {
          quantity: item.quantity,
          unitPrice: item.product.sellingPrice,
          discount: item.discount,
          taxRate: item.product.taxRate,
          isTaxInclusive: item.product.isTaxInclusive,
        },
        2
      );
      subtotal = roundCurrency(subtotal + calc.taxable, 2);
      taxTotal = roundCurrency(taxTotal + calc.taxAmount, 2);
      return { item, ...calc };
    });
    return {
      computedLines,
      subtotal,
      taxTotal,
      grandTotal: roundCurrency(subtotal + taxTotal, 2),
    };
  }, [cart]);

  const handleLockTerminal = async () => {
    try {
      await apiRequest("/api/pos/terminal/lock", { method: "POST" });
      if (user) {
        applyPosSessionUpdate(user, {
          terminalId: selectedTerminalId || posSession?.terminalId || null,
          isLocked: true,
          terminalOwnerId: posSession?.terminalOwnerId ?? user.id,
        });
      }
      setPinOverlayOpen(true);
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : "Failed to lock terminal",
        variant: "destructive",
      });
    }
  };

  const handlePinUnlock = async (pin: string, userId?: string) => {
    const res = await apiRequest<{ user: User; terminalId: string | null; isLocked: false }>(
      "/api/pos/terminal/pin-switch",
      {
        method: "POST",
        body: {
          pin,
          ...(userId ? { userId } : {}),
          ...(selectedTerminalId ? { terminalId: selectedTerminalId } : {}),
        },
      }
    );
    applyPosSessionUpdate(res.user, {
      terminalId: res.terminalId ?? selectedTerminalId ?? null,
      isLocked: false,
      terminalOwnerId: posSession?.terminalOwnerId ?? res.user.id,
    });
    setPinOverlayOpen(false);
    toast({ title: `${t("pos.activeCashier", "Active cashier")}: ${res.user.name}` });
  };

  const handleCheckoutConfirm = async (
    tenders: Array<{ method: PosPaymentMethod; amount: number; tenderedAmount: number; reference: string }>
  ) => {
    if (!selectedTerminal || !activeShift || !user) return;
    setIsCheckingOut(true);

    const offlineClientTxId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();

    const payload: PosCheckoutInput = {
      terminalId: selectedTerminal.id,
      shiftId: activeShift.id,
      customerId: selectedCustomerId || undefined,
      currency,
      fxRate: 1,
      notes: "",
      offlineClientTxId,
      offlineCreatedAt: nowIso,
      lines: cart.map((c) => ({
        productId: c.product.id,
        description: c.product.name,
        quantity: c.quantity,
        unitPrice: c.product.sellingPrice,
        discount: c.discount,
        taxRate: c.product.taxRate,
        isTaxInclusive: c.product.isTaxInclusive,
      })),
      tenders,
    };

    const totalChangeGiven = tenders.reduce(
      (s, tItem) => s + (tItem.method === "cash" ? Math.max(0, tItem.tenderedAmount - tItem.amount) : 0),
      0
    );
    const customerName =
      customers.find((c) => c.id === selectedCustomerId)?.name ?? "Walk-in Customer";

    const buildLocalPreview = (): PosReceiptPreview => ({
      id: offlineClientTxId,
      invoiceNumber: `OFFLINE-${offlineClientTxId.slice(0, 8).toUpperCase()}`,
      branchId: selectedTerminal.branchId,
      terminalId: selectedTerminal.id,
      shiftId: activeShift.id,
      customerId: selectedCustomerId,
      customerName,
      cashierUserId: user.id,
      cashierName: user.name,
      invoiceDate: nowIso,
      currency,
      subtotal: cartSummary.subtotal,
      taxTotal: cartSummary.taxTotal,
      totalAmount: cartSummary.grandTotal,
      paidAmount: cartSummary.grandTotal,
      totalChangeGiven,
      syncStatus: "offline_pending",
      offlineClientTxId,
      icv: null,
      qrTlv: null,
      etaDocumentUuid: null,
      etaReceiptStatus: "pending_sync",
      eInvoiceStatus: "pending_sync",
      lines: cartSummary.computedLines.map((cl) => ({
        productId: cl.item.product.id,
        description: cl.item.product.name,
        quantity: cl.item.quantity,
        unitPrice: cl.item.product.sellingPrice,
        discount: cl.item.discount,
        taxRate: cl.item.product.taxRate,
        taxAmount: cl.taxAmount,
        lineTotal: cl.lineTotal,
      })),
      tenders: tenders.map((tItem) => ({
        ...tItem,
        changeGiven: tItem.method === "cash" ? Math.max(0, tItem.tenderedAmount - tItem.amount) : 0,
      })),
    });

    try {
      if (!navigator.onLine) {
        const preview = buildLocalPreview();
        await enqueueOfflineSale(payload, preview);
        await refreshOutboxCount(selectedTerminal.id);
        setProducts((prev) =>
          prev.map((p) => {
            const sold = cart.find((c) => c.product.id === p.id);
            if (!sold || p.itemType === "non_stock" || p.itemType === "service") return p;
            return { ...p, qtyOnHand: Math.max(0, p.qtyOnHand - sold.quantity) };
          })
        );
        setCart([]);
        setTenderOpen(false);
        setLastReceipt(preview);
        toast({
          title: t("pos.savedOffline", "Sale saved to offline queue"),
          description: t("pos.willAutoSync", "Will sync automatically when back online."),
        });
        return;
      }

      const res = await apiRequest<{ receipt: PosReceiptPreview }>("/api/pos/checkout", {
        method: "POST",
        body: payload,
      });
      setCart([]);
      setTenderOpen(false);
      setLastReceipt(res.receipt);
      void loadTerminalContext(selectedTerminal);
    } catch (err) {
      // Network failure fallback -> queue offline cleanly (4xx validation/stock errors bubble up!)
      const isNetworkError =
        !navigator.onLine || (err instanceof TypeError && err.message.toLowerCase().includes("fetch"));
      if (isNetworkError) {
        const preview = buildLocalPreview();
        await enqueueOfflineSale(payload, preview);
        await refreshOutboxCount(selectedTerminal.id);
        setCart([]);
        setTenderOpen(false);
        setLastReceipt(preview);
        toast({
          title: t("pos.savedOffline", "Network interrupted — saved offline"),
          description: t("pos.willAutoSync", "Will sync automatically when reconnected."),
        });
      } else {
        toast({
          title: err instanceof Error ? err.message : t("common.error"),
          variant: "destructive",
        });
      }
    } finally {
      setIsCheckingOut(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-muted/20">
      {/* Top POS Command Bar */}
      <header className="sticky top-0 z-30 border-b bg-background px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft className="me-1.5 h-4 w-4" />
              ERP
            </Link>
          </Button>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Select
              value={selectedTerminalId}
              onValueChange={async (id) => {
                setSelectedTerminalId(id);
                await savePosState("selected_terminal_id", id);
              }}
            >
              <SelectTrigger className="w-52 h-9" aria-label="Select POS terminal">
                <SelectValue placeholder={t("pos.selectTerminal", "Select register...")} />
              </SelectTrigger>
              <SelectContent>
                {terminals.map((term) => (
                  <SelectItem key={term.id} value={term.id}>
                    {term.code} — {term.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {can("pos", "edit") && (
              <Button variant="outline" size="sm" onClick={() => setCreateTermOpen(true)}>
                <Plus className="h-4 w-4 me-1" />
                {t("pos.newRegister", "Register")}
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isOnline ? "outline" : "destructive"} className="gap-1.5 py-1">
            {isOnline ? <Wifi className="h-3.5 w-3.5 text-green-600" /> : <CloudOff className="h-3.5 w-3.5" />}
            {isOnline ? t("pos.online", "Online") : t("pos.offline", "Offline")}
          </Badge>

          {outboxCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!isOnline || isSyncing}
              onClick={() => void handleSyncOutbox()}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
              {t("pos.syncPending", "Sync")} ({outboxCount})
            </Button>
          )}

          {selectedTerminal && (
            <Button
              size="sm"
              variant={activeShift ? "outline" : "default"}
              onClick={() => setShiftDialogOpen(true)}
              className="gap-1.5"
            >
              <Calculator className="h-4 w-4" />
              {activeShift ? activeShift.shiftNumber : t("pos.openShift", "Open Shift")}
            </Button>
          )}

          <Button size="sm" variant="outline" onClick={() => setSetPinOpen(true)} className="gap-1.5">
            <KeyRound className="h-4 w-4" />
            {t("pos.setPin", "PIN")}
          </Button>

          <Button size="sm" variant="outline" onClick={() => setPinOverlayOpen(true)} className="gap-1.5">
            <UserIcon className="h-4 w-4" />
            {user?.name}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            aria-label="Lock register"
            onClick={() => void handleLockTerminal()}
            className="gap-1.5"
          >
            <Lock className="h-4 w-4" />
            {t("pos.lock", "Lock")}
          </Button>
        </div>
      </header>

      {/* Main 2-column POS Register Surface */}
      {!selectedTerminal ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <Card className="max-w-md w-full text-center p-8 space-y-4">
            <ShoppingCart className="h-12 w-12 mx-auto text-primary" />
            <h1 className="text-2xl font-bold">{t("pos.welcomeTitle", "POS Cashier Register")}</h1>
            <p className="text-sm text-muted-foreground">
              {t(
                "pos.noTerminalYet",
                "Create your first POS register terminal to start scanning barcodes and accepting split payments."
              )}
            </p>
            {can("pos", "edit") && (
              <Button onClick={() => setCreateTermOpen(true)} className="w-full gap-2">
                <Plus className="h-4 w-4" />
                {t("pos.createFirstRegister", "Create Register Terminal")}
              </Button>
            )}
          </Card>
        </div>
      ) : (
        <main className="flex-1 grid lg:grid-cols-12 gap-4 p-4 max-w-[1600px] w-full mx-auto">
          {/* Left: Product Catalog & Barcode Search */}
          <section className="lg:col-span-7 xl:col-span-8 flex flex-col gap-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && search.trim()) {
                      e.preventDefault();
                      const match = matchProductByScanCode(products, search);
                      if (match) {
                        addToCart(match);
                        setSearch("");
                      }
                    }
                  }}
                  placeholder={t("pos.scanOrSearch", "Scan barcode or search product name / SKU (F2)...")}
                  className="ps-9 h-11 text-base"
                />
              </div>
              <Badge variant="outline" className="hidden sm:flex items-center gap-1.5 px-3">
                <Barcode className="h-4 w-4 text-primary" />
                Scanner Ready
              </Badge>
            </div>

            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {categories.map((cat) => (
                <Button
                  key={cat}
                  size="sm"
                  variant={categoryFilter === cat ? "default" : "outline"}
                  onClick={() => setCategoryFilter(cat)}
                  className="shrink-0"
                >
                  {cat === "all" ? t("common.all", "All") : cat}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 overflow-y-auto max-h-[calc(100vh-200px)] pe-1">
              {filteredProducts.map((product) => {
                const isService = product.itemType === "non_stock" || product.itemType === "service";
                const outOfStock = !isService && product.qtyOnHand <= 0;
                return (
                  <Card
                    key={product.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => addToCart(product)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        addToCart(product);
                      }
                    }}
                    className={`cursor-pointer transition-all hover:border-primary active:scale-[0.98] ${
                      outOfStock ? "opacity-65" : ""
                    }`}
                  >
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-1">
                        <span className="font-semibold text-sm leading-tight line-clamp-2">
                          {product.name}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground truncate">
                        {product.barcode || product.sku}
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <span className="font-bold text-primary text-sm">
                          {fmt(product.sellingPrice)}
                        </span>
                        <Badge
                          variant={isService ? "secondary" : outOfStock ? "destructive" : "outline"}
                          className="text-[10px]"
                        >
                          {isService ? "Service" : `${product.qtyOnHand} ${product.unit}`}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* Right: Active Cart & Checkout Panel */}
          <section className="lg:col-span-5 xl:col-span-4 flex flex-col rounded-xl border bg-card shadow-sm overflow-hidden max-h-[calc(100vh-96px)]">
            <div className="p-3 border-b space-y-2 bg-muted/30">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4 text-primary" />
                  {t("pos.currentSale", "Current Sale")} ({cart.reduce((s, c) => s + c.quantity, 0)})
                </h2>
                {cart.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setCart([])} className="text-destructive h-7">
                    {t("pos.clearCart", "Clear")}
                  </Button>
                )}
              </div>

              <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                <SelectTrigger className="h-9 bg-background" aria-label="Select customer">
                  <SelectValue placeholder="Walk-in Customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} {c.isWalkIn ? "(Walk-in)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 overflow-y-auto divide-y">
              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <Barcode className="h-10 w-10 mb-2 opacity-40" />
                  <p className="text-sm">{t("pos.emptyCart", "Scan a barcode or tap an item to start")}</p>
                </div>
              ) : (
                cartSummary.computedLines.map(({ item, lineTotal }) => (
                  <div key={item.product.id} className="p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{item.product.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmt(item.product.sellingPrice)}
                        {item.product.taxRate > 0
                          ? ` · ${item.product.taxRate}% ${item.product.isTaxInclusive ? "incl." : "VAT"}`
                          : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Decrease ${item.product.name}`}
                        onClick={() =>
                          setCart((prev) =>
                            prev
                              .map((l) =>
                                l.product.id === item.product.id
                                  ? { ...l, quantity: l.quantity - 1 }
                                  : l
                              )
                              .filter((l) => l.quantity > 0)
                          )
                        }
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-7 text-center text-sm font-semibold tabular-nums">
                        {item.quantity}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Increase ${item.product.name}`}
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((l) =>
                              l.product.id === item.product.id
                                ? { ...l, quantity: l.quantity + 1 }
                                : l
                            )
                          )
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="text-end w-20 font-semibold text-sm tabular-nums">
                      {fmt(lineTotal)}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label={`Remove ${item.product.name}`}
                      onClick={() =>
                        setCart((prev) => prev.filter((l) => l.product.id !== item.product.id))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t bg-muted/30 space-y-3">
              <div className="space-y-1 text-sm tabular-nums">
                <div className="flex justify-between text-muted-foreground">
                  <span>{t("invoices.subtotal", "Subtotal")}</span>
                  <span>{fmt(cartSummary.subtotal)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>{t("invoices.totalTax", "VAT / Tax")}</span>
                  <span>{fmt(cartSummary.taxTotal)}</span>
                </div>
                <div className="flex justify-between text-xl font-bold pt-1 border-t">
                  <span>{t("pos.total", "Total")}</span>
                  <span>{fmt(cartSummary.grandTotal)}</span>
                </div>
              </div>

              {!activeShift ? (
                <Button className="w-full h-12 text-base gap-2" onClick={() => setShiftDialogOpen(true)}>
                  <Calculator className="h-5 w-5" />
                  {t("pos.openShiftToSell", "Open Shift to Start Selling")}
                </Button>
              ) : (
                <Button
                  className="w-full h-12 text-base gap-2"
                  disabled={cart.length === 0 || isCheckingOut}
                  onClick={() => setTenderOpen(true)}
                >
                  <CreditCard className="h-5 w-5" />
                  {t("pos.charge", "Charge")} {fmt(cartSummary.grandTotal)} (F9)
                </Button>
              )}
            </div>
          </section>
        </main>
      )}

      {/* Split Tender Checkout Modal */}
      <SplitTenderDialog
        open={tenderOpen}
        onOpenChange={setTenderOpen}
        grandTotal={cartSummary.grandTotal}
        currency={currency}
        isSubmitting={isCheckingOut}
        onConfirm={handleCheckoutConfirm}
      />

      {/* Shift Open / Cash Drawer / Close Reconciliation Modal */}
      <ShiftReconciliationDialog
        open={shiftDialogOpen}
        onOpenChange={setShiftDialogOpen}
        activeShift={activeShift}
        currency={currency}
        onOpenShift={async (openingFloat, notes) => {
          if (!selectedTerminal) return;
          const res = await apiRequest<{ shift: PosShiftDto }>("/api/pos/shifts/open", {
            method: "POST",
            body: { terminalId: selectedTerminal.id, openingFloat, notes },
          });
          setActiveShift(res.shift);
          await savePosState(`active_shift:${selectedTerminal.id}`, res.shift);
          toast({ title: `${res.shift.shiftNumber} ${t("pos.shiftOpened", "opened")}` });
        }}
        onCashMovement={async (movementType: PosCashMovementType, amount: number, reason: string) => {
          if (!activeShift || !selectedTerminal) return;
          const res = await apiRequest<{ movement: { expectedCash: number } }>(
            `/api/pos/shifts/${activeShift.id}/cash-movement`,
            {
              method: "POST",
              body: { movementType, amount, reason },
            }
          );
          const next = { ...activeShift, expectedCash: res.movement.expectedCash };
          setActiveShift(next);
          await savePosState(`active_shift:${selectedTerminal.id}`, next);
          toast({ title: t("pos.cashMovementRecorded", "Cash movement recorded") });
        }}
        onCloseShift={async (countedCash, notes) => {
          if (!activeShift || !selectedTerminal) return;
          const res = await apiRequest<{ shift: PosShiftDto }>(`/api/pos/shifts/${activeShift.id}/close`, {
            method: "POST",
            body: { countedCash, notes },
          });
          setActiveShift(null);
          await savePosState(`active_shift:${selectedTerminal.id}`, null);
          toast({
            title: `${res.shift.shiftNumber} ${t("pos.shiftClosed", "closed")}`,
            description: `${t("pos.cashVariance", "Variance")}: ${fmt(res.shift.cashVariance ?? 0)}`,
          });
        }}
      />

      {/* Thermal Receipt Preview & Print Modal */}
      <ThermalReceiptPrintView
        receipt={lastReceipt}
        companyName={catalogMeta.companyName}
        taxNumber={catalogMeta.taxRegistrationNumber}
        receiptHeader={selectedTerminal?.receiptHeader}
        receiptFooter={selectedTerminal?.receiptFooter}
        defaultPaperWidth={selectedTerminal?.paperWidthMm === 58 ? 58 : 80}
        onClose={() => setLastReceipt(null)}
      />

      {/* Cashier PIN Lock / Fast Switch Overlay */}
      <PinLockOverlay
        open={isHardLocked || pinOverlayOpen}
        isHardLocked={isHardLocked}
        cashiers={cashiers}
        activeCashierName={user?.name ?? ""}
        onUnlock={handlePinUnlock}
        onCancel={() => setPinOverlayOpen(false)}
      />

      {/* Set Current Cashier PIN Dialog */}
      <Dialog open={setPinOpen} onOpenChange={setSetPinOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("pos.setCashierPin", "Set Cashier PIN")}</DialogTitle>
            <DialogDescription>
              {t("pos.setPinDesc", "Choose a 4 to 6 digit numeric PIN for fast register lock/unlock.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pos-new-pin">PIN (4–6 digits)</Label>
            <Input
              id="pos-new-pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={newPinValue}
              onChange={(e) => setNewPinValue(e.target.value.replace(/\D/g, ""))}
              placeholder="1234"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetPinOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={newPinValue.length < 4}
              onClick={async () => {
                if (!user) return;
                try {
                  await apiRequest(`/api/users/${user.id}/pos-pin`, {
                    method: "PUT",
                    body: { pin: newPinValue },
                  });
                  toast({ title: t("pos.pinSaved", "Cashier PIN saved") });
                  setNewPinValue("");
                  setSetPinOpen(false);
                } catch (err) {
                  toast({
                    title: err instanceof Error ? err.message : "Failed to save PIN",
                    variant: "destructive",
                  });
                }
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Register Terminal Dialog */}
      <Dialog open={createTermOpen} onOpenChange={setCreateTermOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pos.createRegister", "Create POS Register")}</DialogTitle>
            <DialogDescription>
              {t("pos.createRegisterDesc", "Bind a cashier register terminal to a retail or warehouse branch.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("common.branch", "Branch")}</Label>
              <Select value={newTermBranchId} onValueChange={setNewTermBranchId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="term-code">{t("pos.terminalCode", "Terminal Code")}</Label>
              <Input id="term-code" value={newTermCode} onChange={(e) => setNewTermCode(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="term-name">{t("pos.terminalName", "Terminal Name")}</Label>
              <Input id="term-name" value={newTermName} onChange={(e) => setNewTermName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateTermOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!newTermBranchId || !newTermCode.trim() || !newTermName.trim()}
              onClick={async () => {
                try {
                  const res = await apiRequest<{ terminal: { id: string } }>("/api/pos/terminals", {
                    method: "POST",
                    body: {
                      branchId: newTermBranchId,
                      code: newTermCode.trim(),
                      name: newTermName.trim(),
                    },
                  });
                  await savePosState("selected_terminal_id", res.terminal.id);
                  setCreateTermOpen(false);
                  await loadTerminals();
                  toast({ title: t("pos.registerCreated", "POS register created") });
                } catch (err) {
                  toast({
                    title: err instanceof Error ? err.message : "Failed to create register",
                    variant: "destructive",
                  });
                }
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
