import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useAuditLog } from "@/contexts/AuditLogContext";
import {
  useAccountingMutations,
  useAccountsQuery,
  useCurrenciesQuery,
  useTaxCodesQuery,
} from "@/hooks/queries/useAccountingQueries";
import { apiRequest } from "@/lib/api-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Sun,
  Moon,
  Monitor,
  Shield,
  Bell,
  Package,
  Eye,
  EyeOff,
  Database,
  Download,
  Building,
  Percent,
  Coins,
  Plus,
  Trash2,
} from "lucide-react";

export default function Settings() {
  const { t } = useTranslation();
  const { settings, companyMeta, updateSettings, reloadCompanySettings } = useSettings();
  const { user } = useAuth();
  const { role } = usePermissions();
  const { record } = useAuditLog();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);

  const isAdmin = role === "admin";
  const { data: taxCodes = [] } = useTaxCodesQuery(Boolean(user));
  const { data: currencyData } = useCurrenciesQuery(Boolean(user));
  const { data: accounts = [] } = useAccountsQuery(isAdmin);
  const {
    createTaxCode,
    deleteTaxCode,
    upsertCurrency,
    createExchangeRate,
  } = useAccountingMutations();

  const [legalName, setLegalName] = useState("");
  const [companyNameInput, setCompanyNameInput] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [einvoicingMode, setEinvoicingMode] = useState<"none" | "zatca_qr" | "zatca_phase2" | "eta_egypt">("none");
  const [savingCompany, setSavingCompany] = useState(false);

  const [tcCode, setTcCode] = useState("");
  const [tcName, setTcName] = useState("");
  const [tcRate, setTcRate] = useState("15");
  const [tcDefault, setTcDefault] = useState(false);
  const [tcInclusive, setTcInclusive] = useState(false);
  const [tcInputAcct, setTcInputAcct] = useState("none");
  const [tcOutputAcct, setTcOutputAcct] = useState("none");

  const [ccyCode, setCcyCode] = useState("");
  const [ccyName, setCcyName] = useState("");
  const [ccySymbol, setCcySymbol] = useState("");
  const [ccyBase, setCcyBase] = useState(false);

  const [fxFrom, setFxFrom] = useState("EUR");
  const [fxTo, setFxTo] = useState("USD");
  const [fxRate, setFxRate] = useState("1.08");

  useEffect(() => {
    if (!companyMeta) return;
    setCompanyNameInput(companyMeta.companyName || "");
    setLegalName(companyMeta.legalName || "");
    setTaxNumber(companyMeta.taxRegistrationNumber || "");
    setEinvoicingMode(companyMeta.einvoicingMode || "none");
  }, [companyMeta]);

  const availableCurrencies = currencyData?.currencies ?? [
    { code: "USD", name: "US Dollar", symbol: "$", decimals: 2, isBase: true, isActive: true },
    { code: "EGP", name: "Egyptian Pound", symbol: "E£", decimals: 2, isBase: false, isActive: true },
  ];

  const handleSaveCompanyProfile = async () => {
    if (!isAdmin) return;
    setSavingCompany(true);
    try {
      await apiRequest("/api/settings/company", {
        method: "PUT",
        body: {
          companyName: companyNameInput.trim() || undefined,
          legalName: legalName.trim(),
          taxRegistrationNumber: taxNumber.trim(),
          einvoicingMode,
        },
      });
      await reloadCompanySettings();
      toast.success(t("settings.accounting.profileSaved", "Company tax & e-invoicing profile updated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSavingCompany(false);
    }
  };

  const handleAddTaxCode = async () => {
    if (!tcCode.trim() || !tcName.trim()) {
      toast.error(t("settings.accounting.taxCodeRequired", "Tax code and name are required"));
      return;
    }
    try {
      await createTaxCode.mutateAsync({
        code: tcCode.trim().toUpperCase(),
        name: tcName.trim(),
        rate: Number(tcRate) || 0,
        isDefault: tcDefault,
        isInclusive: tcInclusive,
        isActive: true,
        inputAccountId: tcInputAcct === "none" ? null : tcInputAcct,
        outputAccountId: tcOutputAcct === "none" ? null : tcOutputAcct,
      });
      setTcCode("");
      setTcName("");
      toast.success(t("settings.accounting.taxCodeAdded", "Tax code created"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleUpsertCurrency = async () => {
    if (!ccyCode.trim() || !ccyName.trim() || !ccySymbol.trim()) {
      toast.error(t("settings.accounting.currencyRequired", "Code, name, and symbol are required"));
      return;
    }
    try {
      await upsertCurrency.mutateAsync({
        code: ccyCode.trim().toUpperCase(),
        name: ccyName.trim(),
        symbol: ccySymbol.trim(),
        decimals: 2,
        isBase: ccyBase,
        isActive: true,
      });
      setCcyCode("");
      setCcyName("");
      setCcySymbol("");
      toast.success(t("settings.accounting.currencySaved", "Currency saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleAddRate = async () => {
    const rateNum = Number(fxRate);
    if (!fxFrom.trim() || !fxTo.trim() || !Number.isFinite(rateNum) || rateNum <= 0) return;
    try {
      await createExchangeRate.mutateAsync({
        fromCurrency: fxFrom.trim().toUpperCase(),
        toCurrency: fxTo.trim().toUpperCase(),
        rate: rateNum,
      });
      toast.success(t("settings.accounting.rateSaved", "Exchange rate recorded"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handleExport = async () => {
    if (!isAdmin) return;
    try {
      const snapshot = await apiRequest<Record<string, unknown>>("/api/admin/export-backup");
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `erp-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("settings.data.exported"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  };

  const handlePasswordChange = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error(t("settings.fillAllPasswordFields"));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t("settings.passwordsNotMatch"));
      return;
    }
    if (newPassword.length < 8) {
      toast.error(t("settings.passwordMinLength"));
      return;
    }

    setUpdatingPassword(true);
    try {
      await apiRequest<{ ok: boolean }>("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });

      record("settings", "Updated account password", { entity: "user", entityId: user?.id });
      toast.success(t("settings.passwordUpdated"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setUpdatingPassword(false);
    }
  };

  const timezones = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Tokyo",
    "Asia/Dubai",
    "Africa/Cairo",
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("settings.title")}</h1>
        <p className="text-muted-foreground">{t("settings.description")}</p>
      </div>

      {/* General Preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sun className="h-5 w-5" />
            {t("settings.generalPreferences")}
          </CardTitle>
          <CardDescription>{t("settings.generalDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <Label className="text-base">{t("settings.appearance")}</Label>
            <RadioGroup
              value={settings.appearance}
              onValueChange={(value: "light" | "dark" | "system") =>
                updateSettings({ appearance: value })
              }
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="light" id="light" />
                <Label htmlFor="light" className="flex items-center gap-1 cursor-pointer">
                  <Sun className="h-4 w-4" /> {t("settings.light")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="dark" id="dark" />
                <Label htmlFor="dark" className="flex items-center gap-1 cursor-pointer">
                  <Moon className="h-4 w-4" /> {t("settings.dark")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="system" id="system" />
                <Label htmlFor="system" className="flex items-center gap-1 cursor-pointer">
                  <Monitor className="h-4 w-4" /> {t("settings.system")}
                </Label>
              </div>
            </RadioGroup>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="currency">{t("settings.currency")}</Label>
              <Select
                value={settings.currency}
                onValueChange={(value: string) => updateSettings({ currency: value })}
              >
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableCurrencies.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.code} ({c.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dateFormat">{t("settings.dateFormat")}</Label>
              <Select
                value={settings.dateFormat}
                onValueChange={(value: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD") =>
                  updateSettings({ dateFormat: value })
                }
              >
                <SelectTrigger id="dateFormat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                  <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                  <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="timezone">{t("settings.timezone")}</Label>
              <Select
                value={settings.timezone}
                onValueChange={(value) => updateSettings({ timezone: value })}
              >
                <SelectTrigger id="timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t("settings.security")}
          </CardTitle>
          <CardDescription>{t("settings.securityDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-base">{t("settings.passwordManagement")}</Label>
              <Button variant="ghost" size="sm" onClick={() => setShowPasswords(!showPasswords)}>
                {showPasswords ? (
                  <>
                    <EyeOff className="h-4 w-4 me-1" /> {t("settings.hide")}
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4 me-1" /> {t("settings.show")}
                  </>
                )}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="currentPassword">{t("settings.currentPassword")}</Label>
                <Input
                  id="currentPassword"
                  type={showPasswords ? "text" : "password"}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t("settings.newPassword")}</Label>
                <Input
                  id="newPassword"
                  type={showPasswords ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t("settings.confirmPassword")}</Label>
                <Input
                  id="confirmPassword"
                  type={showPasswords ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </div>
            <Button
              onClick={() => void handlePasswordChange()}
              disabled={updatingPassword}
              className="w-full sm:w-auto"
            >
              {t("settings.updatePassword")}
            </Button>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label className="text-base">{t("settings.twoFactorAuth")}</Label>
                <Badge variant="secondary">{t("common.comingSoon")}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t(
                  "settings.mfaServerManaged",
                  "Server-managed TOTP Multi-Factor Authentication enrollment will be enabled in a future security update.",
                )}
              </p>
            </div>
            <Switch checked={false} disabled aria-label={t("settings.twoFactorAuth")} />
          </div>
        </CardContent>
      </Card>

      {/* Inventory Configurations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {t("settings.inventoryConfigs")}
          </CardTitle>
          <CardDescription>{t("settings.inventoryDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-base">{t("settings.lowStockThreshold")}</Label>
              <span className="text-sm font-medium text-muted-foreground">
                {settings.lowStockThreshold} {t("settings.units")}
              </span>
            </div>
            <Slider
              value={[settings.lowStockThreshold]}
              onValueChange={([value]) => updateSettings({ lowStockThreshold: value })}
              max={100}
              min={1}
              step={1}
              className="w-full"
            />
            <p className="text-sm text-muted-foreground">
              {t("settings.notifyBelow", { count: settings.lowStockThreshold })}
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <Label className="text-base">{t("settings.defaultView")}</Label>
            <RadioGroup
              value={settings.defaultView}
              onValueChange={(value: "table" | "grid") => updateSettings({ defaultView: value })}
              className="flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="table" id="table" />
                <Label htmlFor="table" className="cursor-pointer">
                  {t("settings.tableView")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="grid" id="grid" />
                <Label htmlFor="grid" className="cursor-pointer">
                  {t("settings.gridView")}
                </Label>
              </div>
            </RadioGroup>
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t("settings.notifications")}
          </CardTitle>
          <CardDescription>{t("settings.notificationsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-base">{t("settings.emailNotifications")}</Label>
              <p className="text-sm text-muted-foreground">{t("settings.emailNotificationsDescription")}</p>
            </div>
            <Switch
              checked={settings.emailNotifications}
              onCheckedChange={(checked) => updateSettings({ emailNotifications: checked })}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-base">{t("settings.inAppNotifications")}</Label>
              <p className="text-sm text-muted-foreground">{t("settings.inAppDescription")}</p>
            </div>
            <Switch
              checked={settings.inAppNotifications}
              onCheckedChange={(checked) => updateSettings({ inAppNotifications: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Legal, Tax & E-Invoicing Profile */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building className="h-5 w-5" />
              {t("settings.accounting.legalProfileTitle", "Company Tax & E-Invoicing Profile")}
            </CardTitle>
            <CardDescription>
              {t(
                "settings.accounting.legalProfileDesc",
                "Used on sales invoices, SHA-256 hash chains, and ZATCA Phase-1 QR TLV payloads."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="comp-name">{t("settings.accounting.companyName", "Company Name")}</Label>
                <Input id="comp-name" value={companyNameInput} onChange={(e) => setCompanyNameInput(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="legal-name">{t("settings.accounting.legalName", "Legal Entity Name")}</Label>
                <Input id="legal-name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vat-id">{t("settings.accounting.vatNumber", "VAT / Tax Registration #")}</Label>
                <Input id="vat-id" value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} placeholder="300000000000003" />
              </div>
              <div className="space-y-2">
                <Label>{t("settings.accounting.einvoicingMode", "E-Invoicing Mode")}</Label>
                <Select
                  value={einvoicingMode}
                  onValueChange={(v) => setEinvoicingMode(v as typeof einvoicingMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Disabled</SelectItem>
                    <SelectItem value="zatca_qr">ZATCA Phase 1 (QR TLV + SHA-256 Chain)</SelectItem>
                    <SelectItem value="zatca_phase2">ZATCA Phase 2 Ready</SelectItem>
                    <SelectItem value="eta_egypt">ETA Egypt E-Receipt</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={() => void handleSaveCompanyProfile()} disabled={savingCompany}>
              {t("common.save")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tax Codes Configuration */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Percent className="h-5 w-5" />
              {t("settings.accounting.taxCodesTitle", "Tax Codes & VAT GL Accounts")}
            </CardTitle>
            <CardDescription>
              {t("settings.accounting.taxCodesDesc", "Configure active tax rates and optional input/output VAT accounts.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("accounting.accounts.code", "Code")}</TableHead>
                  <TableHead>{t("common.name")}</TableHead>
                  <TableHead className="text-end">{t("settings.accounting.rate", "Rate %")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {taxCodes.map((tc) => (
                  <TableRow key={tc.id}>
                    <TableCell className="font-mono font-medium">{tc.code}</TableCell>
                    <TableCell>
                      {tc.name}{" "}
                      {tc.isDefault && (
                        <Badge variant="secondary" className="ms-1">Default</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end font-mono">{tc.rate}%</TableCell>
                    <TableCell>
                      <Badge variant={tc.isActive ? "default" : "outline"}>
                        {tc.isActive ? t("common.active") : t("common.inactive", "Inactive")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {!tc.isDefault && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void deleteTaxCode.mutateAsync(tc.id)}
                          aria-label={`Delete ${tc.code}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Separator />
            <div className="grid gap-3 sm:grid-cols-6 items-end">
              <div className="space-y-1">
                <Label htmlFor="tc-code">Code</Label>
                <Input id="tc-code" value={tcCode} onChange={(e) => setTcCode(e.target.value)} placeholder="VAT15" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="tc-name">Name</Label>
                <Input id="tc-name" value={tcName} onChange={(e) => setTcName(e.target.value)} placeholder="Standard VAT 15%" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tc-rate">Rate %</Label>
                <Input id="tc-rate" type="number" min={0} max={100} value={tcRate} onChange={(e) => setTcRate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Input Account</Label>
                <Select value={tcInputAcct} onValueChange={setTcInputAcct}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Default GL</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Output Account</Label>
                <Select value={tcOutputAcct} onValueChange={setTcOutputAcct}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Default GL</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Switch checked={tcDefault} onCheckedChange={setTcDefault} /> Default Tax
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Switch checked={tcInclusive} onCheckedChange={setTcInclusive} /> Tax Inclusive
                </label>
              </div>
              <Button variant="outline" onClick={() => void handleAddTaxCode()} disabled={createTaxCode.isPending}>
                <Plus className="h-4 w-4 me-1" />
                {t("settings.accounting.addTaxCode", "Add Tax Code")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Multi-Currency & FX Rates */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              {t("settings.accounting.currenciesTitle", "Currencies & Exchange Rates")}
            </CardTitle>
            <CardDescription>
              {t("settings.accounting.currenciesDesc", "Manage active currencies and record FX conversion rates to base currency.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-5 items-end">
              <div className="space-y-1">
                <Label htmlFor="ccy-code">ISO Code</Label>
                <Input id="ccy-code" value={ccyCode} onChange={(e) => setCcyCode(e.target.value)} placeholder="SAR" maxLength={10} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="ccy-name">Currency Name</Label>
                <Input id="ccy-name" value={ccyName} onChange={(e) => setCcyName(e.target.value)} placeholder="Saudi Riyal" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ccy-sym">Symbol</Label>
                <Input id="ccy-sym" value={ccySymbol} onChange={(e) => setCcySymbol(e.target.value)} placeholder="SAR" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <Switch checked={ccyBase} onCheckedChange={setCcyBase} /> Base
                </label>
                <Button variant="outline" size="sm" onClick={() => void handleUpsertCurrency()} disabled={upsertCurrency.isPending}>
                  Save
                </Button>
              </div>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-4 items-end">
              <div className="space-y-1">
                <Label htmlFor="fx-from">From</Label>
                <Input id="fx-from" value={fxFrom} onChange={(e) => setFxFrom(e.target.value)} placeholder="EUR" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-to">To</Label>
                <Input id="fx-to" value={fxTo} onChange={(e) => setFxTo(e.target.value)} placeholder="USD" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fx-rate">Rate</Label>
                <Input id="fx-rate" type="number" min={0.0001} step="0.0001" value={fxRate} onChange={(e) => setFxRate(e.target.value)} />
              </div>
              <Button variant="outline" onClick={() => void handleAddRate()} disabled={createExchangeRate.isPending}>
                <Plus className="h-4 w-4 me-1" /> Record FX Rate
              </Button>
            </div>

            {(currencyData?.exchangeRates?.length ?? 0) > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pair</TableHead>
                    <TableHead className="text-end">Rate</TableHead>
                    <TableHead>Effective At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {currencyData!.exchangeRates.slice(0, 8).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono font-medium">{r.fromCurrency} / {r.toCurrency}</TableCell>
                      <TableCell className="text-end font-mono">{r.rate.toFixed(6)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(r.effectiveAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Data Management (Admin-only read-only backup) */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              {t("settings.data.title")}
            </CardTitle>
            <CardDescription>{t("settings.data.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-base">{t("settings.data.backupTitle")}</Label>
                <p className="text-sm text-muted-foreground">{t("settings.data.backupDescription")}</p>
              </div>
              <Button variant="outline" onClick={handleExport}>
                <Download className="h-4 w-4 me-2" />
                {t("settings.data.export")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
