import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<unknown>;
  title?: string;
  description?: string;
  itemName?: string;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  itemName,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation();
  const confirmAction = useIdempotentAction(async () => {
    await onConfirm();
  });

  const handleOpenChange = confirmAction.guardOpenChange(onOpenChange);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          if (confirmAction.isPending) e.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {title || t("confirmDelete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {description || t("confirmDelete.description", { item: itemName || t("confirmDelete.thisItem") })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirmAction.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <SubmitButton
            type="button"
            variant="destructive"
            pending={confirmAction.isPending}
            isSlow={confirmAction.isSlow}
            onClick={() => void confirmAction.run()}
          >
            {t("common.delete")}
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
