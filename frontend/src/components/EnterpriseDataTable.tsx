import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  Download,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { ExportQuery, ExportResource, OffsetPageInfo, SavedViewConfig } from "@erp/shared";
import { apiDownloadBlob, buildExportUrl, triggerBlobDownload } from "@/lib/api-client";
import { useSavedViewMutations, useSavedViewsQuery } from "@/hooks/queries/useSavedViewsQueries";
import { TablePagination } from "@/components/TablePagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { useActionLocks } from "@/hooks/useIdempotentSubmit";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface EnterpriseColumn<T> {
  id: string;
  header: string | ReactNode;
  accessorKey?: keyof T;
  cell?: (row: T) => ReactNode;
  sortable?: boolean;
  sortKey?: string;
  hideable?: boolean;
  defaultVisible?: boolean;
  align?: "start" | "end" | "center";
  headerClassName?: string;
  cellClassName?: string;
}

export interface EnterpriseBulkAction<T> {
  id: string;
  label: string;
  icon?: ReactNode;
  variant?: "default" | "destructive" | "outline" | "secondary";
  disabled?: boolean;
  onAction: (selectedRows: T[], selectedIds: string[]) => void | Promise<void>;
}

export interface EnterpriseDataTableProps<T> {
  data: T[];
  columns: EnterpriseColumn<T>[];
  getRowId: (row: T) => string;
  isLoading?: boolean;
  emptyMessage?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  toolbarExtra?: ReactNode;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  onSortChange?: (sortBy: string, sortDir: "asc" | "desc") => void;
  pageInfo?: OffsetPageInfo;
  onPageChange?: (page: number) => void;
  selectable?: boolean;
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  bulkActions?: EnterpriseBulkAction<T>[];
  enableColumnVisibility?: boolean;
  savedViewsResource?: string;
  activeFilters?: Record<string, unknown>;
  onApplySavedView?: (config: SavedViewConfig) => void;
  exportResource?: ExportResource;
  exportParams?: Omit<ExportQuery, "format">;
  onRowClick?: (row: T) => void;
  renderRowExpansion?: (row: T) => ReactNode;
  isRowExpanded?: (row: T) => boolean;
  testId?: string;
}

