import { describe, expect, it, vi } from "vitest";

const writeFileMock = vi.fn();
const jsonToSheetMock = vi.fn(() => ({ sheet: true }));
const bookNewMock = vi.fn(() => ({ book: true }));
const bookAppendSheetMock = vi.fn();

vi.mock("xlsx", () => ({
  utils: {
    json_to_sheet: jsonToSheetMock,
    book_new: bookNewMock,
    book_append_sheet: bookAppendSheetMock,
  },
  writeFile: writeFileMock,
}));

describe("lazy export helpers", () => {
  it("dynamically loads xlsx only when exportJsonToExcel is invoked", async () => {
    const { exportJsonToExcel } = await import("@/lib/export/excel");
    expect(writeFileMock).not.toHaveBeenCalled();

    await exportJsonToExcel({
      rows: [{ SKU: "A-1", Name: "Widget" }],
      sheetName: "Products",
      fileName: "products.xlsx",
    });

    expect(jsonToSheetMock).toHaveBeenCalledTimes(1);
    expect(bookAppendSheetMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith({ book: true }, "products.xlsx");
  });
});
