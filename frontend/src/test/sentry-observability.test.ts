import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  captureFrontendException,
  initFrontendSentry,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubUrl,
} from "@/lib/observability/sentry";

describe("Frontend Sentry lazy observability & ErrorBoundary integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("no-ops without initializing @sentry/react when VITE_SENTRY_DSN is unset", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    expect(await initFrontendSentry()).toBe(false);
    expect(await captureFrontendException(new Error("boom"))).toBeUndefined();
  });

  it("scrubs URLs, PII, tokens, PINs, and JSON bodies from Sentry breadcrumbs and events", () => {
    expect(scrubUrl("https://u:p@erp.example.com/reset?token=secret123#frag")).toBe(
      "https://erp.example.com/reset"
    );
    expect(scrubUrl("/pos?posPin=1234#top")).toBe("/pos");

    const crumb = scrubSentryBreadcrumb({
      category: "xhr",
      message: "Authorization Bearer secret-jwt-value",
      data: {
        url: "https://erp.example.com/api/auth/login?token=abc",
        authorization: "Bearer secret-jwt-value",
        shippingAddress: "Alexandria Port",
      },
    });
    expect(crumb.message).not.toContain("secret-jwt-value");
    expect(crumb.data?.url).toBe("https://erp.example.com/api/auth/login");
    expect(crumb.data?.authorization).toBe("[REDACTED]");
    expect(crumb.data?.shippingAddress).toBe("Alexandria Port");

    const event = scrubSentryEvent({
      type: undefined,
      user: {
        id: "u-1",
        email: "user@example.com",
        ip_address: "192.168.1.2",
        username: "user1",
      },
      request: {
        url: "https://erp.example.com/api/pos/override?pin=4321",
        cookies: { erp_session: "sess-xyz" },
        query_string: "pin=4321",
        headers: {
          cookie: "erp_session=sess-xyz",
          "x-api-key": "key-123",
        },
        data: JSON.stringify({
          password: "SecretPassword",
          posPin: "1122",
          mapping: { ok: true },
        }),
      },
    });
    expect(event.user).toEqual({ id: "u-1" });
    expect(event.request?.url).toBe("https://erp.example.com/api/pos/override");
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.headers?.cookie).toBe("[REDACTED]");
    expect(event.request?.headers?.["x-api-key"]).toBe("[REDACTED]");
    const parsedData = JSON.parse(String(event.request?.data)) as Record<string, unknown>;
    expect(parsedData.password).toBe("[REDACTED]");
    expect(parsedData.posPin).toBe("[REDACTED]");
    expect(parsedData.mapping).toEqual({ ok: true });
  });

  it("renders fallback UI and invokes captureFrontendException from ErrorBoundary.componentDidCatch", async () => {
    vi.resetModules();
    const captureReactExceptionMock = vi.fn(() => "evt-123");
    const initMock = vi.fn();
    vi.doMock("@sentry/react", () => ({
      init: initMock,
      captureReactException: captureReactExceptionMock,
      captureException: vi.fn(),
    }));
    vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.ingest.sentry.io/1");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ErrorBoundary: FreshErrorBoundary } = await import("@/components/ErrorBoundary");

    function ThrowingChild(): React.ReactElement {
      throw new Error("Simulated UI crash");
    }

    render(
      React.createElement(
        FreshErrorBoundary,
        null,
        React.createElement(ThrowingChild)
      )
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Simulated UI crash")).toBeInTheDocument();

    await waitFor(() => {
      expect(initMock).toHaveBeenCalledTimes(1);
      expect(captureReactExceptionMock).toHaveBeenCalledTimes(1);
    });

    consoleErrorSpy.mockRestore();
  });
});
