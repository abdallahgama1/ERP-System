import { z } from "zod";

export const SORT_DIRECTIONS = ["desc", "asc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const cursorPayloadSchema = z.object({
  v: z.literal(1),
  ts: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortDir: z.enum(SORT_DIRECTIONS).optional().default("desc"),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export const optionalSearchQuery = z
  .string()
  .trim()
  .max(120)
  .transform((v) => (v === "" ? undefined : v))
  .optional();

export const optionalFilterQuery = z
  .string()
  .trim()
  .max(120)
  .transform((v) => (v === "" || v.toLowerCase() === "all" ? undefined : v))
  .optional();

export const optionalUuidQuery = z
  .union([z.string().uuid(), z.literal(""), z.literal("all")])
  .transform((v) => (v === "" || v === "all" ? undefined : v))
  .optional();

export const offsetPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z.string().trim().max(40).optional(),
  sortDir: z.enum(SORT_DIRECTIONS).optional().default("desc"),
  q: optionalSearchQuery,
  search: optionalSearchQuery,
  status: optionalFilterQuery,
  branchId: optionalUuidQuery,
  category: optionalFilterQuery,
});
export type OffsetPageQuery = z.infer<typeof offsetPageQuerySchema>;

export function resolveSearchTerm(query: { q?: string; search?: string }): string | undefined {
  const term = (query.q ?? query.search)?.trim();
  return term ? term : undefined;
}

export function parseBackwardCompatibleOffsetQuery<
  TSchema extends z.ZodType<OffsetPageQuery, z.ZodTypeDef, unknown>,
>(
  schema: TSchema,
  rawQuery: Record<string, unknown> | undefined,
  legacyDefaultPageSize = 200
): z.infer<TSchema> {
  const raw = rawQuery ?? {};
  const hasExplicitPaging = raw.page !== undefined || raw.pageSize !== undefined;
  return schema.parse({
    ...raw,
    page: raw.page ?? 1,
    pageSize: raw.pageSize ?? (hasExplicitPaging ? 50 : legacyDefaultPageSize),
  });
}

export interface CursorPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface OffsetPageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface CursorPaginatedResponse<T> {
  items: T[];
  pageInfo: CursorPageInfo;
}

export interface OffsetPaginatedResponse<T> {
  items: T[];
  pageInfo: OffsetPageInfo;
}

function toBase64Url(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "base64url").toString("utf8");
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encodes a versioned keyset cursor `(created_at, id)` as Base64URL JSON.
 */
export function encodeCursor(ts: Date | string, id: string): string {
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  const payload: CursorPayload = { v: 1, ts: iso, id };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decodes and strictly validates a keyset cursor. Returns null if malformed.
 */
export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = fromBase64Url(raw.trim());
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildOffsetPageInfo(page: number, pageSize: number, total: number): OffsetPageInfo {
  const safeTotal = Math.max(0, total);
  const totalPages = safeTotal === 0 ? 1 : Math.ceil(safeTotal / pageSize);
  return {
    page,
    pageSize,
    total: safeTotal,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}
