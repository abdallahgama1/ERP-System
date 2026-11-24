import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api-client";
import {
  useTaxonomyMutations,
  useTaxonomyQuery,
  type TaxonomyKind,
} from "@/hooks/queries/useTaxonomyQueries";

interface TaxonomySelectProps {
  kind: TaxonomyKind;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
}

/** Select backed by the taxonomy lists, with an inline "create new" escape hatch. */
export function TaxonomySelect({ kind, value, onChange, id, placeholder }: TaxonomySelectProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const taxonomyQuery = useTaxonomyQuery();
  const { ensureTaxonomyItem } = useTaxonomyMutations();
  const items = taxonomyQuery.data?.[kind] ?? [];
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const commit = async () => {
    const name = draft.trim();
    if (!name || isSaving) return;
    setIsSaving(true);
    try {
      await ensureTaxonomyItem(kind, name, items);
      onChange(name);
      setDraft("");
      setCreating(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onChange(name);
        setDraft("");
        setCreating(false);
      } else {
        toast({
          title: t("common.error", "Error"),
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  if (creating) {
    return (
      <div className="flex gap-2">
        <Input
          id={id}
          autoFocus
          value={draft}
          maxLength={80}
          placeholder={t("taxonomy.newValue", "New value")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setCreating(false);
              setDraft("");
            }
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="secondary"
          disabled={isSaving}
          onClick={() => void commit()}
          aria-label={t("common.save", "Save")}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => {
            setCreating(false);
            setDraft("");
          }}
          aria-label={t("common.cancel", "Cancel")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (v === "__create__") {
          setCreating(true);
          return;
        }
        onChange(v);
      }}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder ?? t("taxonomy.selectValue", "Select…")} />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.id} value={item.name}>
            {item.name}
          </SelectItem>
        ))}
        <SelectItem value="__create__">{t("taxonomy.createNew", "+ Create new")}</SelectItem>
      </SelectContent>
    </Select>
  );
}