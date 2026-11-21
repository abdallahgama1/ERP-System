import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EInvoiceQueue from "@/pages/admin/EInvoiceQueue";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
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

  beforeEach(() => {
    apiRequestMock.mockReset();
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
  });

  it("renders unconfigured ETA notice, KPI cards, 'S' and 'R' rows, payload inspection modal, and process/retry actions", async () => {
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

    // Open payload inspection modal
    const viewButtons = screen.getAllByRole("button", { name: /View Payload/i });
    fireEvent.click(viewButtons[0]);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("POS-00001");
    expect(dialog).toHaveTextContent(sampleSubmissions[0].documentUuid);

    await waitFor(() => {
      expect(dialog).toHaveTextContent('"typeVersion": "1.2"');
    });

    // Close payload inspection modal before interacting with background controls
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));

    // Trigger Process Queue / Poll ETA
    fireEvent.click(screen.getByRole("button", { name: /Process Queue \/ Poll ETA/i }));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/einvoicing/submissions/process-now", {
        method: "POST",
        body: {},
      });
    });

    // Trigger per-row Retry
    const retryButtons = screen.getAllByRole("button", { name: /^Retry$/i });
    fireEvent.click(retryButtons[0]);

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
});
