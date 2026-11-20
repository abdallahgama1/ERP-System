import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatMoney } from "@/lib/money";
import type { Customer, Invoice, ReceivedPayment, SalesReturn } from "@/types";

export type StatementLine = {
  date: string;
  type: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
};

/**
 * Build the chronological statement of account for one customer:
 * invoices are debits, payments and credit notes are credits,
 * with a running balance after each line.
 */
export function buildStatementLines(
  invoices: Invoice[],
  payments: ReceivedPayment[],
  returns: SalesReturn[],
): StatementLine[] {
  type Raw = { date: string; type: string; reference: string; debit: number; credit: number };
  const raw: Raw[] = [];

  invoices
    .filter((i) => i.status !== "Draft" && i.status !== "Cancelled")
    .forEach((i) =>
      raw.push({ date: i.invoiceDate, type: "Invoice", reference: i.invoiceNumber, debit: i.grandTotal, credit: 0 }),
    );

  payments
    .filter((p) => p.status !== "Voided")
    .forEach((p) => {
    const applied = p.allocations.filter((a) => a.amount > 0);
    if (!applied.length && p.amount > 0) {
      raw.push({ date: p.paymentDate, type: "Payment", reference: p.paymentNumber, debit: 0, credit: p.amount });
      return;
    }
    applied.forEach((a) =>
      raw.push({
        date: p.paymentDate,
        type: "Payment",
        reference: `${p.paymentNumber} · ${a.invoiceNumber}`,
        debit: 0,
        credit: a.amount,
      }),
    );
    // Money received but not yet allocated to an invoice.
    if (p.unapplied > 0.005) {
      raw.push({
        date: p.paymentDate,
        type: "Payment",
        reference: `${p.paymentNumber} · unapplied`,
        debit: 0,
        credit: p.unapplied,
      });
    }
  });

  returns.forEach((r) =>
    raw.push({ date: r.returnDate, type: "Credit Note", reference: r.returnNumber, debit: 0, credit: r.creditTotal }),
  );

  raw.sort((a, b) => a.date.localeCompare(b.date));

  let balance = 0;
  return raw.map((r) => {
    balance += r.debit - r.credit;
    return { ...r, balance };
  });
}

export function downloadCustomerStatement(
  customer: Customer,
  invoices: Invoice[],
  payments: ReceivedPayment[],
  returns: SalesReturn[],
  currency = "USD",
) {
  const money = (n: number) => formatMoney(n, currency);
  const lines = buildStatementLines(invoices, payments, returns);
  const doc = new jsPDF();
  const w = doc.internal.pageSize.getWidth();

  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.text("STATEMENT OF ACCOUNT", 14, 25);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100);
  doc.text(`Generated ${new Date().toLocaleString()}`, w - 14, 25, { align: "right" });
  doc.setTextColor(0);
  doc.setDrawColor(229, 231, 235);
  doc.line(14, 34, w - 14, 34);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(customer.displayName, 14, 44);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100);
  const info: string[] = [];
  if (customer.companyName) info.push(customer.companyName);
  if (customer.email) info.push(customer.email);
  if (customer.phone) info.push(customer.phone);
  if (customer.taxNumber) info.push(`Tax No: ${customer.taxNumber}`);
  if (customer.billingAddress) info.push(customer.billingAddress.replace(/\n/g, ", "));
  info.forEach((line, i) => doc.text(line, 14, 50 + i * 5));
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 52 + info.length * 5 + 6,
    head: [["Date", "Type", "Reference", "Debit", "Credit", "Balance"]],
    body: lines.map((l) => [
      new Date(l.date).toLocaleDateString(),
      l.type,
      l.reference,
      l.debit > 0 ? money(l.debit) : "",
      l.credit > 0 ? money(l.credit) : "",
      money(l.balance),
    ]),
    headStyles: { fillColor: [241, 245, 249], textColor: [71, 85, 105], fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    margin: { left: 14, right: 14 },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  const net = totalDebit - totalCredit;
  const tx = w - 80;
  const totals: [string, string, boolean][] = [
    ["Total invoiced:", money(totalDebit), false],
    ["Total paid / credited:", money(totalCredit), false],
    net >= 0 ? ["Balance due:", money(net), true] : ["Credit balance:", money(-net), true],
  ];
  totals.forEach(([k, v, bold]) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.text(k, tx, y);
    doc.text(v, w - 14, y, { align: "right" });
    y += 8;
  });

  doc.setFontSize(8);
  doc.setTextColor(156, 163, 175);
  doc.text("This is a computer-generated statement.", 14, doc.internal.pageSize.getHeight() - 10);

  const safeName = customer.displayName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  doc.save(`statement-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
