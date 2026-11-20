import { Ruler } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TaxonomyManager } from "@/components/taxonomy/TaxonomyManager";

export default function UnitsOfMeasure() {
  const { t } = useTranslation();
  return (
    <TaxonomyManager
      kind="units"
      icon={Ruler}
      withCode
      withUsage={false}
      title={t("taxonomy.unitsTitle", "Units of Measure")}
      description={t("taxonomy.unitsDescription", "Define the units products are counted in.")}
    />
  );
}