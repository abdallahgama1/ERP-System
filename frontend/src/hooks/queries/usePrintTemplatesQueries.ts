import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIdempotentMutation as useMutation } from "@/hooks/useIdempotentSubmit";
import type {
  CreatePrintTemplateInput,
  EmailDocumentInput,
  EmailDocumentResponseDto,
  EmailableDocumentType,
  PrintTemplateDocType,
  PrintTemplateDto,
  UpdatePrintTemplateInput,
} from "@erp/shared";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/lib/api-client";
import { erpQueryKeys } from "./queryKeys";

export function usePrintTemplatesQuery(documentType?: PrintTemplateDocType, enabled = true) {
  const { user } = useAuth();
  const qs = documentType ? `?documentType=${encodeURIComponent(documentType)}` : "";

  return useQuery({
    queryKey: erpQueryKeys.printTemplates.list(documentType),
    queryFn: () => apiRequest<{ templates: PrintTemplateDto[] }>(`/api/print-templates${qs}`),
    enabled: Boolean(user) && enabled,
    staleTime: 60_000,
  });
}

export function usePrintTemplateMutations() {
  const queryClient = useQueryClient();

  const invalidateTemplates = () => {
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.printTemplates.all });
    void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
  };

  const createPrintTemplate = useMutation({
    mutationFn: (body: CreatePrintTemplateInput) =>
      apiRequest<{ template: PrintTemplateDto }>("/api/print-templates", { method: "POST", body }),
    onSuccess: invalidateTemplates,
  });

  const updatePrintTemplate = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdatePrintTemplateInput }) =>
      apiRequest<{ template: PrintTemplateDto }>(`/api/print-templates/${id}`, { method: "PUT", body }),
    onSuccess: invalidateTemplates,
  });

  const deletePrintTemplate = useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: boolean }>(`/api/print-templates/${id}`, { method: "DELETE" }),
    onSuccess: invalidateTemplates,
  });

  return {
    createPrintTemplate,
    updatePrintTemplate,
    deletePrintTemplate,
  };
}

export function useEmailDocumentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      documentType,
      documentId,
      body,
    }: {
      documentType: EmailableDocumentType;
      documentId: string;
      body: EmailDocumentInput;
    }) =>
      apiRequest<EmailDocumentResponseDto>(`/api/documents/${documentType}/${documentId}/email`, {
        method: "POST",
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpQueryKeys.auditLogs });
    },
  });
}
