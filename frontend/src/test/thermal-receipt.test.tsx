import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThermalReceiptPrintView } from "@/components/pos/ThermalReceiptPrintView";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
}));

describe("ThermalReceiptPrintView", () => {
  it("renders itemized receipt, 80mm/58mm toggle, and triggers window.print cleanly", () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});

    render(
      <ThermalReceiptPrintView
        companyName="Cairo Roasters"
        taxNumber="555666777"
        receipt={{
          id: "inv-1",
          invoiceNumber: "POS-00001",
          branchId: "b-1",
          terminalId: "t-1",
          shiftId: "s-1",
          customerId: "c-1",
          customerName: "Walk-in Customer",
          cashierUserId: "u-1",
          cashierName: "Sara",
          invoiceDate: "2026-11-21T09:30:00.000Z",
          currency: "USD",
          subtotal: 100,
          taxTotal: 14,
          totalAmount: 114,
          paidAmount: 114,
          totalChangeGiven: 6,
          syncStatus: "synced",
          offlineClientTxId: null,
          icv: 1,
          qrTlv: "https://invoicing.eta.gov.eg/receipts/search/abc/share/2026-11-21T09:30:00Z",
          etaDocumentUuid: "abcdef1234567890abcdef1234567890",
          etaReceiptStatus: "pending_submission",
          eInvoiceStatus: "pending_submission",
          lines: [
            {
              productId: "p-1",
              description: "Espresso Pack",
              quantity: 1,
              unitPrice: 100,
              discount: 0,
              taxRate: 14,
              taxAmount: 14,
              lineTotal: 114,
            },
          ],
          tenders: [{ method: "cash", amount: 114, tenderedAmount: 120, changeGiven: 6, reference: "" }],
        }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Cairo Roasters")).toBeInTheDocument();
    expect(screen.getByText("POS-00001")).toBeInTheDocument();
    expect(screen.getByText("Espresso Pack")).toBeInTheDocument();
    expect(screen.getByText("$6.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "58mm" }));
    fireEvent.click(screen.getByRole("button", { name: /Print Receipt/i }));
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
