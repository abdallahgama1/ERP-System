import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

describe("Frontend Vitest + RTL environment smoke", () => {
  it("renders UI components cleanly in jsdom with jest-dom matchers", () => {
    render(<Badge>POS Ready</Badge>);
    expect(screen.getByText("POS Ready")).toBeInTheDocument();
  });
});
