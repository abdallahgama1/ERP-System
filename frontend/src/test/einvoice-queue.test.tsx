import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EInvoiceQueue from "@/pages/admin/EInvoiceQueue";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Admin E-Invoice Queue UI (EInvoiceQueue)", () => {
  const sampleSubmissions = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      invoiceId: "inv-1",
      posReturnId: null,
      documentNumber: "POS-00001",
      branchId: "br-1",
      branchName: "Main Warehouse (HQ)",
      provider: "eta_egypt" as const,
      documentType: "receipt" as const,
      receiptType: "S" as const,
      documentUuid: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
      submissionUuid: null,
      status: "pending" as const,
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
      totalAmount: 300,
      currency: "EGP",
      issuedAt: "2026-11-21T10:00:00.000Z",
      createdAt: "2026-11-21T10:00:00.000Z",
      updatedAt: "2026-11-21T10:00:00.000Z",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      invoiceId: null,
      posReturnId: "ret-1",
      documentNumber: "POSR-00001",
      branchId: "br-1",
      branchName: "Main Warehouse (HQ)",
      provider: "eta_egypt" as const,
      documentType: "receipt" as const,
      receiptType: "R" as const,
      documentUuid: "bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333",
      submissionUuid: null,
      status: "pending" as const,
      attempts: 1,
      nextRetryAt: null,
      lastError: null,
      totalAmount: 150,
      currency: "EGP",
      issuedAt: "2026-11-21T10:05:00.000Z",
      createdAt: "2026-11-21T10:05:00.000Z",
      updatedAt: "2026-11-21T10:05:00.000Z",
    },
  ];

  beforeEach(async () => {
    apiRequestMock.mockReset();
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders unconfigured ETA notice, KPI cards, 'S' and 'R' rows, payload inspection modal, and process/retry actions", async () => {
    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === "POST" && url.includes("/process-now")) {
        return Promise.resolve({
          skipped: true,
          reason: "eta_not_configured",
          processed: 0,
          accepted: 0,
          rejected: 0,
          failed: 0,
          etaConfigured: false,
        });
      }
      if (opts?.method === "POST" && url.includes("/retry")) {
        return Promise.resolve({
          queued: 1,
          processed: 0,
          etaConfigured: false,
          message: "ETA credentials not configured; submissions queued as pending",
        });
      }
      if (url.startsWith("/api/einvoicing/submissions/11111111")) {
        return Promise.resolve({
          ...sampleSubmissions[0],
          requestPayloadJson: {
            header: {
              receiptNumber: "POS-00001",
              uuid: sampleSubmissions[0].documentUuid,
            },
            documentType: { receiptType: "S", typeVersion: "1.2" },
          },
          responsePayloadJson: null,
        });
      }
      return Promise.resolve({
        items: sampleSubmissions,
        submissions: sampleSubmissions,
        summary: {
          pending: 2,
          submitted: 0,
          accepted: 0,
          rejected: 0,
          failed: 0,
          total: 2,
          etaConfigured: false,
        },
        pageInfo: {
          page: 1,
          pageSize: 25,
          total: 2,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      });
    });

    renderWithQueryClient(<EInvoiceQueue />);

    expect(
      screen.getByRole("heading", { level: 1, name: /E-Invoicing & ETA Queue/i })
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("POS-00001")).toBeInTheDocument();
      expect(screen.getByText("POSR-00001")).toBeInTheDocument();
    });

    expect(screen.getByTestId("eta-unconfigured-banner")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-pending")).toHaveTextContent("2");
    expect(screen.getByText(/S · Sale/i)).toBeInTheDocument();
    expect(screen.getByText(/R · Return/i)).toBeInTheDocument();

    const viewButtons = screen.getAllByRole("button", { name: /View Payload/i });
    fireEvent.click(viewButtons[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("POS-00001");
    expect(dialog).toHaveTextContent(sampleSubmissions[0].documentUuid);

    await waitFor(() => {
      expect(dialog).toHaveTextContent('"typeVersion": "1.2"');
    });

    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    fireEvent.click(screen.getByRole("button", { name: /Process Queue \/ Poll ETA/i }));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/einvoicing/submissions/process-now", {
        method: "POST",
        body: {},
      });
    });

    const retryButtons = screen.getAllByRole("button", { name: /^Retry$/i });
    fireEvent.click(retryButtons[0]!);

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        `/api/einvoicing/submissions/${sampleSubmissions[0].id}/retry`,
        {
          method: "POST",
          body: { resetAttempts: true },
        }
      );
    });
  });

  it("surfaces full ETA error text, next retry schedule, Retry Failed & Rejected button, and structured validation details", async () => {
    const nextRetryIso = "2026-11-28T10:15:00.000Z";
    const errorItems = [
      {
        id: "sub-failed-1",
        invoiceId: "inv-1",
        posReturnId: null,
        salesReturnId: null,
        documentNumber: "INV-2026-001",
        branchId: "b-1",
        branchName: "Main HQ",
        provider: "eta_egypt",
        documentType: "invoice",
        receiptType: null,
        etaDocumentTypeCode: "I",
        documentVersion: "1.0",
        signatureStatus: "signed",
        documentUuid: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
        submissionUuid: null,
        status: "failed",
        attempts: 2,
        nextRetryAt: nextRetryIso,
        lastError: "ETA document submission failed (503): Service Unavailable",
        totalAmount: 1140,
        currency: "EGP",
        issuedAt: "2026-11-28T09:00:00.000Z",
        createdAt: "2026-11-28T09:00:00.000Z",
        updatedAt: "2026-11-28T09:05:00.000Z",
      },
      {
        id: "sub-rejected-2",
        invoiceId: "inv-2",
        posReturnId: null,
        salesReturnId: null,
        documentNumber: "INV-2026-002",
        branchId: "b-1",
        branchName: "Main HQ",
        provider: "eta_egypt",
        documentType: "invoice",
        receiptType: null,
        etaDocumentTypeCode: "I",
        documentVersion: "1.0",
        signatureStatus: "signed",
        documentUuid: "bbbb1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
        submissionUuid: "SUB-ETA-99",
        status: "rejected",
        attempts: 1,
        nextRetryAt: null,
        lastError: "invoiceLines[0].itemCode: EGS item code is not approved",
        totalAmount: 2280,
        currency: "EGP",
        issuedAt: "2026-11-28T09:10:00.000Z",
        createdAt: "2026-11-28T09:10:00.000Z",
        updatedAt: "2026-11-28T09:11:00.000Z",
      },
    ];

    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.startsWith("/api/einvoicing/submissions/sub-rejected-2")) {
        return Promise.resolve({
          ...errorItems[1],
          requestPayloadJson: { internalID: "INV-2026-002", documentType: "I" },
          responsePayloadJson: {
            rejectedDocuments: [
              {
                internalId: "INV-2026-002",
                error: {
                  message: "Validation Error",
                  details: [
                    {
                      code: "CF344",
                      propertyPath: "invoiceLines[0].itemCode",
                      message: "EGS item code is not approved",
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      if (url === "/api/einvoicing/submissions/retry" && opts?.method === "POST") {
        return Promise.resolve({ queued: 2, processed: 0, etaConfigured: true, message: "Queued 2 submissions" });
      }
      if (url.startsWith("/api/einvoicing/submissions")) {
        return Promise.resolve({
          items: errorItems,
          submissions: errorItems,
          summary: {
            pending: 0,
            submitted: 0,
            accepted: 0,
            rejected: 1,
            failed: 1,
            total: 2,
            etaConfigured: true,
          },
          pageInfo: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
        });
      }
      return Promise.resolve({});
    });

    renderWithQueryClient(<EInvoiceQueue />);

    await waitFor(() => {
      expect(screen.getByText("INV-2026-001")).toBeInTheDocument();
      expect(screen.getByText("INV-2026-002")).toBeInTheDocument();
    });

    const errorCells = screen.getAllByTestId("submission-error-text");
    expect(errorCells[0]).toHaveTextContent("ETA document submission failed (503): Service Unavailable");
    expect(errorCells[1]).toHaveTextContent("invoiceLines[0].itemCode: EGS item code is not approved");
    expect(screen.getByTestId("submission-next-retry")).toHaveTextContent(/Next retry/i);

    fireEvent.click(screen.getByTestId("retry-all-failed-btn"));
    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        "/api/einvoicing/submissions/retry",
        expect.objectContaining({ method: "POST" })
      );
    });

    const viewButtons = screen.getAllByRole("button", { name: /View Payload/i });
    fireEvent.click(viewButtons[1]!);

    await waitFor(() => {
      expect(screen.getByTestId("detail-eta-error")).toBeInTheDocument();
      expect(screen.getByTestId("detail-eta-validation-errors")).toHaveTextContent(
        "[CF344] invoiceLines[0].itemCode: EGS item code is not approved"
      );
    });
  });
});
