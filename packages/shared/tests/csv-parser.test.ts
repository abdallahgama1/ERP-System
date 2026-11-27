import { describe, expect, it } from "vitest";
import {
  normalizeArabicDigits,
  parseCsvText,
  parseIsoDateString,
  parseLocalizedNumber,
  validateEtaTaxId,
  validateVendorTaxId,
} from "../src/csv.ts";

describe("Shared CSV Parser & ETA Validators", () => {
  it("strips UTF-8 BOM, preserves Arabic text, trims headers, and handles RFC 4180 quotes", () => {
    const csv = '\uFEFF" Code ", Name , Notes \r\n"C-01","شركة النيل, فرع القاهرة","Line 1\nLine ""2"""\r\n';
    const doc = parseCsvText(csv);
    expect(doc.headers).toEqual(["code", "name", "notes"]);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].rowNumber).toBe(2);
    expect(doc.rows[0].values).toEqual({
      code: "C-01",
      name: "شركة النيل, فرع القاهرة",
      notes: 'Line 1\nLine "2"',
    });
  });

  it("parses Excel numbers (thousands commas, decimal commas, parentheses, currency) and Arabic-Indic digits", () => {
    expect(normalizeArabicDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890");
    expect(parseLocalizedNumber("1,234.56")).toBe(1234.56);
    expect(parseLocalizedNumber("1.234,56")).toBe(1234.56);
    expect(parseLocalizedNumber("1234,50")).toBe(1234.5);
    expect(parseLocalizedNumber("(2,500.25)")).toBe(-2500.25);
    expect(parseLocalizedNumber("EGP 15,000.00")).toBe(15000);
    expect(parseLocalizedNumber("١٬٢٥٠٫٧٥")).toBe(1250.75);
    expect(parseLocalizedNumber("not-a-number")).toBeNull();
  });

  it("parses ISO and DD/MM/YYYY date formats including Arabic-Indic digits", () => {
    expect(parseIsoDateString("2026-01-01")).toBe("2026-01-01");
    expect(parseIsoDateString("15/01/2026")).toBe("2026-01-15");
    expect(parseIsoDateString("٢٠٢٦-٠١-٣١")).toBe("2026-01-31");
    expect(parseIsoDateString("2026-02-30")).toBeNull();
  });

  it("enforces file byte size and row limits", () => {
    expect(() => parseCsvText("a,b\n1,2\n3,4\n", { maxRows: 1 })).toThrow(/CSV_ROW_LIMIT_EXCEEDED/);
    expect(() => parseCsvText("a,b\n1,2\n", { maxBytes: 4 })).toThrow(/CSV_FILE_TOO_LARGE/);
  });

  it("validates ETA Egypt customer RIN/NID/Foreigner and vendor tax IDs", () => {
    expect(validateEtaTaxId("B", "200-300-400")).toEqual({ ok: true, normalized: "200300400" });
    expect(validateEtaTaxId("B", "٢٠٠٣٠٠٤٠٠")).toEqual({ ok: true, normalized: "200300400" });
    expect(validateEtaTaxId("B", "12345").ok).toBe(false);
    expect(validateEtaTaxId("B", "").ok).toBe(false);

    expect(validateEtaTaxId("P", "")).toEqual({ ok: true, normalized: "" });
    expect(validateEtaTaxId("P", "29001011234567")).toEqual({ ok: true, normalized: "29001011234567" });
    expect(validateEtaTaxId("P", "12345").ok).toBe(false);

    expect(validateEtaTaxId("F", "PASS-889900")).toEqual({ ok: true, normalized: "PASS-889900" });

    expect(validateVendorTaxId("400-500-600")).toEqual({ ok: true, normalized: "400500600" });
    expect(validateVendorTaxId("29001011234567")).toEqual({ ok: true, normalized: "29001011234567" });
    expect(validateVendorTaxId("1234567").ok).toBe(false);
  });
});
