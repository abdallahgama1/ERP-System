import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SplitTenderDialog } from "@/components/pos/SplitTenderDialog";

describe("SplitTenderDialog", () => {
  it("calculates cash change due and allows split cash + card tenders", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <SplitTenderDialog
        open
        onOpenChange={vi.fn()}
        grandTotal={150}
        currency="USD"
        onConfirm={onConfirm}
      />
    );

    // Default cash tender covers 150; click 200 quick denomination -> change due = $50.00
    fireEvent.click(screen.getByRole("button", { name: "200" }));
    expect(screen.getByText("$50.00")).toBeInTheDocument();

    // Reduce cash applied amount to 100 and add Card split for remaining 50
    const appliedInput = screen.getByLabelText("Applied Amount");
    fireEvent.change(appliedInput, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /Card/i }));

    const completeBtn = screen.getByRole("button", { name: "Complete Sale" });
    expect(completeBtn).not.toBeDisabled();
    fireEvent.click(completeBtn);

    expect(onConfirm).toHaveBeenCalledWith([
      { method: "cash", amount: 100, tenderedAmount: 200, reference: "" },
      { method: "card", amount: 50, tenderedAmount: 50, reference: "" },
    ]);
  });
});
