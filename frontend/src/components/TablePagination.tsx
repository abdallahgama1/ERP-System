import type { OffsetPageInfo } from "@erp/shared";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

interface TablePaginationProps {
  pageInfo?: OffsetPageInfo;
  onPageChange: (page: number) => void;
  className?: string;
}

function getVisiblePages(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }
  const pages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  if (start > 2) pages.push("ellipsis");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push("ellipsis");
  pages.push(total);
  return pages;
}

export function TablePagination({ pageInfo, onPageChange, className }: TablePaginationProps) {
  if (!pageInfo || pageInfo.total === 0) return null;

  const { page, pageSize, total, totalPages, hasPrev, hasNext } = pageInfo;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const pages = getVisiblePages(page, totalPages);

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 pt-4 ${className ?? ""}`}>
      <p className="text-xs text-muted-foreground">
        Showing {from}–{to} of {total}
      </p>
      {totalPages > 1 && (
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={!hasPrev}
                className={!hasPrev ? "pointer-events-none opacity-50" : "cursor-pointer"}
                onClick={(e) => {
                  e.preventDefault();
                  if (hasPrev) onPageChange(page - 1);
                }}
              />
            </PaginationItem>
            {pages.map((entry, idx) =>
              entry === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={entry}>
                  <PaginationLink
                    href="#"
                    isActive={entry === page}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.preventDefault();
                      if (entry !== page) onPageChange(entry);
                    }}
                  >
                    {entry}
                  </PaginationLink>
                </PaginationItem>
              )
            )}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={!hasNext}
                className={!hasNext ? "pointer-events-none opacity-50" : "cursor-pointer"}
                onClick={(e) => {
                  e.preventDefault();
                  if (hasNext) onPageChange(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
