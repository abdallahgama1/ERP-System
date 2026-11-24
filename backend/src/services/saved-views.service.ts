import {
  createSavedViewSchema,
  savedViewsQuerySchema,
  updateSavedViewSchema,
  type SavedViewConfig,
  type SavedViewDto,
} from "@erp/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import { userSavedViews } from "../../drizzle/schema.ts";
import type { AuthUser } from "../auth/sessions.ts";
import { AppError } from "../db/helpers.ts";
import type { AppDatabase } from "../db/index.ts";
import { actorCompanyId, parseOrThrow } from "./stock-locks.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSavedViewDto(row: typeof userSavedViews.$inferSelect): SavedViewDto {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    resource: row.resource,
    name: row.name,
    configJson: (row.configJson ?? {}) as SavedViewConfig,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSavedViews(
  db: AppDatabase,
  actor: AuthUser,
  rawQuery: unknown
): Promise<SavedViewDto[]> {
  const query = parseOrThrow(savedViewsQuerySchema, rawQuery, "Invalid saved views query");
  const companyId = actorCompanyId(actor);

  const conds = [eq(userSavedViews.companyId, companyId), eq(userSavedViews.userId, actor.id)];
  if (query.resource) {
    conds.push(eq(userSavedViews.resource, query.resource));
  }

  const rows = await db
    .select()
    .from(userSavedViews)
    .where(and(...conds))
    .orderBy(asc(userSavedViews.resource), asc(userSavedViews.name));

  return rows.map(toSavedViewDto);
}

export async function createSavedView(
  db: AppDatabase,
  actor: AuthUser,
  rawBody: unknown
): Promise<SavedViewDto> {
  const data = parseOrThrow(createSavedViewSchema, rawBody, "Invalid saved view payload");
  const companyId = actorCompanyId(actor);

  const created = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: userSavedViews.id })
      .from(userSavedViews)
      .where(
        and(
          eq(userSavedViews.companyId, companyId),
          eq(userSavedViews.userId, actor.id),
          eq(userSavedViews.resource, data.resource),
          eq(userSavedViews.name, data.name)
        )
      )
      .limit(1);
    if (dup) {
      throw new AppError(409, `Saved view '${data.name}' already exists for ${data.resource}`, "DUPLICATE_SAVED_VIEW");
    }

    if (data.isDefault) {
      await tx
        .update(userSavedViews)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(userSavedViews.companyId, companyId),
            eq(userSavedViews.userId, actor.id),
            eq(userSavedViews.resource, data.resource),
            eq(userSavedViews.isDefault, true)
          )
        );
    }

    const [row] = await tx
      .insert(userSavedViews)
      .values({
        companyId,
        userId: actor.id,
        resource: data.resource,
        name: data.name,
        configJson: data.configJson as Record<string, unknown>,
        isDefault: data.isDefault,
      })
      .returning();

    return row;
  });

  return toSavedViewDto(created);
}

export async function updateSavedView(
  db: AppDatabase,
  actor: AuthUser,
  viewId: string,
  rawBody: unknown
): Promise<SavedViewDto> {
  if (!UUID_RE.test(viewId)) {
    throw new AppError(400, "Invalid saved view ID", "VALIDATION_ERROR");
  }
  const data = parseOrThrow(updateSavedViewSchema, rawBody, "Invalid saved view update");
  const companyId = actorCompanyId(actor);

  const updated = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(userSavedViews)
      .where(
        and(
          eq(userSavedViews.id, viewId),
          eq(userSavedViews.companyId, companyId),
          eq(userSavedViews.userId, actor.id)
        )
      )
      .limit(1);

    if (!existing) {
      throw new AppError(404, "Saved view not found", "NOT_FOUND");
    }

    if (data.name && data.name !== existing.name) {
      const [dup] = await tx
        .select({ id: userSavedViews.id })
        .from(userSavedViews)
        .where(
          and(
            eq(userSavedViews.companyId, companyId),
            eq(userSavedViews.userId, actor.id),
            eq(userSavedViews.resource, existing.resource),
            eq(userSavedViews.name, data.name),
            ne(userSavedViews.id, viewId)
          )
        )
        .limit(1);
      if (dup) {
        throw new AppError(409, `Saved view '${data.name}' already exists`, "DUPLICATE_SAVED_VIEW");
      }
    }

    if (data.isDefault === true) {
      await tx
        .update(userSavedViews)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(userSavedViews.companyId, companyId),
            eq(userSavedViews.userId, actor.id),
            eq(userSavedViews.resource, existing.resource),
            eq(userSavedViews.isDefault, true),
            ne(userSavedViews.id, viewId)
          )
        );
    }

    const [row] = await tx
      .update(userSavedViews)
      .set({
        name: data.name ?? existing.name,
        configJson: (data.configJson ?? existing.configJson) as Record<string, unknown>,
        isDefault: data.isDefault ?? existing.isDefault,
        updatedAt: new Date(),
      })
      .where(eq(userSavedViews.id, viewId))
      .returning();

    return row;
  });

  return toSavedViewDto(updated);
}

export async function deleteSavedView(db: AppDatabase, actor: AuthUser, viewId: string): Promise<void> {
  if (!UUID_RE.test(viewId)) {
    throw new AppError(400, "Invalid saved view ID", "VALIDATION_ERROR");
  }
  const companyId = actorCompanyId(actor);

  const deleted = await db
    .delete(userSavedViews)
    .where(
      and(
        eq(userSavedViews.id, viewId),
        eq(userSavedViews.companyId, companyId),
        eq(userSavedViews.userId, actor.id)
      )
    )
    .returning({ id: userSavedViews.id });

  if (deleted.length === 0) {
    throw new AppError(404, "Saved view not found", "NOT_FOUND");
  }
}
