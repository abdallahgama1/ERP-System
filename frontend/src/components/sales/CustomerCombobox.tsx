import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Customer } from "@/types";

interface CustomerComboboxProps {
  customers: Customer[];
  value: string | null;
  onSelect: (customer: Customer) => void;
  disabled?: boolean;
}

export const CustomerCombobox = ({ customers, value, onSelect, disabled = false }: CustomerComboboxProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const selected = customers.find((c) => c.id === value);
  const filtered = customers.filter(
    (c) =>
      c.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (c.taxNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between" disabled={disabled}>
          {selected ? (
            <span className="truncate">{selected.displayName}</span>
          ) : (
            <span className="text-muted-foreground">{t("salesOrders.selectCustomer")}</span>
          )}
          <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0 z-[60]" align="start">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("salesOrders.searchCustomer")}
              className="ps-9"
            />
          </div>
        </div>
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <Users className="h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {customers.length === 0 ? t("salesOrders.noCustomersAvailable") : t("salesOrders.noCustomerResults")}
              </p>
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent",
                  value === c.id && "bg-accent",
                )}
                onClick={() => {
                  onSelect(c);
                  setOpen(false);
                  setSearchQuery("");
                }}
              >
                <Check className={cn("h-4 w-4", value === c.id ? "opacity-100" : "opacity-0")} />
                <div className="flex-1">
                  <p className="font-medium">{c.displayName}</p>
                  {c.taxNumber && <p className="text-xs text-muted-foreground">{c.taxNumber}</p>}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};