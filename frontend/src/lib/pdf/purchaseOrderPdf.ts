import type jsPDF from "jspdf";
import { formatMoney } from "@/lib/money";
import type { PurchaseOrder } from "@/types";

export const generatePurchaseOrderPdf = async (po: PurchaseOrder, currency = "USD"): Promise<jsPDF> => {
  const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new JsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  
  // Header
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("PURCHASE ORDER", 14, 25);
  
  // PO Number badge
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(po.poNumber, 14, 33);
  
  // Status badge
  const statusX = pageWidth - 14;
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  
  const statusColors: Record<string, [number, number, number]> = {
    Draft: [156, 163, 175],
    Issued: [59, 130, 246],
    "Partially Received": [249, 115, 22],
    Closed: [34, 197, 94],
    Cancelled: [239, 68, 68],
  };
  
  const [r, g, b] = statusColors[po.status] || [156, 163, 175];
  doc.setTextColor(r, g, b);
  doc.text(po.status.toUpperCase(), statusX, 25, { align: "right" });
  
  // Reset text color
  doc.setTextColor(0);
  
  // Divider
  doc.setDrawColor(229, 231, 235);
  doc.line(14, 40, pageWidth - 14, 40);
  
  // Order Details Section
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("VENDOR", 14, 50);
  doc.setFont("helvetica", "normal");
  doc.text(po.vendorName, 14, 56);
  
  // Order dates on the right
  doc.setFont("helvetica", "bold");
  doc.text("ORDER DATE", pageWidth - 80, 50);
  doc.text("EXPECTED DATE", pageWidth - 80, 62);
  
  doc.setFont("helvetica", "normal");
  doc.text(new Date(po.orderDate).toLocaleDateString(), pageWidth - 14, 50, { align: "right" });
  doc.text(new Date(po.expectedDate).toLocaleDateString(), pageWidth - 14, 62, { align: "right" });
  
  if (po.referenceNumber) {
    doc.setFont("helvetica", "bold");
    doc.text("REFERENCE #", pageWidth - 80, 74);
    doc.setFont("helvetica", "normal");
    doc.text(po.referenceNumber, pageWidth - 14, 74, { align: "right" });
  }
  
  // Line Items Table
  const tableStartY = 90;
  
  autoTable(doc, {
    startY: tableStartY,
    head: [["Item", "SKU", "Qty", "Unit Price", "Tax %", "Amount"]],
    body: po.items.map((item) => [
      item.product_name,
      item.product_sku,
      item.quantity.toString(),
      formatMoney(item.unitPrice, currency),
      `${item.taxPercent}%`,
      formatMoney(item.amount, currency),
    ]),
    headStyles: {
      fillColor: [241, 245, 249],
      textColor: [71, 85, 105],
      fontStyle: "bold",
      fontSize: 9,
    },
    bodyStyles: {
      fontSize: 9,
      textColor: [51, 65, 85],
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 60 },
      1: { cellWidth: 30 },
      2: { cellWidth: 20, halign: "center" },
      3: { cellWidth: 30, halign: "right" },
      4: { cellWidth: 20, halign: "center" },
      5: { cellWidth: 30, halign: "right" },
    },
    margin: { left: 14, right: 14 },
  });
  
  // Get the final Y position after the table
  const finalY =
    (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  
  // Totals Section
  const totalsX = pageWidth - 80;
  
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text("Subtotal:", totalsX, finalY);
  doc.text("Tax:", totalsX, finalY + 8);
  
  doc.setTextColor(0);
  doc.text(formatMoney(po.subtotal, currency), pageWidth - 14, finalY, { align: "right" });
  doc.text(formatMoney(po.totalTax, currency), pageWidth - 14, finalY + 8, { align: "right" });
  
  // Grand Total
  doc.setDrawColor(229, 231, 235);
  doc.line(totalsX, finalY + 12, pageWidth - 14, finalY + 12);
  
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Grand Total:", totalsX, finalY + 20);
  doc.text(formatMoney(po.grandTotal, currency), pageWidth - 14, finalY + 20, { align: "right" });
  
  // Notes Section (if any)
  let notesY = finalY + 35;
  
  if (po.termsAndConditions) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0);
    doc.text("Terms & Conditions:", 14, notesY);
    
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    const splitTerms = doc.splitTextToSize(po.termsAndConditions, pageWidth - 28);
    doc.text(splitTerms, 14, notesY + 6);
    notesY += 6 + splitTerms.length * 5;
  }
  
  // Footer
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFontSize(8);
  doc.setTextColor(156, 163, 175);
  doc.text(
    `Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}`,
    14,
    pageHeight - 10
  );
  
  return doc;
};

export const downloadPurchaseOrderPdf = async (po: PurchaseOrder, currency = "USD") => {
  const doc = await generatePurchaseOrderPdf(po, currency);
  doc.save(`${po.poNumber}.pdf`);
};

export const printPurchaseOrder = async (po: PurchaseOrder, currency = "USD") => {
  const doc = await generatePurchaseOrderPdf(po, currency);
  doc.autoPrint();
  window.open(doc.output("bloburl"), "_blank");
};
