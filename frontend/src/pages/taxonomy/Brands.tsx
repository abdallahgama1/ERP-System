import { Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaxonomyManager } from "@/components/taxonomy/TaxonomyManager";

export default function Brands() {
  const { t } = useTranslation();
  return (
    <TaxonomyManager
      kind="brands"
      icon={Tag}
      title={t("taxonomy.brandsTitle", "Brands")}
      description={t("taxonomy.brandsDescription", "Maintain the list of brands used by your products.")}
    />
  );
}