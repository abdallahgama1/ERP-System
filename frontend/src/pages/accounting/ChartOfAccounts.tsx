import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ACCOUNT_TYPES,
  GL_MAPPING_KEYS,
  type AccountTypeShared,
  type GlMappingKey,
} from "@erp/shared";
import { BookOpen, Plus, Search, FileSpreadsheet } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import {
  useAccountLedgerQuery,
  useAccountingMutations,
  useAccountsQuery,
  useGlMappingsQuery,
  type ChartAccountDto,
} from "@/hooks/queries/useAccountingQueries";

const ACCOUNT_TYPE_BADGE: Record<AccountTypeShared, "default" | "secondary" | "outline" | "destructive"> = {
  asset: "default",
  liability: "secondary",
  equity: "outline",
  revenue: "default",
  expense: "destructive",
};

export default function ChartOfAccounts() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { can } = usePermissions();
  const { settings } = useSettings();

  const { data: accounts = [], isLoading: loadingAccounts } = useAccountsQuery();
  const { data: mappings = [] } = useGlMappingsQuery();
  const { createAccount, updateAccount, updateMapping } = useAccountingMutations();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<AccountTypeShared>("expense");
  const [newDescription, setNewDescription] = useState("");

  const [ledgerAccount, setLedgerAccount] = useState<ChartAccountDto | null>(null);
  const { data: ledgerRows = [], isLoading: loadingLedger } = useAccountLedgerQuery(ledgerAccount?.id ?? null);

  const canCreate = can("accounting", "create");
  const canEdit = can("accounting", "edit");

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (typeFilter !== "all" && a.accountType !== typeFilter) return false;
      if (!q) return true;
      return (
        a.code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [accounts, search, typeFilter]);

  const mappingByKey = useMemo(() => {
    const map = new Map<GlMappingKey, string>();
    for (const m of mappings) map.set(m.mappingKey, m.accountId);
    return map;
  }, [mappings]);

  const handleCreate = async () => {
    if (!newCode.trim() || !newName.trim()) {
      toast({
        title: t("accounting.accounts.codeNameRequired", "Code and account name are required"),
        variant: "destructive",
      });
      return;
    }
    try {
      await createAccount.mutateAsync({
        code: newCode.trim(),
        name: newName.trim(),
        accountType: newType,
        description: newDescription.trim() || undefined,
      });
      toast({ title: t("accounting.accounts.created", "Account created") });
      setCreateOpen(false);
      setNewCode("");
      setNewName("");
      setNewDescription("");
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleToggleActive = async (acct: ChartAccountDto, isActive: boolean) => {
    try {
      await updateAccount.mutateAsync({ id: acct.id, body: { isActive } });
      toast({ title: t("common.success") });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  const handleMappingChange = async (mappingKey: GlMappingKey, accountId: string) => {
    try {
      await updateMapping.mutateAsync({ mappingKey, accountId });
      toast({ title: t("accounting.mappings.updated", "GL mapping updated") });
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-7 w-7 text-primary" />
            {t("accounting.accounts.title", "Chart of Accounts")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "accounting.accounts.description",
              "Manage general ledger accounts, view account activity ledgers, and configure automated GL posting mappings."
            )}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 me-2" />
            {t("accounting.accounts.add", "New Account")}
          </Button>
        )}
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">
            {t("accounting.accounts.tabAccounts", "Accounts")} ({accounts.length})
          </TabsTrigger>
          <TabsTrigger value="mappings">
            {t("accounting.mappings.tabMappings", "GL Posting Mappings")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="ps-9"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("common.search")}
                  />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("common.all", "All Types")}</SelectItem>
                    {ACCOUNT_TYPES.map((tp) => (
                      <SelectItem key={tp} value={tp}>
                        {t(`accounting.accountTypes.${tp}`, tp.toUpperCase())}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loadingAccounts ? (
                <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
              ) : filteredAccounts.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">{t("common.noResults")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">{t("accounting.accounts.code", "Code")}</TableHead>
                      <TableHead>{t("accounting.accounts.name", "Name")}</TableHead>
                      <TableHead>{t("accounting.accounts.type", "Type")}</TableHead>
                      <TableHead>{t("accounting.accounts.normalBalance", "Normal Balance")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                      <TableHead className="text-end">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAccounts.map((acct) => (
                      <TableRow key={acct.id}>
                        <TableCell className="font-mono font-semibold">{acct.code}</TableCell>
                        <TableCell>
                          <div className="font-medium flex items-center gap-2">
                            {acct.name}
                            {acct.isSystem && (
                              <Badge variant="outline" className="text-[10px]">
                                {t("accounting.accounts.system", "System")}
                              </Badge>
                            )}
                          </div>
                          {acct.description && (
                            <div className="text-xs text-muted-foreground">{acct.description}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={ACCOUNT_TYPE_BADGE[acct.accountType]}>
                            {t(`accounting.accountTypes.${acct.accountType}`, acct.accountType)}
                          </Badge>
                        </TableCell>
                        <TableCell className="capitalize">{acct.normalBalance}</TableCell>
                        <TableCell>
                          {canEdit && !acct.isSystem ? (
                            <Switch
                              checked={acct.isActive}
                              onCheckedChange={(v) => void handleToggleActive(acct, v)}
                              aria-label={`Toggle active status for ${acct.code}`}
                            />
                          ) : (
                            <Badge variant={acct.isActive ? "secondary" : "outline"}>
                              {acct.isActive ? t("common.active") : t("common.inactive", "Inactive")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setLedgerAccount(acct)}
                          >
                            <FileSpreadsheet className="h-3.5 w-3.5 me-1.5" />
                            {t("accounting.accounts.viewLedger", "Ledger")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mappings">
          <Card>
            <CardHeader>
              <CardTitle>{t("accounting.mappings.title", "Automated GL Posting Rules")}</CardTitle>
              <CardDescription>
                {t(
                  "accounting.mappings.description",
                  "Controls which accounts operational inventory, purchasing, and sales transactions debit and credit automatically."
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accounting.mappings.key", "Posting Key")}</TableHead>
                    <TableHead className="w-[340px]">
                      {t("accounting.mappings.account", "Target GL Account")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {GL_MAPPING_KEYS.map((key) => {
                    const currentId = mappingByKey.get(key) ?? "";
                    return (
                      <TableRow key={key}>
                        <TableCell className="font-mono text-sm font-medium">{key}</TableCell>
                        <TableCell>
                          <Select
                            value={currentId}
                            onValueChange={(val) => void handleMappingChange(key, val)}
                            disabled={!canEdit || updateMapping.isPending}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t("accounting.mappings.selectAccount", "Select account")} />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts
                                .filter((a) => a.isActive)
                                .map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.code} — {a.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New Account Modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("accounting.accounts.add", "New Account")}</DialogTitle>
            <DialogDescription>
              {t("accounting.accounts.addDesc", "Add a general ledger account to your Chart of Accounts.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="coa-code">{t("accounting.accounts.code", "Code")} *</Label>
                <Input
                  id="coa-code"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="6100"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("accounting.accounts.type", "Type")} *</Label>
                <Select value={newType} onValueChange={(v) => setNewType(v as AccountTypeShared)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((tp) => (
                      <SelectItem key={tp} value={tp}>
                        {t(`accounting.accountTypes.${tp}`, tp)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="coa-name">{t("accounting.accounts.name", "Name")} *</Label>
              <Input
                id="coa-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Rent Expense"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="coa-desc">{t("common.description", "Description")}</Label>
              <Input
                id="coa-desc"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional account description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreate()} disabled={createAccount.isPending}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Account Ledger Drawer / Modal */}
      <Dialog open={!!ledgerAccount} onOpenChange={(open) => !open && setLedgerAccount(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="font-mono">{ledgerAccount?.code}</span>
              <span>{ledgerAccount?.name}</span>
            </DialogTitle>
            <DialogDescription>
              {t("accounting.accounts.ledgerDesc", "Posted journal lines and cumulative running balance.")}
            </DialogDescription>
          </DialogHeader>
          {loadingLedger ? (
            <p className="py-8 text-center text-muted-foreground">{t("common.loading")}</p>
          ) : ledgerRows.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              {t("accounting.accounts.noLedgerRows", "No posted ledger entries for this account yet.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.date", "Date")}</TableHead>
                  <TableHead>{t("accounting.journals.entryNumber", "Entry #")}</TableHead>
                  <TableHead>{t("accounting.journals.memo", "Memo")}</TableHead>
                  <TableHead className="text-end">{t("accounting.journals.debit", "Debit")}</TableHead>
                  <TableHead className="text-end">{t("accounting.journals.credit", "Credit")}</TableHead>
                  <TableHead className="text-end">{t("accounting.accounts.runningBalance", "Balance")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerRows.map((r) => (
                  <TableRow key={r.lineId}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(r.entryDate).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.entryNumber}</TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{r.memo}</div>
                      {r.description && (
                        <div className="text-xs text-muted-foreground">{r.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {r.debit > 0 ? formatMoney(r.debit, settings.currency) : "—"}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {r.credit > 0 ? formatMoney(r.credit, settings.currency) : "—"}
                    </TableCell>
                    <TableCell className="text-end font-mono font-semibold">
                      {formatMoney(r.runningBalance, settings.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
