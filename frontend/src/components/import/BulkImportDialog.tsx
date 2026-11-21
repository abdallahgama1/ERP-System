import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { exportJsonToExcel, readSpreadsheetRows } from "@/lib/export/excel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, Download, FileSpreadsheet, AlertCircle, CheckCircle2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface ImportColumn {
  key: string;
  label: string;
  required: boolean;
}

export interface ParsedRow {
  data: Record<string, unknown>;
  errors: string[];
  rowIndex: number;
}

interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  columns: ImportColumn[];
  templateFileName: string;
  onConfirmImport: (data: Record<string, unknown>[]) => Promise<void>;
  templateData?: Record<string, unknown>[];
}

export default function BulkImportDialog({
  open,
  onOpenChange,
  title,
  description,
  columns,
  templateFileName,
  onConfirmImport,
  templateData,
}: BulkImportDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ParsedRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);

  const requiredColumns = columns.filter(c => c.required);

  const resetState = () => {
    setFile(null);
    setParsedData([]);
    setValidationError(null);
    setUploadProgress(0);
    setIsLoading(false);
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      resetState();
    }
    onOpenChange(open);
  };

  const validateHeaders = useCallback(
    (headers: string[]): string[] => {
      const normalizedHeaders = headers.map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
      const missingColumns: string[] = [];

      requiredColumns.forEach(col => {
        const normalizedKey = col.key.toLowerCase().replace(/\s+/g, '_');
        if (!normalizedHeaders.includes(normalizedKey)) {
          missingColumns.push(col.label);
        }
      });

      return missingColumns;
    },
    [requiredColumns]
  );

  const normalizeHeaders = (headers: string[]): string[] => {
    return headers.map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
  };

  const parseFile = useCallback(async (file: File) => {
    setIsLoading(true);
    setValidationError(null);

    try {
      const jsonData = await readSpreadsheetRows(file);

      if (jsonData.length < 2) {
        setValidationError(t("bulkImport.noDataFound"));
        setIsLoading(false);
        return;
      }

      const firstRow = jsonData[0];
      if (!Array.isArray(firstRow)) {
        setValidationError(t("bulkImport.parseError"));
        setIsLoading(false);
        return;
      }

      const headers = firstRow.map(h => String(h || ""));
      const missingColumns = validateHeaders(headers);

      if (missingColumns.length > 0) {
        setValidationError(
          t("bulkImport.missingColumns", { columns: missingColumns.join(", ") })
        );
        toast({
          title: t("bulkImport.validationError"),
          description: t("bulkImport.missingColumnsDescription", { columns: missingColumns.join(", ") }),
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }

      const normalizedHeaders = normalizeHeaders(headers);
      const rows: ParsedRow[] = [];

      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!Array.isArray(row) || row.length === 0 || row.every(cell => cell === undefined || cell === null || cell === "")) {
          continue;
        }

        const rowData: Record<string, unknown> = {};
        const errors: string[] = [];

        normalizedHeaders.forEach((header, index) => {
          const column = columns.find(c => c.key.toLowerCase().replace(/\s+/g, '_') === header);
          if (column) {
            const value = row[index];
            rowData[column.key] = value;

            if (column.required && (value === undefined || value === null || value === "")) {
              errors.push(column.label);
            }
          }
        });

        rows.push({
          data: rowData,
          errors,
          rowIndex: i + 1,
        });
      }

      setParsedData(rows);
      setFile(file);
    } catch (error) {
      console.error("Error parsing file:", error);
      setValidationError(t("bulkImport.parseError"));
      toast({
        title: t("bulkImport.parseError"),
        description: t("bulkImport.parseErrorDescription"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [columns, t, toast, validateHeaders]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);

      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) {
        const extension = droppedFile.name.split(".").pop()?.toLowerCase();
        if (extension === "xlsx" || extension === "csv") {
          parseFile(droppedFile);
        } else {
          toast({
            title: t("bulkImport.invalidFileType"),
            description: t("bulkImport.acceptedFormats"),
            variant: "destructive",
          });
        }
      }
    },
    [parseFile, t, toast]
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      parseFile(selectedFile);
    }
  };

  const downloadTemplate = async () => {
    const headers = columns.map(c => c.label);
    const sampleData = templateData || [
      columns.reduce((acc, col) => {
        acc[col.label] = col.key.includes("price") || col.key.includes("Price") 
          ? 0 
          : col.key.includes("quantity") || col.key.includes("Quantity")
          ? 0
          : "";
        return acc;
      }, {} as Record<string, unknown>),
    ];

    await exportJsonToExcel({
      rows: sampleData,
      headers,
      sheetName: "Template",
      fileName: templateFileName,
    });
  };

  const handleConfirmImport = async () => {
    const validRows = parsedData.filter(row => row.errors.length === 0);
    
    if (validRows.length === 0) {
      toast({
        title: t("bulkImport.noValidRows"),
        description: t("bulkImport.fixErrorsFirst"),
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setUploadProgress(0);

    try {
      // Simulate progress
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 200);

      await onConfirmImport(validRows.map(row => row.data));

      clearInterval(progressInterval);
      setUploadProgress(100);

      toast({
        title: t("bulkImport.importSuccess"),
        description: t("bulkImport.rowsImported", { count: validRows.length }),
      });

      setTimeout(() => {
        handleClose(false);
      }, 500);
    } catch (error) {
      console.error("Import error:", error);
      toast({
        title: t("bulkImport.importFailed"),
        description: t("bulkImport.importFailedDescription"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const previewRows = parsedData.slice(0, 5);
  const hasErrors = parsedData.some(row => row.errors.length > 0);
  const errorCount = parsedData.filter(row => row.errors.length > 0).length;
  const validCount = parsedData.filter(row => row.errors.length === 0).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Download Template Button */}
          <div className="flex justify-end">
            <Button variant="outline" onClick={downloadTemplate} className="gap-2">
              <Download className="h-4 w-4" />
              {t("bulkImport.downloadTemplate")}
            </Button>
          </div>

          {/* File Upload Area */}
          {!file && (
            <div
              className={cn(
                "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50"
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              <input
                id="file-upload"
                type="file"
                accept=".xlsx,.csv"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Upload className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-1">{t("bulkImport.dragAndDrop")}</p>
              <p className="text-sm text-muted-foreground mb-4">
                {t("bulkImport.orClickToSelect")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("bulkImport.acceptedFormats")}
              </p>
            </div>
          )}

          {/* Validation Error */}
          {validationError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}

          {/* File Selected & Preview */}
          {file && parsedData.length > 0 && (
            <>
              {/* File Info */}
              <div className="flex items-center justify-between bg-muted/50 rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="h-8 w-8 text-primary" />
                  <div>
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {parsedData.length} {t("bulkImport.rowsFound")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={resetState}
                  disabled={isLoading}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Status Summary */}
              <div className="flex gap-4">
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span>{t("bulkImport.validRows", { count: validCount })}</span>
                </div>
                {errorCount > 0 && (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <span>{t("bulkImport.rowsWithErrors", { count: errorCount })}</span>
                  </div>
                )}
              </div>

              {/* Preview Table */}
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-muted/50 px-4 py-2 border-b">
                  <p className="text-sm font-medium">{t("bulkImport.previewFirst5")}</p>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">{t("bulkImport.row")}</TableHead>
                        {columns.map(col => (
                          <TableHead key={col.key}>
                            {col.label}
                            {col.required && <span className="text-destructive ml-1">*</span>}
                          </TableHead>
                        ))}
                        <TableHead>{t("bulkImport.status")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row) => (
                        <TableRow
                          key={row.rowIndex}
                          className={cn(row.errors.length > 0 && "bg-destructive/10")}
                        >
                          <TableCell className="font-mono text-xs">
                            {row.rowIndex}
                          </TableCell>
                          {columns.map(col => (
                            <TableCell
                              key={col.key}
                              className={cn(
                                row.errors.includes(col.label) && "text-destructive font-medium"
                              )}
                            >
                              {String(row.data[col.key] ?? "-")}
                            </TableCell>
                          ))}
                          <TableCell>
                            {row.errors.length > 0 ? (
                              <span className="text-xs text-destructive">
                                {t("bulkImport.missing")}: {row.errors.join(", ")}
                              </span>
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {parsedData.length > 5 && (
                  <div className="bg-muted/30 px-4 py-2 border-t text-sm text-muted-foreground text-center">
                    {t("bulkImport.andMoreRows", { count: parsedData.length - 5 })}
                  </div>
                )}
              </div>

              {/* Progress Bar */}
              {isLoading && uploadProgress > 0 && (
                <div className="space-y-2">
                  <Progress value={uploadProgress} className="h-2" />
                  <p className="text-sm text-center text-muted-foreground">
                    {t("bulkImport.uploading")} {uploadProgress}%
                  </p>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleClose(false)}
                  disabled={isLoading}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  onClick={handleConfirmImport}
                  disabled={isLoading || validCount === 0}
                  className="gap-2"
                >
                  {isLoading ? (
                    t("bulkImport.importing")
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      {t("bulkImport.confirmImport")} ({validCount})
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          {/* Loading State */}
          {isLoading && !file && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
