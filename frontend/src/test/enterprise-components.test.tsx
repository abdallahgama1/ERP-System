import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, type DocumentAttachmentDto, type SavedViewDto } from "@erp/shared";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { EnterpriseDataTable, type EnterpriseColumn } from "@/components/EnterpriseDataTable";
import { AttachmentsPanel } from "@/components/AttachmentsPanel";
import { EmailDocumentDialog } from "@/components/EmailDocumentDialog";

const apiRequestMock = vi.fn();
const apiMultipartRequestMock = vi.fn();
const apiDownloadBlobMock = vi.fn();
const triggerBlobDownloadMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
    apiMultipartRequest: (...args: unknown[]) => apiMultipartRequestMock(...args),
    apiDownloadBlob: (...args: unknown[]) => apiDownloadBlobMock(...args),
    triggerBlobDownload: (...args: unknown[]) => triggerBlobDownloadMock(...args),
  };
});

interface SampleRow {
  id: string;
  sku: string;
  name: string;
  price: number;
}

const sampleUser = {
  id: "user-admin",
  name: "Admin User",
  email: "admin@erp.test",
  role: "admin" as const,
  permissions: {
    products: { view: true, create: true, edit: true, delete: true, approve: true },
    sales: { view: true, create: true, edit: true, delete: true, approve: true },
  },
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <PermissionsProvider>{ui}</PermissionsProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("EnterpriseDataTable, AttachmentsPanel & EmailDocumentDialog", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    apiMultipartRequestMock.mockReset();
    apiDownloadBlobMock.mockReset();
    triggerBlobDownloadMock.mockReset();
  });

  it("EnterpriseDataTable supports selection, bulk actions, column toggles, saved views, pagination, and server CSV/XLSX export", async () => {
    const savedView: SavedViewDto = {
      id: "view-1",
      companyId: "00000000-0000-4000-8000-000000000001",
      userId: "user-admin",
      resource: "products",
      name: "Compact View",
      configJson: { columns: { price: false }, sortBy: "sku", sortDir: "desc" },
      isDefault: false,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    };

    const viewsList: SavedViewDto[] = [savedView];
    apiRequestMock.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: sampleUser });
      if (url.startsWith("/api/saved-views") && (!opts?.method || opts.method === "GET")) {
        return Promise.resolve({ views: [...viewsList] });
      }
      if (url === "/api/saved-views" && opts?.method === "POST") {
        const created: SavedViewDto = {
          ...savedView,
          id: "view-2",
          name: "My New View",
        };
        viewsList.push(created);
        return Promise.resolve({ view: created });
      }
      if (url.startsWith("/api/saved-views/") && opts?.method === "DELETE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    apiDownloadBlobMock.mockResolvedValue({
      blob: new Blob(["sku,name\nSKU-1,Widget"], { type: "text/csv" }),
      fileName: "products.csv",
      contentType: "text/csv",
    });

    const bulkSpy = vi.fn();
    const sortSpy = vi.fn();
    const pageSpy = vi.fn();
    const applyViewSpy = vi.fn();

    const rows: SampleRow[] = [
      { id: "r1", sku: "SKU-1", name: "Widget Alpha", price: 10 },
      { id: "r2", sku: "SKU-2", name: "Widget Beta", price: 25 },
    ];

    const columns: EnterpriseColumn<SampleRow>[] = [
      { id: "sku", header: "SKU", accessorKey: "sku", sortable: true },
      { id: "name", header: "Name", accessorKey: "name" },
      { id: "price", header: "Price", accessorKey: "price", align: "end" },
    ];

    renderWithProviders(
      <EnterpriseDataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        searchValue=""
        onSearchChange={vi.fn()}
        onSortChange={sortSpy}
        pageInfo={{ page: 1, pageSize: 25, total: 2, totalPages: 1, hasNext: false, hasPrev: false }}
        onPageChange={pageSpy}
        selectable
        bulkActions={[{ id: "archive", label: "Archive Selected", onAction: bulkSpy }]}
        savedViewsResource="products"
        onApplySavedView={applyViewSpy}
        exportResource="products"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Widget Alpha")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/Search/i)).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 2")).toBeInTheDocument();

    // Select all rows -> triggers bulk actions bar
    fireEvent.click(screen.getByLabelText("Select all rows on page"));
    expect(screen.getByTestId("bulk-actions-bar")).toHaveTextContent("2 selected");
    fireEvent.click(screen.getByRole("button", { name: "Archive Selected" }));
    expect(bulkSpy).toHaveBeenCalledWith(rows, ["r1", "r2"]);

    // Save a new view
    fireEvent.click(screen.getByTestId("save-view-trigger"));
    fireEvent.change(screen.getByLabelText("View Name"), { target: { value: "My New View" } });
    fireEvent.click(screen.getByRole("button", { name: "Save View" }));
    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/saved-views", expect.objectContaining({ method: "POST" }));
    });

    // Trigger server-side CSV export
    const user = userEvent.setup();
    await user.click(screen.getByTestId("table-export-trigger"));
    const csvItem = await screen.findByText("Export CSV");
    await user.click(csvItem);

    await waitFor(() => {
      expect(apiDownloadBlobMock).toHaveBeenCalledWith("/api/exports/products?format=csv", {
        fallbackFileName: "products.csv",
      });
      expect(triggerBlobDownloadMock).toHaveBeenCalled();
    });
  });

  it("AttachmentsPanel enforces client MIME/size limits, uploads valid PDF via FormData, and confirms before delete", async () => {
    const attachment: DocumentAttachmentDto = {
      id: "att-1",
      companyId: "00000000-0000-4000-8000-000000000001",
      entityType: "invoice",
      entityId: "inv-100",
      fileName: "contract.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      sha256: "abc",
      storageDriver: "local",
      uploadedBy: "user-admin",
      uploadedByName: "Admin User",
      createdAt: "2026-11-22T12:00:00.000Z",
    };

    const currentList = [attachment];
    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: sampleUser });
      if (url.startsWith("/api/attachments?entityType=invoice")) {
        return Promise.resolve({ attachments: [...currentList] });
      }
      if (url === "/api/attachments/att-1" && opts?.method === "DELETE") {
        currentList.length = 0;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });
    apiMultipartRequestMock.mockResolvedValue({ attachment });

    renderWithProviders(<AttachmentsPanel entityType="invoice" entityId="inv-100" />);

    await waitFor(() => {
      expect(screen.getByText("contract.pdf")).toBeInTheDocument();
    });

    const fileInput = screen.getByTestId("attachment-file-input") as HTMLInputElement;

    // 1. Disallowed MIME type -> rejected client-side, no upload call
    const exeFile = new File(["mz"], "malware.exe", { type: "application/x-msdownload" });
    fireEvent.change(fileInput, { target: { files: [exeFile] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/not allowed/i);
    expect(apiMultipartRequestMock).not.toHaveBeenCalled();

    // 2. Oversized file (> 10MB) -> rejected client-side, no upload call
    const bigFile = new File(["x"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(bigFile, "size", { value: ATTACHMENT_MAX_BYTES + 1 });
    fireEvent.change(fileInput, { target: { files: [bigFile] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/10 MB/i);
    expect(apiMultipartRequestMock).not.toHaveBeenCalled();

    // 3. Valid PDF -> uploads via FormData
    const validPdf = new File(["%PDF-1.4"], "receipt.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [validPdf] } });
    await waitFor(() => {
      expect(apiMultipartRequestMock).toHaveBeenCalledWith(
        "/api/attachments",
        expect.any(FormData)
      );
    });

    // 4. Delete prompts ConfirmDeleteDialog before firing DELETE
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete Attachment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));
    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/attachments/att-1", { method: "DELETE" });
    });
  });

  it("EmailDocumentDialog validates recipients/subject and posts to /api/documents/:type/:id/email", async () => {
    const docId = "11111111-1111-4111-8111-111111111111";
    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: sampleUser });
      if (url.startsWith("/api/print-templates")) return Promise.resolve({ templates: [] });
      if (url === `/api/documents/invoice/${docId}/email` && opts?.method === "POST") {
        return Promise.resolve({
          sent: true,
          recipients: ["client@acme.test", "billing@acme.test"],
          subject: "Invoice INV-0001",
          attachmentCount: 0,
        });
      }
      return Promise.resolve({});
    });

    const onSent = vi.fn();
    const onOpenChange = vi.fn();

    renderWithProviders(
      <EmailDocumentDialog
        open
        onOpenChange={onOpenChange}
        documentType="invoice"
        documentId={docId}
        documentNumber="INV-0001"
        defaultRecipient="client@acme.test"
        onSent={onSent}
      />
    );

    const toInput = await screen.findByLabelText(/Recipients \(To\)/i);
    fireEvent.change(toInput, { target: { value: "invalid-email" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Email/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    fireEvent.change(toInput, { target: { value: "client@acme.test, billing@acme.test" } });
    fireEvent.change(screen.getByLabelText(/^Subject$/i), { target: { value: "Invoice INV-0001" } });
    fireEvent.click(screen.getByRole("button", { name: /Send Email/i }));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        `/api/documents/invoice/${docId}/email`,
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            to: ["client@acme.test", "billing@acme.test"],
            subject: "Invoice INV-0001",
          }),
        })
      );
    });
    expect(onSent).toHaveBeenCalled();
  });
});
