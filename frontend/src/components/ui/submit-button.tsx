import * as React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { DEFAULT_SLOW_THRESHOLD_MS } from "@/hooks/useIdempotentSubmit";
import { cn } from "@/lib/utils";

export interface SubmitButtonProps extends ButtonProps {
  /** Whether the form submit or action request is currently in flight. */
  pending?: boolean;
  /** Optional explicit slow flag (if omitted, automatically turns true after slowThresholdMs while pending). */
  isSlow?: boolean;
  /** Optional replacement text while pending (defaults to showing spinner beside children). */
  pendingText?: React.ReactNode;
  /** Optional custom "Still working..." text shown after 3s of pending. */
  slowText?: React.ReactNode;
  /** Threshold in ms before showing the "Still working..." indicator (default 3000ms). */
  slowThresholdMs?: number;
  /** Hide the inline "Still working..." status text (e.g. for compact icon-only table buttons). */
  hideSlowText?: boolean;
}

/**
 * Shared guarded submit / action button for every mutating form and action across the ERP.
 *
 * - Immediately disables while `pending` is true.
 * - Renders a spinning loader icon (`data-testid="submit-spinner"`).
 * - Displays a localized "Still working..." indicator (`data-testid="submit-still-working"`)
 *   whenever a request remains pending for more than 3 seconds.
 */
export const SubmitButton = React.forwardRef<HTMLButtonElement, SubmitButtonProps>(
  (
    {
      pending = false,
      isSlow: isSlowProp,
      pendingText,
      slowText,
      slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS,
      hideSlowText = false,
      disabled,
      children,
      className,
      size,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation();
    const [autoSlow, setAutoSlow] = useState(false);

    useEffect(() => {
      if (!pending) {
        setAutoSlow(false);
        return;
      }
      if (isSlowProp !== undefined) return;
      const timer = setTimeout(() => setAutoSlow(true), slowThresholdMs);
      return () => clearTimeout(timer);
    }, [pending, isSlowProp, slowThresholdMs]);

    const effectiveSlow = Boolean(pending && (isSlowProp ?? autoSlow));
    const isIconOnly = size === "icon";
    const resolvedSlowText = slowText ?? t("common.stillWorking", "Still working...");

    return (
      <span className={cn("inline-flex items-center gap-2", className?.includes("w-full") ? "w-full flex-col items-stretch" : "")}>
        <Button
          ref={ref}
          size={size}
          disabled={Boolean(disabled || pending)}
          aria-busy={pending || undefined}
          data-submit-pending={pending ? "true" : undefined}
          className={className}
          {...props}
        >
          {pending && (
            <Loader2
              className="h-4 w-4 animate-spin shrink-0"
              aria-hidden="true"
              data-testid="submit-spinner"
            />
          )}
          {pending && pendingText ? pendingText : children}
        </Button>
        {effectiveSlow && !hideSlowText && !isIconOnly && (
          <span
            role="status"
            aria-live="polite"
            data-testid="submit-still-working"
            className="text-xs text-muted-foreground whitespace-nowrap animate-pulse"
          >
            {resolvedSlowText}
          </span>
        )}
      </span>
    );
  }
);
SubmitButton.displayName = "SubmitButton";
