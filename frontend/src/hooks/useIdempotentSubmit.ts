import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import {
  ApiError,
  generateIdempotencyKey,
  runWithIdempotencyKey,
} from "@/lib/api-client";

export const DEFAULT_SLOW_THRESHOLD_MS = 3000;

export interface IdempotentActionOptions {
  /** Milliseconds before `isSlow` turns true to show a "Still working..." hint. Default 3000ms. */
  slowThresholdMs?: number;
}

export interface IdempotentActionResult<TArgs extends unknown[], TResult> {
  /** Execute the guarded async action. Synchronously ignores re-entrant calls while in flight. */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  /** Convenience form submit handler (`onSubmit={action.handleSubmit}`). Prevents default and ignores repeated Enter/click. */
  handleSubmit: (e?: React.FormEvent) => Promise<TResult | undefined>;
  /** True while the action is executing. */
  isPending: boolean;
  /** True once the action has been pending for >= slowThresholdMs (default 3s). */
  isSlow: boolean;
  /** Current idempotency key for the active user intent (reused on retry, rotated after success or reset). */
  getIdempotencyKey: () => string;
  /** Rotate/clear the idempotency key (call when closing/resetting a form dialog). */
  resetKey: () => void;
  /** Wraps a dialog `setOpen` callback so closing is ignored while pending. */
  guardOpenChange: (onOpenChange: (open: boolean) => void) => (open: boolean) => void;
}

function shouldRotateKeyOnError(err: unknown): boolean {
  if (err instanceof ApiError) {
    // Keep the SAME key on 5xx, 408 Request Timeout, 429 Too Many Requests, or 409 IDEMPOTENCY_IN_PROGRESS
    // so retrying the exact same action safely deduplicates.
    if (err.status >= 500 || err.status === 408 || err.status === 429) return false;
    if (err.code === "IDEMPOTENCY_IN_PROGRESS") return false;
    // On 4xx validation / domain conflict (e.g. 400, 409 duplicate, 422), the user may edit fields
    // and resubmit a modified payload, so rotate to avoid 422 IDEMPOTENCY_KEY_REUSE_MISMATCH.
    return true;
  }
  // Network/abort/fetch error: KEEP the same key so retrying sends the identical Idempotency-Key!
  return false;
}

/**
 * Shared frontend duplicate-submission guard for any async form submit or action button.
 *
 * Guarantees:
 * 1. Synchronous `useRef` lock blocks same-tick double-clicks and repeated Enter/F9 presses.
 * 2. Generates ONE UUID `Idempotency-Key` per user action intent, propagates it automatically to
 *    `apiRequest` via `runWithIdempotencyKey`, reuses it on retry after transient/5xx failures,
 *    and rotates it after success or reset.
 * 3. Exposes `isPending` immediately and `isSlow` after 3 seconds for "Still working..." UX.
 */
export function useIdempotentAction<TArgs extends unknown[], TResult = unknown>(
  actionFn: (...args: TArgs) => Promise<TResult>,
  options: IdempotentActionOptions = {}
): IdempotentActionResult<TArgs, TResult> {
  const slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const inFlightRef = useRef(false);
  const keyRef = useRef<string | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const actionRef = useRef(actionFn);
  actionRef.current = actionFn;

  const [isPending, setIsPending] = useState(false);
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
    };
  }, []);

  const getIdempotencyKey = useCallback(() => {
    if (!keyRef.current) {
      keyRef.current = generateIdempotencyKey();
    }
    return keyRef.current;
  }, []);

  const resetKey = useCallback(() => {
    keyRef.current = null;
  }, []);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      if (inFlightRef.current) {
        return undefined;
      }
      inFlightRef.current = true;
      setIsPending(true);
      setIsSlow(false);

      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      slowTimerRef.current = setTimeout(() => {
        if (mountedRef.current && inFlightRef.current) {
          setIsSlow(true);
        }
      }, slowThresholdMs);

      const key = getIdempotencyKey();
      try {
        const result = await runWithIdempotencyKey(key, () => actionRef.current(...args));
        // Support scope helpers that return `{ ok: false, error }` without throwing:
        const maybeResult = result as { ok?: boolean; status?: number; code?: string } | null | undefined;
        if (maybeResult && typeof maybeResult === "object" && maybeResult.ok === false) {
          // If it failed with a 4xx domain/validation error, rotate key so modified retries succeed.
          // If it was a 5xx/network failure, keep the key so exact retries deduplicate.
          if (typeof maybeResult.status === "number" && maybeResult.status >= 400 && maybeResult.status < 500 && maybeResult.status !== 408 && maybeResult.status !== 429) {
            keyRef.current = null;
          }
        } else {
          // Succeeded -> rotate key for the next distinct user action
          keyRef.current = null;
        }
        return result;
      } catch (err) {
        if (shouldRotateKeyOnError(err)) {
          keyRef.current = null;
        }
        throw err;
      } finally {
        if (slowTimerRef.current) {
          clearTimeout(slowTimerRef.current);
          slowTimerRef.current = null;
        }
        inFlightRef.current = false;
        if (mountedRef.current) {
          setIsPending(false);
          setIsSlow(false);
        }
      }
    },
    [getIdempotencyKey, slowThresholdMs]
  );

  const handleSubmit = useCallback(
    async (e?: React.FormEvent): Promise<TResult | undefined> => {
      if (e) {
        e.preventDefault();
      }
      if (inFlightRef.current) {
        return undefined;
      }
      return run(...([] as unknown as TArgs));
    },
    [run]
  );

  const guardOpenChange = useCallback(
    (onOpenChange: (open: boolean) => void) =>
      (open: boolean) => {
        if (!open && inFlightRef.current) {
          return;
        }
        if (!open) {
          keyRef.current = null;
        }
        onOpenChange(open);
      },
    []
  );

  return {
    run,
    handleSubmit,
    isPending,
    isSlow,
    getIdempotencyKey,
    resetKey,
    guardOpenChange,
  };
}

