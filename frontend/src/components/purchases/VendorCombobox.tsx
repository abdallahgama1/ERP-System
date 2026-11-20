import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Search, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Vendor } from "@/types";

interface VendorComboboxProps {
  vendors: Vendor[];
  value: string | null;
  onSelect: (vendor: Vendor | null) => void;
  disabled?: boolean;
}

export const VendorCombobox = ({
  vendors,
  value,
  onSelect,
  disabled = false,
}: VendorComboboxProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const selectedVendor = vendors.find((v) => v.id === value);

  const filteredVendors = vendors.filter(
    (vendor) =>
      vendor.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (vendor.taxNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
  );

  const handleSelect = (vendor: Vendor) => {
    onSelect(vendor);
    setOpen(false);
    setSearchQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={disabled}
        >
          {selectedVendor ? (
            <span className="truncate">{selectedVendor.displayName}</span>
          ) : (
            <span className="text-muted-foreground">
              {t("purchaseOrders.selectVendor")}
            </span>
          )}
          <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("purchaseOrders.searchVendor")}
              className="ps-9"
            />
          </div>
        </div>
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filteredVendors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <Truck className="h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {vendors.length === 0
                  ? t("purchaseOrders.noVendorsAvailable")
                  : t("purchaseOrders.noVendorResults")}
              </p>
            </div>
          ) : (
            filteredVendors.map((vendor) => (
              <div
                key={vendor.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent",
                  value === vendor.id && "bg-accent"
                )}
                onClick={() => handleSelect(vendor)}
              >
                <Check
                  className={cn(
                    "h-4 w-4",
                    value === vendor.id ? "opacity-100" : "opacity-0"
                  )}
                />
                <div className="flex-1">
                  <p className="font-medium">{vendor.displayName}</p>
                  {vendor.taxNumber && (
                    <p className="text-xs text-muted-foreground">
                      {vendor.taxNumber}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
