import { FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaxonomyManager } from "@/components/taxonomy/TaxonomyManager";

export default function Categories() {
  const { t } = useTranslation();
  return (
    <TaxonomyManager
      kind="categories"
      icon={FolderTree}
      title={t("taxonomy.categoriesTitle", "Categories")}
      description={t("taxonomy.categoriesDescription", "Maintain the list of product categories.")}
    />
  );
}