export function EnterpriseDataTable<T>({
  data,
  columns,
  getRowId,
  isLoading = false,
  emptyMessage,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  toolbarExtra,
  sortBy,
  sortDir = "asc",
  onSortChange,
  pageInfo,
  onPageChange,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
  bulkActions = [],
  enableColumnVisibility = true,
  savedViewsResource,
  activeFilters,
  onApplySavedView,
  exportResource,
  exportParams,
  onRowClick,
  renderRowExpansion,
  isRowExpanded,
  testId,
}: EnterpriseDataTableProps<T>) {
  const { t } = useTranslation();
  const viewLocks = useActionLocks();

  // Column visibility state
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const col of columns) {
      initial[col.id] = col.defaultVisible !== false;
    }
    return initial;
  });

  // Selection state (controlled or uncontrolled)
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([]);
  const selectedIds = controlledSelectedIds ?? internalSelectedIds;
  const setSelectedIds = (next: string[]) => {
    if (controlledSelectedIds === undefined) {
      setInternalSelectedIds(next);
    }
    onSelectedIdsChange?.(next);
  };

  // Saved Views state
  const savedViewsQuery = useSavedViewsQuery(savedViewsResource, Boolean(savedViewsResource));
  const { createSavedView, deleteSavedView } = useSavedViewMutations();
  const savedViews = useMemo(() => savedViewsQuery.data?.views ?? [], [savedViewsQuery.data]);
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewDefault, setNewViewDefault] = useState(false);
  const appliedDefaultRef = useRef<string | null>(null);

  const [isExporting, setIsExporting] = useState(false);

  const applyViewConfig = (config: SavedViewConfig) => {
    if (config.columns) {
      setColumnVisibility((prev) => ({ ...prev, ...config.columns }));
    }
    if (config.sortBy && onSortChange) {
      onSortChange(config.sortBy, config.sortDir ?? "asc");
    }
    onApplySavedView?.(config);
  };

  useEffect(() => {
    if (!savedViewsResource || savedViews.length === 0) return;
    if (appliedDefaultRef.current === savedViewsResource) return;
    const defaultView = savedViews.find((v) => v.isDefault);
    if (defaultView) {
      appliedDefaultRef.current = savedViewsResource;
      applyViewConfig(defaultView.configJson);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViewsResource, savedViews]);

  const visibleColumns = useMemo(
    () =>
      columns.filter((col) => {
        if (col.hideable === false) return true;
        return columnVisibility[col.id] ?? col.defaultVisible !== false;
      }),
    [columns, columnVisibility]
  );

  const rowIdsOnPage = useMemo(() => data.map((row) => getRowId(row)), [data, getRowId]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedOnPageCount = rowIdsOnPage.filter((id) => selectedSet.has(id)).length;
  const allSelected = rowIdsOnPage.length > 0 && selectedOnPageCount === rowIdsOnPage.length;
  const someSelected = selectedOnPageCount > 0 && !allSelected;

  const selectedRows = useMemo(
    () => data.filter((row) => selectedSet.has(getRowId(row))),
    [data, selectedSet, getRowId]
  );

  const toggleAllOnPage = () => {
    if (allSelected) {
      setSelectedIds(selectedIds.filter((id) => !rowIdsOnPage.includes(id)));
    } else {
      const merged = new Set([...selectedIds, ...rowIdsOnPage]);
      setSelectedIds(Array.from(merged));
    }
  };

  const toggleRow = (id: string) => {
    if (selectedSet.has(id)) {
      setSelectedIds(selectedIds.filter((existing) => existing !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  const handleSortClick = (col: EnterpriseColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    const key = col.sortKey ?? col.id;
    const nextDir: "asc" | "desc" = sortBy === key && sortDir === "asc" ? "desc" : "asc";
    onSortChange(key, nextDir);
  };

  const handleSaveView = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!savedViewsResource) return;
    const trimmed = newViewName.trim();
    if (!trimmed) {
      toast.error(t("savedViews.nameRequired", "View name is required"));
      return;
    }
    try {
      await createSavedView.mutateAsync({
        resource: savedViewsResource,
        name: trimmed,
        isDefault: newViewDefault,
        configJson: {
          columns: columnVisibility,
          ...(sortBy ? { sortBy, sortDir } : {}),
          ...(activeFilters ? { filters: activeFilters } : {}),
          ...(pageInfo?.pageSize ? { pageSize: pageInfo.pageSize } : {}),
        },
      });
      toast.success(
        t("savedViews.saved", { defaultValue: 'Saved view "{{name}}"', name: trimmed })
      );
      setNewViewName("");
      setNewViewDefault(false);
      setSavePopoverOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error", "Error"));
    }
  };

  const handleDeleteView = async (id: string, name: string) => {
    try {
      await deleteSavedView.mutateAsync(id);
      toast.success(
        t("savedViews.deleted", { defaultValue: 'Deleted saved view "{{name}}"', name })
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error", "Error"));
    }
  };

  const handleExport = async (format: "csv" | "xlsx") => {
    if (!exportResource || isExporting) return;
    setIsExporting(true);
    try {
      const url = buildExportUrl(exportResource, {
        ...exportParams,
        ...(searchValue?.trim() ? { q: searchValue.trim() } : {}),
        format,
      });
      const fallback = `${exportResource}.${format}`;
      const { blob, fileName } = await apiDownloadBlob(url, { fallbackFileName: fallback });
      triggerBlobDownload(blob, fileName ?? fallback);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("dataTable.exportFailed", "Failed to export data")
      );
    } finally {
      setIsExporting(false);
    }
  };

  const alignClass = (align?: "start" | "end" | "center") => {
    if (align === "end") return "text-end";
    if (align === "center") return "text-center";
    return "text-start";
  };

  const hideableColumns = columns.filter((c) => c.hideable !== false);
  const totalColSpan = visibleColumns.length + (selectable ? 1 : 0);

  return (
    <div className="space-y-3" data-testid={testId}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
          {onSearchChange && (
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="ps-9"
                placeholder={searchPlaceholder ?? t("common.searchPlaceholder", "Search...")}
                value={searchValue ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
          )}
          {toolbarExtra}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Saved Views */}
          {savedViewsResource && (
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm" data-testid="saved-views-trigger">
                    <Bookmark className="h-4 w-4 me-1.5" />
                    <span>{t("savedViews.title", "Saved Views")}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>{t("savedViews.title", "Saved Views")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {savedViews.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                      {t("savedViews.noViews", "No saved views yet")}
                    </div>
                  ) : (
                    savedViews.map((view) => (
                      <DropdownMenuItem
                        key={view.id}
                        className="flex items-center justify-between gap-2"
                        onSelect={() => applyViewConfig(view.configJson)}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate">{view.name}</span>
                          {view.isDefault && (
                            <Badge variant="secondary" className="text-[10px] px-1 py-0">
                              {t("savedViews.defaultBadge", "Default")}
                            </Badge>
                          )}
                        </div>
                        <SubmitButton
                          type="button"
                          variant="ghost"
                          size="icon"
                          pending={viewLocks.isPending(`del-view:${view.id}`)}
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label={t("common.delete", "Delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void viewLocks.runLocked(`del-view:${view.id}`, () =>
                              handleDeleteView(view.id, view.name)
                            );
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </SubmitButton>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("savedViews.saveCurrent", "Save current view")}
                    data-testid="save-view-trigger"
                  >
                    <Plus className="h-4 w-4 me-1" />
                    <span className="hidden sm:inline">{t("savedViews.saveCurrent", "Save current view")}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72">
                  <form onSubmit={handleSaveView} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="saved-view-name">{t("savedViews.viewName", "View Name")}</Label>
                      <Input
                        id="saved-view-name"
                        value={newViewName}
                        onChange={(e) => setNewViewName(e.target.value)}
                        placeholder={t("savedViews.viewNamePlaceholder", "e.g. Open High-Value Invoices")}
                        maxLength={80}
                        required
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="saved-view-default"
                        checked={newViewDefault}
                        onCheckedChange={(checked) => setNewViewDefault(checked === true)}
                      />
                      <Label htmlFor="saved-view-default" className="text-xs font-normal cursor-pointer">
                        {t("savedViews.setAsDefault", "Set as default view")}
                      </Label>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSavePopoverOpen(false)}
                      >
                        {t("common.cancel", "Cancel")}
                      </Button>
                      <Button type="submit" size="sm" disabled={createSavedView.isPending}>
                        {t("savedViews.save", "Save View")}
                      </Button>
                    </div>
                  </form>
                </PopoverContent>
              </Popover>
            </div>
          )}

          {/* Column Visibility */}
          {enableColumnVisibility && hideableColumns.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" data-testid="column-visibility-trigger">
                  <SlidersHorizontal className="h-4 w-4 me-1.5" />
                  <span>{t("dataTable.columns", "Columns")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>{t("dataTable.toggleColumns", "Toggle visible columns")}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideableColumns.map((col) => {
                  const isVisible = columnVisibility[col.id] ?? col.defaultVisible !== false;
                  return (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={isVisible}
                      onCheckedChange={(checked) =>
                        setColumnVisibility((prev) => ({
                          ...prev,
                          [col.id]: checked === true,
                        }))
                      }
                    >
                      {typeof col.header === "string" ? col.header : col.id}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Server-Side Export */}
          {exportResource && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isExporting}
                  data-testid="table-export-trigger"
                >
                  {isExporting ? (
                    <Loader2 className="h-4 w-4 me-1.5 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 me-1.5" />
                  )}
                  <span>{isExporting ? t("common.exporting", "Exporting...") : t("dataTable.export", "Export")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void handleExport("csv")}>
                  {t("common.exportCsv", "Export CSV")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleExport("xlsx")}>
                  {t("common.exportXlsx", "Export Excel (.xlsx)")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {selectable && selectedIds.length > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          data-testid="bulk-actions-bar"
        >
          <div className="flex items-center gap-2">
            <Badge variant="secondary">
              {t("dataTable.selectedCount", {
                defaultValue: "{{count}} selected",
                count: selectedIds.length,
              })}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setSelectedIds([])}
            >
              {t("dataTable.clearSelection", "Clear selection")}
            </Button>
          </div>
          {bulkActions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {bulkActions.map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  size="sm"
                  variant={action.variant ?? "outline"}
                  disabled={action.disabled}
                  onClick={() => void action.onAction(selectedRows, selectedIds)}
                >
                  {action.icon && <span className="me-1.5">{action.icon}</span>}
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Data Table */}
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10 text-center">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleAllOnPage}
                    aria-label={t("dataTable.selectAll", "Select all rows on page")}
                  />
                </TableHead>
              )}
              {visibleColumns.map((col) => {
                const key = col.sortKey ?? col.id;
                const isSorted = sortBy === key;
                return (
                  <TableHead
                    key={col.id}
                    className={`${alignClass(col.align)} ${col.headerClassName ?? ""}`}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => handleSortClick(col)}
                        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                        aria-label={
                          isSorted && sortDir === "asc"
                            ? t("dataTable.sortDescending", "Sort descending")
                            : t("dataTable.sortAscending", "Sort ascending")
                        }
                      >
                        <span>{col.header}</span>
                        {isSorted ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <TableRow key={`skeleton-${idx}`}>
                  {Array.from({ length: totalColSpan }).map((__, cellIdx) => (
                    <TableCell key={cellIdx}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={totalColSpan} className="h-24 text-center text-muted-foreground">
                  {emptyMessage ?? t("common.noResults", "No results found")}
                </TableCell>
              </TableRow>
            ) : (
              data.map((row) => {
                const id = getRowId(row);
                const isSelected = selectedSet.has(id);
                const expanded = renderRowExpansion && isRowExpanded ? isRowExpanded(row) : false;
                return (
                  <Fragment key={id}>
                    <TableRow
                      data-state={isSelected ? "selected" : undefined}
                      className={onRowClick ? "cursor-pointer" : undefined}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {selectable && (
                        <TableCell
                          className="w-10 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(id)}
                            aria-label={t("dataTable.selectRow", "Select row")}
                          />
                        </TableCell>
                      )}
                      {visibleColumns.map((col) => (
                        <TableCell
                          key={col.id}
                          className={`${alignClass(col.align)} ${col.cellClassName ?? ""}`}
                        >
                          {col.cell
                            ? col.cell(row)
                            : col.accessorKey
                              ? String((row as Record<string, unknown>)[col.accessorKey as string] ?? "")
                              : null}
                        </TableCell>
                      ))}
                    </TableRow>
                    {expanded && renderRowExpansion && (
                      <TableRow>
                        <TableCell colSpan={totalColSpan} className="bg-muted/20 p-4">
                          {renderRowExpansion(row)}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {onPageChange && <TablePagination pageInfo={pageInfo} onPageChange={onPageChange} />}
    </div>
  );
}
