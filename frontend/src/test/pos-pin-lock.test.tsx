import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PinLockOverlay } from "@/components/pos/PinLockOverlay";

describe("PinLockOverlay", () => {
  it("enters a 4-digit PIN via touch keypad and invokes onUnlock", async () => {
    const onUnlock = vi.fn().mockResolvedValue(undefined);
    render(
      <PinLockOverlay
        open
        isHardLocked
        cashiers={[]}
        activeCashierName="Sara"
        onUnlock={onUnlock}
      />
    );

    const unlockBtn = screen.getByRole("button", { name: /Unlock/i });
    expect(unlockBtn).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    expect(unlockBtn).not.toBeDisabled();
    fireEvent.click(unlockBtn);

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith("1234", undefined);
    });
  });
});
