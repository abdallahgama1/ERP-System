import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Search, Package } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import type { Product } from "@/types";

interface ProductSelectorProps {
  products: Product[];
  onSelect: (product: Product) => void;
  disabled?: boolean;
}

export const ProductSelector = ({
  products,
  onSelect,
  disabled = false,
}: ProductSelectorProps) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [searchQuery, setSearchQuery] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (searchQuery.trim() && products.length > 0) {
      const filtered = products
        .filter(
          (product) =>
            product.product_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            product.product_sku.toLowerCase().includes(searchQuery.toLowerCase())
        )
        .slice(0, 10);

      setFilteredProducts(filtered);
      setShowSuggestions(filtered.length > 0);
      setSelectedIndex(-1);
    } else {
      setFilteredProducts([]);
      setShowSuggestions(false);
    }
  }, [searchQuery, products]);

  const handleSelect = (product: Product) => {
    onSelect(product);
    setSearchQuery("");
    setShowSuggestions(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filteredProducts.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && filteredProducts[selectedIndex]) {
          handleSelect(filteredProducts[selectedIndex]);
        }
        break;
      case "Escape":
        setShowSuggestions(false);
        break;
    }
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => searchQuery && setShowSuggestions(filteredProducts.length > 0)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder={t("purchaseOrders.searchProduct")}
          className="ps-9"
          disabled={disabled}
        />
      </div>

      {showSuggestions && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-lg"
        >
          {filteredProducts.map((product, index) => (
            <li
              key={product.productId}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm",
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent hover:text-accent-foreground"
              )}
              onClick={() => handleSelect(product)}
            >
              <Package className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="font-medium">{product.product_name}</p>
                <p className="text-xs text-muted-foreground">
                  {product.product_sku} • {formatMoney(product.costPrice, settings.currency)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
