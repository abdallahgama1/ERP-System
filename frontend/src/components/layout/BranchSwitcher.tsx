import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
import { useBranch } from "@/contexts/BranchContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BranchSwitcher() {
  const { t } = useTranslation();
  const { branches, activeBranchId, canViewAllBranches, setActiveBranchId } = useBranch();

  if (branches.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center">
      <Select value={activeBranchId} onValueChange={(v) => void setActiveBranchId(v)}>
        <SelectTrigger className="h-9 w-[170px] sm:w-[210px] text-xs sm:text-sm" aria-label={t("branches.activeBranch", "Active Branch")}>
          <Building2 className="h-3.5 w-3.5 me-1.5 shrink-0 text-muted-foreground" />
          <SelectValue placeholder={t("branches.selectBranch", "Select Branch")} />
        </SelectTrigger>
        <SelectContent>
          {canViewAllBranches && (
            <SelectItem value="all">{t("users.allBranches", "All Branches")}</SelectItem>
          )}
          {branches.map((branch) => (
            <SelectItem key={branch.id} value={branch.id}>
              {branch.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
