import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TablePagination } from "@/components/TablePagination";

describe("TablePagination", () => {
  it("renders range summary and invokes onPageChange for next/previous/page links", () => {
    const onPageChange = vi.fn();
    render(
      <TablePagination
        pageInfo={{
          page: 2,
          pageSize: 25,
          total: 100,
          totalPages: 4,
          hasPrev: true,
          hasNext: true,
        }}
        onPageChange={onPageChange}
      />
    );

    expect(screen.getByText("Showing 26–50 of 100")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(onPageChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByLabelText("Go to previous page"));
    expect(onPageChange).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByText("4"));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("returns null when total is zero", () => {
    const { container } = render(
      <TablePagination
        pageInfo={{ page: 1, pageSize: 25, total: 0, totalPages: 1, hasPrev: false, hasNext: false }}
        onPageChange={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
