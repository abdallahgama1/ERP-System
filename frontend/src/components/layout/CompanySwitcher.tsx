import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function CompanySwitcher() {
  const { t } = useTranslation();
  const { user, companies, activeCompanyId, switchCompany } = useAuth();
  const [isSwitching, setIsSwitching] = useState(false);

  if (!user || companies.length === 0) {
    return null;
  }

  const activeCompanies = companies.filter((c) => c.isActive !== false);
  const visibleCompanies = activeCompanies.length > 0 ? activeCompanies : companies;
  const activeCompany =
    visibleCompanies.find((c) => c.id === activeCompanyId) ??
    companies.find((c) => c.id === activeCompanyId) ??
    visibleCompanies[0];

  if (visibleCompanies.length <= 1) {
    return (
      <div
        data-testid="company-switcher-single"
        aria-label={t("companySwitcher.activeCompany", "Active Company")}
        className="hidden sm:inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 h-9 text-xs font-medium text-foreground"
      >
        <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="truncate max-w-[140px]">{activeCompany?.name}</span>
        {activeCompany?.code && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {activeCompany.code}
          </Badge>
        )}
      </div>
    );
  }

  const handleSwitch = async (nextCompanyId: string) => {
    if (!nextCompanyId || nextCompanyId === activeCompanyId || isSwitching) return;
    const target = visibleCompanies.find((c) => c.id === nextCompanyId);
    setIsSwitching(true);
    try {
      await switchCompany(nextCompanyId);
      toast.success(
        t("companySwitcher.switched", {
          defaultValue: "Switched active company to {{name}}",
          name: target?.name ?? nextCompanyId,
        })
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("companySwitcher.switchFailed", "Failed to switch company")
      );
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <Select value={activeCompany?.id ?? activeCompanyId} onValueChange={handleSwitch} disabled={isSwitching}>
      <SelectTrigger
        className="w-[180px] md:w-[210px] h-9 text-xs"
        aria-label={t("companySwitcher.switchCompany", "Switch Company")}
        data-testid="company-switcher-select"
      >
        <Building2 className="h-3.5 w-3.5 me-1.5 shrink-0 text-muted-foreground" />
        <SelectValue placeholder={t("companySwitcher.activeCompany", "Active Company")} />
      </SelectTrigger>
      <SelectContent>
        {visibleCompanies.map((company) => (
          <SelectItem key={company.id} value={company.id}>
            {company.code} · {company.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
