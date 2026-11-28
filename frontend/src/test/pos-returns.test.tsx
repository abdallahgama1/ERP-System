import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PosReturnDialog } from "@/components/pos/PosReturnDialog";
import { RecentReceiptsDrawer } from "@/components/pos/RecentReceiptsDrawer";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

describe("POS RecentReceiptsDrawer & PosReturnDialog", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it("searches receipts in RecentReceiptsDrawer and triggers reprint & return actions", async () => {
    const sampleReceipt = {
      id: "inv-101",
      invoiceNumber: "POS-00101",
      branchId: "br-1",
      terminalId: "term-1",
      shiftId: "shf-1",
      customerId: "cust-1",
      customerName: "Walk-in Customer",
      cashierUserId: "usr-1",
      cashierName: "Cashier Nour",
      invoiceDate: "2026-11-21T10:00:00.000Z",
      currency: "EGP",
      subtotal: 180,
      taxTotal: 25.2,
      totalAmount: 205.2,
      paidAmount: 205.2,
      totalChangeGiven: 0,
      syncStatus: "synced" as const,
      offlineClientTxId: null,
      icv: 1,
      qrTlv: null,
      etaDocumentUuid: "abcd1234",
      etaReceiptStatus: "pending_submission",
      eInvoiceStatus: "pending_submission",
      returnCount: 0,
      lines: [
        {
          id: "line-1",
          productId: "prod-1",
          description: "Arabica Coffee Pack",
          quantity: 2,
          unitPrice: 100,
          discount: 20,
          taxRate: 14,
          taxAmount: 25.2,
          lineTotal: 205.2,
          returnedQuantity: 0,
          remainingReturnableQuantity: 2,
        },
      ],
      tenders: [
        {
          method: "cash" as const,
          amount: 205.2,
          tenderedAmount: 205.2,
          changeGiven: 0,
          reference: "",
        },
      ],
    };

    apiRequestMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/pos/receipts/")) {
        return Promise.resolve({ receipt: sampleReceipt });
      }
      return Promise.resolve({ receipts: [sampleReceipt], items: [sampleReceipt] });
    });

    const onReprint = vi.fn();
    const onStartReturn = vi.fn();

    render(
      <RecentReceiptsDrawer
        open
        onOpenChange={vi.fn()}
        terminalId="term-1"
        currency="EGP"
        onReprint={onReprint}
        onStartReturn={onStartReturn}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("POS-00101").length).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText(/Search receipt POS-/i);
    fireEvent.change(searchInput, { target: { value: "POS-00101" } });

    fireEvent.click(screen.getByRole("button", { name: /Reprint/i }));
    expect(onReprint).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Return \/ Refund/i }));
    expect(onStartReturn).toHaveBeenCalledTimes(1);
  });

  it("submits partial POS return with restock checkbox, reason, and manager PIN override", async () => {
    apiRequestMock.mockResolvedValue({
      posReturn: {
        id: "ret-1",
        returnNumber: "POSR-00001",
        originalInvoiceId: "inv-101",
        refundMethod: "cash",
        restockItems: true,
        reason: "Damaged packaging",
        subtotal: 90,
        taxAmount: 12.6,
        totalAmount: 102.6,
      },
    });

    const onSuccess = vi.fn();
    render(
      <PosReturnDialog
        open
        onOpenChange={vi.fn()}
        terminalId="term-1"
        shiftId="shf-1"
        currency="EGP"
        requireManagerPin
        onSuccess={onSuccess}
        receipt={{
          id: "inv-101",
          invoiceNumber: "POS-00101",
          currency: "EGP",
          totalAmount: 205.2,
          lines: [
            {
              id: "line-1",
              productId: "prod-1",
              description: "Arabica Coffee Pack",
              quantity: 2,
              unitPrice: 100,
              lineTotal: 205.2,
              returnedQuantity: 0,
              remainingReturnableQuantity: 2,
            },
          ],
        }}
      />
    );

    const qtyInput = screen.getByLabelText(/Return quantity for Arabica Coffee Pack/i);
    fireEvent.change(qtyInput, { target: { value: "1" } });

    const restockCheckbox = screen.getByRole("checkbox");
    expect(restockCheckbox).toBeChecked();

    const reasonInput = screen.getByLabelText(/Return reason/i);
    fireEvent.change(reasonInput, { target: { value: "Damaged packaging" } });

    const pinInput = screen.getByPlaceholderText("Manager PIN");
    fireEvent.change(pinInput, { target: { value: "2468" } });

    fireEvent.click(screen.getByRole("button", { name: /Process Return/i }));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/pos/returns", {
        method: "POST",
        body: {
          originalInvoiceId: "inv-101",
          terminalId: "term-1",
          shiftId: "shf-1",
          refundMethod: "cash",
          restockItems: true,
          reason: "Damaged packaging",
          managerOverridePin: "2468",
          lines: [
            {
              originalInvoiceLineId: "line-1",
              productId: "prod-1",
              quantity: 1,
            },
          ],
        },
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });
});
