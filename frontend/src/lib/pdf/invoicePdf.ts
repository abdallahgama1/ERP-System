import type jsPDF from "jspdf";
import { formatMoney } from "@/lib/money";
import type { Invoice } from "@/types";

export const generateInvoicePdf = async (
  inv: Invoice,
  currency = "USD",
  qrDataUrl?: string | null
): Promise<jsPDF> => {
  const [{ default: JsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new JsPDF();
  const w = doc.internal.pageSize.getWidth();
  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("INVOICE", 14, 25);
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(inv.invoiceNumber, 14, 33);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(inv.status.toUpperCase(), w - 14, 25, { align: "right" });
  doc.setTextColor(0);
  doc.setDrawColor(229, 231, 235);
  doc.line(14, 40, w - 14, 40);

  doc.text("BILL TO", 14, 50);
  doc.setFont("helvetica", "normal");
  doc.text(inv.customerName, 14, 56);

  const rows: [string, string][] = [
    ["INVOICE DATE", new Date(inv.invoiceDate).toLocaleDateString()],
    ["DUE DATE", new Date(inv.dueDate).toLocaleDateString()],
  ];
  if (inv.soNumber) rows.push(["SALES ORDER", inv.soNumber]);
  rows.forEach(([k, v], i) => {
    doc.setFont("helvetica", "bold");
    doc.text(k, w - 80, 50 + i * 8);
    doc.setFont("helvetica", "normal");
    doc.text(v, w - 14, 50 + i * 8, { align: "right" });
  });

  autoTable(doc, {
    startY: 80,
    head: [["Item", "SKU", "Qty", "Unit Price", "Tax %", "Amount"]],
    body: inv.items.map((it) => [
      it.product_name, it.product_sku, String(it.quantity),
      formatMoney(it.unitPrice, currency), `${it.taxPercent}%`, formatMoney(it.amount, currency),
    ]),
    headStyles: { fillColor: [241, 245, 249], textColor: [71, 85, 105], fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 2: { halign: "center" }, 3: { halign: "right" }, 4: { halign: "center" }, 5: { halign: "right" } },
    margin: { left: 14, right: 14 },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  const tx = w - 80;
  const balance = Math.max(0, inv.grandTotal - inv.amountPaid);
  const totals: [string, string, boolean][] = [
    ["Subtotal:", formatMoney(inv.subtotal, currency), false],
    ["Tax:", formatMoney(inv.totalTax, currency), false],
    ["Grand Total:", formatMoney(inv.grandTotal, currency), true],
    ["Paid:", formatMoney(inv.amountPaid, currency), false],
    ["Balance Due:", formatMoney(balance, currency), true],
  ];
  totals.forEach(([k, v, bold]) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.text(k, tx, y);
    doc.text(v, w - 14, y, { align: "right" });
    y += 8;
  });

  if (inv.notes) {
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.text("Notes:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(doc.splitTextToSize(inv.notes, w - 65), 14, y + 6);
  }
  if (qrDataUrl) {
    const qrY = Math.min(y + 4, doc.internal.pageSize.getHeight() - 52);
    doc.addImage(qrDataUrl, "PNG", w - 48, qrY, 34, 34);
    doc.setFontSize(7);
    doc.setTextColor(100);
    if (inv.icv) doc.text(`ICV #${inv.icv}`, w - 48, qrY + 38);
    if (inv.invoiceHash) doc.text(`Hash: ${inv.invoiceHash.slice(0, 16)}...`, 14, doc.internal.pageSize.getHeight() - 16);
  }
  doc.setFontSize(8);
  doc.setTextColor(156, 163, 175);
  doc.text(`Generated on ${new Date().toLocaleString()}`, 14, doc.internal.pageSize.getHeight() - 10);
  return doc;
};

export const downloadInvoicePdf = async (inv: Invoice, currency = "USD") => {
  let qrDataUrl: string | null = null;
  if (inv.qrTlv) {
    try {
      const QRCode = await import("qrcode");
      qrDataUrl = await QRCode.toDataURL(inv.qrTlv, { width: 160, margin: 1 });
    } catch {
      qrDataUrl = null;
    }
  }
  const doc = await generateInvoicePdf(inv, currency, qrDataUrl);
  doc.save(`${inv.invoiceNumber}.pdf`);
};
