import { describe, expect, it } from "vitest";
import { parseBankStatementCsv } from "../../src/services/treasury.service.ts";

describe("Wave 2A Bank Statement CSV Parser", () => {
  it("parses signed amount CSV with quoted commas, currency formatting, and parenthesized negatives", () => {
    const csv = [
      "\uFEFFdate,description,reference,amount,balance",
      '2026-11-10,"Customer Wire, Cairo Branch",WIRE-001,"$1,500.50","11,500.50"',
      '2026-11-11,"Monthly Bank Maintenance, SMS",FEE-11,(25.00),"11,475.50"',
    ].join("\r\n");

    const rows = parseBankStatementCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      description: "Customer Wire, Cairo Branch",
      reference: "WIRE-001",
      amount: 1500.5,
      runningBalance: 11500.5,
    });
    expect(rows[1]).toMatchObject({
      description: "Monthly Bank Maintenance, SMS",
      reference: "FEE-11",
      amount: -25,
      runningBalance: 11475.5,
    });
  });

  it("parses separate debit and credit columns into signed amounts (+credit / -debit)", () => {
    const csv = [
      "Transaction Date,Narration,Debit,Credit,Ref",
      "2026-11-12,POS Card Settlement,,850.25,SETTLE-9",
      "2026-11-13,Electricity Direct Debit,320.00,,UTIL-4",
    ].join("\n");

    const rows = parseBankStatementCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.amount).toBe(850.25);
    expect(rows[1]?.amount).toBe(-320);
  });

  it("rejects CSVs missing required columns, malformed dates, or zero amounts", () => {
    expect(() => parseBankStatementCsv("date,description\n2026-11-01,Only two cols")).toThrow(
      /amount.*debit/i
    );
    expect(() => parseBankStatementCsv("description,amount\nWire,100")).toThrow(/date/i);
    expect(() => parseBankStatementCsv("date,amount\nnot-a-date,100")).toThrow(/Invalid date/i);
    expect(() => parseBankStatementCsv("date,amount\n2026-11-01,0")).toThrow(/Invalid or zero amount/i);
  });
});
