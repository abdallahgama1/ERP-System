export const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const CSV_MAX_ROWS = 10_000;

export interface CsvParseError {
  row: number;
  column: string;
  message: string;
  value?: string;
}

export interface ParsedCsvRow {
  /** 1-based CSV row index (header = 1, first data row = 2) */
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedCsvDocument {
  headers: string[];
  rawHeaders: string[];
  rows: ParsedCsvRow[];
}

const ARABIC_INDIC_MAP: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
  "٫": ".",
  "٬": ",",
  "−": "-",
};

/**
 * Converts Arabic-Indic and Eastern Arabic-Indic numerals and punctuation to ASCII.
 */
export function normalizeArabicDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹٫٬−]/g, (ch) => ARABIC_INDIC_MAP[ch] ?? ch);
}

/**
 * Normalizes a CSV column header: strips UTF-8 BOM, trims whitespace, lowercases,
 * collapses spaces/hyphens/slashes to underscores.
 */
export function normalizeCsvHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Parses a localized / Excel-formatted numeric string:
 * - Arabic-Indic digits (١٬٢٣٤٫٥٦)
 * - Thousands separators (1,234.56 or 1 234.56 or 1.234,56)
 * - Decimal commas (1234,56 -> 1234.56)
 * - Accounting parentheses for negatives ((1,200.50) -> -1200.5)
 * - Leading/trailing currency codes/symbols (EGP, USD, $, ج.م)
 */
export function parseLocalizedNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = normalizeArabicDigits(String(raw)).trim();
  if (!s) return null;

  // Accounting parentheses: (1,234.50) -> -1234.50
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Strip common currency prefixes/suffixes and non-breaking spaces
  s = s.replace(/\b(EGP|USD|EUR|GBP|SAR|AED)\b/gi, "");
  s = s.replace(/[£$€¥]|ج\.م\.?/g, "");
  s = s.replace(/[\u00A0\u202F\s]/g, "");

  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }

  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Whichever appears last is the decimal separator (1,234.56 vs 1.234,56)
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // European / Excel decimal comma: 1.234,56 -> 1234.56
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // Anglo thousands comma: 1,234.56 -> 1234.56
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length !== 3) {
      // Single decimal comma: 1234,5 or 1234,56 or 0,14
      s = `${parts[0]}.${parts[1]}`;
    } else if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length >= 1)) {
      // Thousands separators: 1,000 or 1,234,567
      s = parts.join("");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts.length > 2) {
      // Multiple dots -> European thousands separators (1.234.567)
      s = parts.join("");
    }
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const val = Number(s);
  if (!Number.isFinite(val)) return null;
  return negative ? -val : val;
}

export function parseLocalizedBoolean(raw: string | undefined | null, defaultVal: boolean): boolean | null {
  if (raw === undefined || raw === null) return defaultVal;
  const s = normalizeArabicDigits(String(raw)).trim().toLowerCase();
  if (!s) return defaultVal;
  if (["true", "1", "yes", "y", "نعم", "صحيح"].includes(s)) return true;
  if (["false", "0", "no", "n", "لا", "خطأ"].includes(s)) return false;
  return null;
}