/**
 * Guarded per-item / per-action lock map for inline table action buttons
 * (e.g. Send, Void, Approve, Reject, Dispatch, Receive, Cancel).
 */
export function useActionLocks(slowThresholdMs = DEFAULT_SLOW_THRESHOLD_MS) {
  const activeSetRef = useRef<Set<string>>(new Set());
  const keysMapRef = useRef<Map<string, string>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef = useRef(true);

  const [pendingKeys, setPendingKeys] = useState<Record<string, boolean>>({});
  const [slowKeys, setSlowKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const runLocked = useCallback(
    async <TResult,>(lockId: string, fn: (idempotencyKey: string) => Promise<TResult>): Promise<TResult | undefined> => {
      if (activeSetRef.current.has(lockId)) {
        return undefined;
      }
      activeSetRef.current.add(lockId);
      setPendingKeys((prev) => ({ ...prev, [lockId]: true }));

      let key = keysMapRef.current.get(lockId);
      if (!key) {
        key = generateIdempotencyKey();
        keysMapRef.current.set(lockId, key);
      }

      const timer = setTimeout(() => {
        if (mountedRef.current && activeSetRef.current.has(lockId)) {
          setSlowKeys((prev) => ({ ...prev, [lockId]: true }));
        }
      }, slowThresholdMs);
      timersRef.current.set(lockId, timer);

      try {
        const result = await runWithIdempotencyKey(key, () => fn(key));
        const maybeResult = result as { ok?: boolean; status?: number } | null | undefined;
        if (maybeResult && typeof maybeResult === "object" && maybeResult.ok === false) {
          if (typeof maybeResult.status === "number" && maybeResult.status >= 400 && maybeResult.status < 500) {
            keysMapRef.current.delete(lockId);
          }
        } else {
          keysMapRef.current.delete(lockId);
        }
        return result;
      } catch (err) {
        if (shouldRotateKeyOnError(err)) {
          keysMapRef.current.delete(lockId);
        }
        throw err;
      } finally {
        const activeTimer = timersRef.current.get(lockId);
        if (activeTimer) {
          clearTimeout(activeTimer);
          timersRef.current.delete(lockId);
        }
        activeSetRef.current.delete(lockId);
        if (mountedRef.current) {
          setPendingKeys((prev) => {
            if (!prev[lockId]) return prev;
            const next = { ...prev };
            delete next[lockId];
            return next;
          });
          setSlowKeys((prev) => {
            if (!prev[lockId]) return prev;
            const next = { ...prev };
            delete next[lockId];
            return next;
          });
        }
      }
    },
    [slowThresholdMs]
  );

  const isPending = useCallback((lockId?: string) => {
    if (!lockId) return Object.keys(pendingKeys).length > 0;
    return Boolean(pendingKeys[lockId]);
  }, [pendingKeys]);

  const isSlow = useCallback((lockId?: string) => {
    if (!lockId) return Object.keys(slowKeys).length > 0;
    return Boolean(slowKeys[lockId]);
  }, [slowKeys]);

  return {
    runLocked,
    isPending,
    isSlow,
    hasAnyPending: Object.keys(pendingKeys).length > 0,
  };
}

/**
 * TanStack Query `useMutation` wrapper adding synchronous double-submit protection,
 * intent-scoped `Idempotency-Key` propagation, and 3-second slow-network feedback.
 */
export function useIdempotentMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext> & IdempotentActionOptions
): Omit<UseMutationResult<TData, TError, TVariables, TContext>, "isPending"> & {
  isPending: boolean;
  run: (variables: TVariables) => Promise<TData | undefined>;
  isSlow: boolean;
  resetKey: () => void;
  guardOpenChange: (onOpenChange: (open: boolean) => void) => (open: boolean) => void;
} {
  const { slowThresholdMs, ...mutationOptions } = options;
  const mutation = useMutation(mutationOptions);
  const action = useIdempotentAction<[TVariables], TData>(
    (variables) => mutation.mutateAsync(variables),
    { slowThresholdMs }
  );

  return {
    ...mutation,
    isPending: mutation.isPending || action.isPending,
    isSlow: action.isSlow,
    run: action.run,
    resetKey: action.resetKey,
    guardOpenChange: action.guardOpenChange,
  };
}
