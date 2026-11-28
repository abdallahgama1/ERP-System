import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { ApiError, getActiveIdempotencyKey } from "@/lib/api-client";

const FRONTEND_SRC = path.resolve(__dirname, "..");

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      walkTsFiles(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("Idempotent Submit Static Architecture Guards", () => {
  it("forbids raw <Button type=\"submit\"> outside SubmitButton and non-mutating ScannerInput", () => {
    const pagesAndComponents = [
      ...walkTsFiles(path.join(FRONTEND_SRC, "pages")),
      ...walkTsFiles(path.join(FRONTEND_SRC, "components")),
    ];
    const allowedRelPaths = new Set([
      "components/ui/submit-button.tsx",
      "components/session/ScannerInput.tsx",
    ]);

    const offenders: string[] = [];
    for (const file of pagesAndComponents) {
      const rel = path.relative(FRONTEND_SRC, file).replace(/\\/g, "/");
      if (allowedRelPaths.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      // Match `<Button` opening tags containing `type="submit"` before `>`
      const buttonTags = src.match(/<Button\b[^>]*>/gs) ?? [];
      for (const tag of buttonTags) {
        if (/\btype\s*=\s*["']submit["']/.test(tag)) {
          offenders.push(`${rel}: ${tag.replace(/\s+/g, " ").trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("forbids direct useMutation imports from @tanstack/react-query outside useIdempotentSubmit.ts", () => {
    const allFiles = walkTsFiles(FRONTEND_SRC);
    const offenders: string[] = [];

    for (const file of allFiles) {
      const rel = path.relative(FRONTEND_SRC, file).replace(/\\/g, "/");
      if (rel === "hooks/useIdempotentSubmit.ts") continue;
      const src = fs.readFileSync(file, "utf8");
      if (/import\s+\{[^}]*\buseMutation\b[^}]*\}\s+from\s+["']@tanstack\/react-query["']/.test(src)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("forbids fire-and-forget void wrappers on ConfirmDeleteDialog onConfirm props", () => {
    const pagesAndComponents = [
      ...walkTsFiles(path.join(FRONTEND_SRC, "pages")),
      ...walkTsFiles(path.join(FRONTEND_SRC, "components")),
    ];
    const offenders: string[] = [];

    for (const file of pagesAndComponents) {
      const rel = path.relative(FRONTEND_SRC, file).replace(/\\/g, "/");
      const src = fs.readFileSync(file, "utf8");
      const dialogs = src.match(/<ConfirmDeleteDialog\b[\s\S]*?\/>/g) ?? [];
      for (const block of dialogs) {
        if (/onConfirm\s*=\s*\{\s*\(\)\s*=>\s*void\b/.test(block)) {
          offenders.push(rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("useIdempotentAction & SubmitButton Behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks same-tick double clicks and repeated Enter submits while in-flight", async () => {
    let resolveReq!: () => void;
    const calls: string[] = [];

    function Harness() {
      const action = useIdempotentAction(async () => {
        const key = getActiveIdempotencyKey();
        calls.push(key ?? "missing");
        await new Promise<void>((r) => {
          resolveReq = r;
        });
      });

      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run();
          }}
        >
          <SubmitButton type="submit" pending={action.isPending}>
            Save Branch
          </SubmitButton>
        </form>
      );
    }

    render(<Harness />);
    const btn = screen.getByRole("button", { name: /Save Branch/i });

    // Rapid same-tick clicks + form submit
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.submit(btn.closest("form")!);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(btn).toBeDisabled();
    expect(screen.getByTestId("submit-spinner")).toBeInTheDocument();

    await act(async () => {
      resolveReq();
    });

    expect(btn).not.toBeDisabled();
  });

  it("reuses the exact same Idempotency-Key on retry after 5xx/network error and rotates after 2xx or 4xx", async () => {
    const keys: string[] = [];
    let mode: "500" | "200" | "409" = "500";

    function Harness() {
      const action = useIdempotentAction(async () => {
        keys.push(getActiveIdempotencyKey() ?? "");
        if (mode === "500") {
          throw new ApiError(503, { message: "Server timeout", code: "SERVICE_UNAVAILABLE" });
        }
        if (mode === "409") {
          throw new ApiError(409, { message: "Duplicate code", code: "DUPLICATE_BRANCH_CODE" });
        }
      });

      return (
        <button
          type="button"
          onClick={() => {
            void action.run().catch(() => {});
          }}
        >
          Trigger
        </button>
      );
    }

    render(<Harness />);
    const btn = screen.getByRole("button", { name: "Trigger" });

    // Attempt 1 -> 503 (transient error, keep key)
    await act(async () => {
      fireEvent.click(btn);
    });
    // Attempt 2 -> succeeds -> MUST reuse exact same key as Attempt 1, then rotate
    mode = "200";
    await act(async () => {
      fireEvent.click(btn);
    });
    // Attempt 3 -> 409 -> MUST have rotated to a fresh key after Attempt 2's success, and rotate again after 4xx
    mode = "409";
    await act(async () => {
      fireEvent.click(btn);
    });
    // Attempt 4 -> succeeds -> MUST have rotated to a new key after Attempt 3's 409
    mode = "200";
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(keys).toHaveLength(4);
    expect(keys[1]).toBe(keys[0]); // Retry after 503 reuses exact same Idempotency-Key
    expect(keys[2]).not.toBe(keys[1]); // Rotated after 2xx success
    expect(keys[3]).not.toBe(keys[2]); // Rotated after 409 client error
  });

  it("displays spinner immediately and shows 'Still working...' after 3 seconds", () => {
    vi.useFakeTimers();

    const { rerender } = render(<SubmitButton pending={false}>Create</SubmitButton>);
    expect(screen.queryByTestId("submit-spinner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit-still-working")).not.toBeInTheDocument();

    rerender(<SubmitButton pending={true}>Create</SubmitButton>);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByTestId("submit-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("submit-still-working")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId("submit-still-working")).toBeInTheDocument();
  });

  it("ConfirmDeleteDialog awaits async onConfirm, disables buttons while pending, and blocks double-clicks", async () => {
    let resolveDelete!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveDelete = r;
        })
    );
    const onOpenChange = vi.fn();

    render(
      <ConfirmDeleteDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        itemName="Test Item"
      />
    );

    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });

    fireEvent.click(deleteBtn);
    fireEvent.click(deleteBtn);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(deleteBtn).toBeDisabled();
    expect(cancelBtn).toBeDisabled();
    expect(screen.getByTestId("submit-spinner")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await act(async () => {
      resolveDelete();
    });

    expect(deleteBtn).not.toBeDisabled();
    expect(cancelBtn).not.toBeDisabled();
  });
});