export function parseIsoDateString(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const s = normalizeArabicDigits(String(raw)).trim();
  if (!s) return null;

  // Accept YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T.*)?$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  // Accept DD/MM/YYYY or DD-MM-YYYY (common Egyptian Excel export format)
  const dmyMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyMatch) {
    const d = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    const y = Number(dmyMatch[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Validates Egyptian Tax Authority (ETA) customer tax registration / national ID format.
 * - B (Business): 9-digit RIN required (hyphens/spaces allowed, normalized to 9 digits)
 * - P (Person): optional; if provided, must be 14-digit Egyptian National ID
 * - F (Foreigner): optional; up to 50 alphanumeric chars
 */
export function validateEtaTaxId(
  receiverType: "B" | "P" | "F",
  rawTaxNumber: string | undefined | null
): { ok: true; normalized: string } | { ok: false; message: string } {
  const cleaned = normalizeArabicDigits(String(rawTaxNumber ?? "")).trim();
  const digitsOnly = cleaned.replace(/[\s-]+/g, "");

  if (receiverType === "B") {
    if (!digitsOnly) {
      return {
        ok: false,
        message: "Business (B) customers require a 9-digit ETA Tax Registration Number (RIN)",
      };
    }
    if (!/^\d{9}$/.test(digitsOnly)) {
      return {
        ok: false,
        message: `Invalid ETA Business Tax Registration Number '${cleaned}' — must be exactly 9 digits`,
      };
    }
    return { ok: true, normalized: digitsOnly };
  }

  if (receiverType === "P") {
    if (!digitsOnly) return { ok: true, normalized: "" };
    if (!/^\d{14}$/.test(digitsOnly)) {
      return {
        ok: false,
        message: `Invalid Egyptian National ID '${cleaned}' for Person (P) — must be exactly 14 digits`,
      };
    }
    return { ok: true, normalized: digitsOnly };
  }

  // Foreigner (F)
  if (!cleaned) return { ok: true, normalized: "" };
  if (cleaned.length > 50 || !/^[A-Za-z0-9\-/.\s]+$/.test(cleaned)) {
    return {
      ok: false,
      message: `Invalid Foreigner (F) ID/Passport '${cleaned}'`,
    };
  }
  return { ok: true, normalized: cleaned };
}

/**
 * Validates Egyptian vendor Tax Registration Number (9-digit RIN) or National ID (14-digit NID)
 * when provided.
 */
export function validateVendorTaxId(
  rawTaxNumber: string | undefined | null
): { ok: true; normalized: string } | { ok: false; message: string } {
  const cleaned = normalizeArabicDigits(String(rawTaxNumber ?? "")).trim();
  if (!cleaned) return { ok: true, normalized: "" };
  const digitsOnly = cleaned.replace(/[\s-]+/g, "");
  if (/^\d{9}$/.test(digitsOnly) || /^\d{14}$/.test(digitsOnly)) {
    return { ok: true, normalized: digitsOnly };
  }
  return {
    ok: false,
    message: `Invalid vendor tax/national ID '${cleaned}' — must be a 9-digit ETA Tax Registration Number (RIN) or 14-digit National ID`,
  };
}

/**
 * RFC 4180 CSV parser supporting UTF-8 BOM, Arabic text, quoted fields with embedded
 * commas/newlines/escaped quotes, CRLF/LF/CR, trimmed headers, and strict byte/row limits.
 */
export function parseCsvText(
  rawCsv: string,
  options: { maxBytes?: number; maxRows?: number } = {}
): ParsedCsvDocument {
  const maxBytes = options.maxBytes ?? CSV_MAX_BYTES;
  const maxRows = options.maxRows ?? CSV_MAX_ROWS;

  const byteLength = new TextEncoder().encode(rawCsv).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(
      `CSV_FILE_TOO_LARGE: CSV payload (${byteLength} bytes) exceeds maximum limit of ${maxBytes} bytes`
    );
  }

  // Strip UTF-8 BOM if present
  const text = rawCsv.startsWith("\uFEFF") ? rawCsv.slice(1) : rawCsv;

  const rawRecords: Array<{ rowNumber: number; fields: string[] }> = [];
  let fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let lineNumber = 1;
  let recordStartLine = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") lineNumber++;
        current += ch;
      }
      continue;
    }

    if (ch === '"' && current.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
      }
      fields.push(current);
      rawRecords.push({ rowNumber: recordStartLine, fields });
      fields = [];
      current = "";
      lineNumber++;
      recordStartLine = lineNumber;
    } else {
      current += ch;
    }
  }

  if (inQuotes) {
    throw new Error(`CSV_PARSE_ERROR: Unterminated quoted field starting at row ${recordStartLine}`);
  }

  if (fields.length > 0 || current.length > 0) {
    fields.push(current);
    rawRecords.push({ rowNumber: recordStartLine, fields });
  }

  // Drop trailing/leading completely empty lines
  const nonEmpty = rawRecords.filter((rec) => rec.fields.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) {
    return { headers: [], rawHeaders: [], rows: [] };
  }

  const headerRecord = nonEmpty[0];
  const rawHeaders = headerRecord.fields.map((h) => h.replace(/^\uFEFF/, "").trim());
  const headers = rawHeaders.map(normalizeCsvHeader);

  const dataRecords = nonEmpty.slice(1);
  if (dataRecords.length > maxRows) {
    throw new Error(
      `CSV_ROW_LIMIT_EXCEEDED: CSV has ${dataRecords.length} data rows, exceeding maximum limit of ${maxRows} rows`
    );
  }

  const rows: ParsedCsvRow[] = dataRecords.map((rec) => {
    const values: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      values[key] = (rec.fields[c] ?? "").trim();
    }
    return { rowNumber: rec.rowNumber, values };
  });

  return { headers, rawHeaders, rows };
}
