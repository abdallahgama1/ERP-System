export interface ExcelExportOptions {
  rows: Record<string, unknown>[];
  sheetName: string;
  fileName: string;
  headers?: string[];
}

export async function exportJsonToExcel(options: ExcelExportOptions): Promise<void> {
  const XLSX = await import("xlsx");
  const worksheet = options.headers
    ? XLSX.utils.json_to_sheet(options.rows, { header: options.headers })
    : XLSX.utils.json_to_sheet(options.rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, options.sheetName);
  XLSX.writeFile(workbook, options.fileName);
}

export async function readSpreadsheetRows(file: File): Promise<unknown[][]> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer);
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1 });
}
