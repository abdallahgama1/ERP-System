import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { createTaxonomySchema, updateTaxonomySchema } from "@erp/shared";
import { products, taxonomyItems } from "../../drizzle/schema.ts";
import { AppError, writeAuditLog } from "../db/helpers.ts";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";

export async function taxonomyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/taxonomy", { preHandler: requireAuth }, async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(taxonomyItems)
      .where(eq(taxonomyItems.isActive, true))
      .orderBy(asc(taxonomyItems.name));

    return { items: rows };
  });

  app.post("/api/taxonomy", { preHandler: requirePermission("taxonomy", "create") }, async (req, reply) => {
    const parsed = createTaxonomySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid taxonomy item", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const db = getDb();

    const created = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: taxonomyItems.id })
        .from(taxonomyItems)
        .where(
          and(
            eq(taxonomyItems.kind, parsed.data.kind),
            sql`lower(${taxonomyItems.name}) = lower(${parsed.data.name})`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        throw new AppError(409, `${parsed.data.kind} '${parsed.data.name}' already exists`, "DUPLICATE_TAXONOMY");
      }

      const [row] = await tx
        .insert(taxonomyItems)
        .values({
          kind: parsed.data.kind,
          name: parsed.data.name,
          description: parsed.data.description,
          symbol: parsed.data.symbol,
          color: parsed.data.color,
          isActive: true,
        })
        .returning();

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: `taxonomy.${parsed.data.kind}_created`,
        entityType: "taxonomy",
        entityId: row.id,
        entityLabel: row.name,
        ipAddress: req.ip,
      });

      return row;
    });

    eventBroadcaster.broadcast("taxonomy_updated", { id: created.id });
    return reply.status(201).send({ item: created });
  });

  app.put("/api/taxonomy/:id", { preHandler: requirePermission("taxonomy", "edit") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const parsed = updateTaxonomySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid taxonomy update", "VALIDATION_ERROR");
    }

    const actor = req.authUser!;
    const db = getDb();

    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(taxonomyItems).where(eq(taxonomyItems.id, id)).limit(1);
      if (!current) {
        throw new AppError(404, "Taxonomy item not found", "NOT_FOUND");
      }

      const nextName = parsed.data.name ?? current.name;
      if (nextName.toLowerCase() !== current.name.toLowerCase()) {
        const dup = await tx
          .select({ id: taxonomyItems.id })
          .from(taxonomyItems)
          .where(
            and(
              eq(taxonomyItems.kind, current.kind),
              sql`lower(${taxonomyItems.name}) = lower(${nextName})`
            )
          )
          .limit(1);
        if (dup.length > 0) {
          throw new AppError(409, `${current.kind} '${nextName}' already exists`, "DUPLICATE_TAXONOMY");
        }
      }

      const [row] = await tx
        .update(taxonomyItems)
        .set({
          name: nextName,
          description: parsed.data.description ?? current.description,
          symbol: parsed.data.symbol ?? current.symbol,
          color: parsed.data.color ?? current.color,
          updatedAt: new Date(),
        })
        .where(eq(taxonomyItems.id, id))
        .returning();

      // Propagate rename cleanly onto referenced catalog products
      if (nextName !== current.name) {
        if (current.kind === "brand") {
          await tx
            .update(products)
            .set({ brand: nextName, updatedAt: new Date() })
            .where(sql`lower(${products.brand}) = lower(${current.name})`);
        } else if (current.kind === "category") {
          await tx
            .update(products)
            .set({ category: nextName, updatedAt: new Date() })
            .where(sql`lower(${products.category}) = lower(${current.name})`);
        } else if (current.kind === "unit") {
          const oldKey = current.symbol || current.name;
          const newKey = row.symbol || row.name;
          await tx
            .update(products)
            .set({ unit: newKey, updatedAt: new Date() })
            .where(sql`lower(${products.unit}) = lower(${oldKey})`);
        }
      }

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: `taxonomy.${current.kind}_updated`,
        entityType: "taxonomy",
        entityId: row.id,
        entityLabel: row.name,
        details: { fromName: current.name, toName: nextName },
        ipAddress: req.ip,
      });

      return row;
    });

    eventBroadcaster.broadcast("taxonomy_updated", { id: updated.id });
    return { item: updated };
  });

  app.delete("/api/taxonomy/:id", { preHandler: requirePermission("taxonomy", "delete") }, async (req) => {
    const id = (req.params as { id: string }).id;
    const actor = req.authUser!;
    const db = getDb();

    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(taxonomyItems).where(eq(taxonomyItems.id, id)).limit(1);
      if (!current) {
        throw new AppError(404, "Taxonomy item not found", "NOT_FOUND");
      }

      let refCount = 0;
      if (current.kind === "brand") {
        const [{ c }] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(products)
          .where(sql`lower(${products.brand}) = lower(${current.name})`);
        refCount = c;
      } else if (current.kind === "category") {
        const [{ c }] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(products)
          .where(sql`lower(${products.category}) = lower(${current.name})`);
        refCount = c;
      } else if (current.kind === "unit") {
        const unitKey = current.symbol || current.name;
        const [{ c }] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(products)
          .where(sql`lower(${products.unit}) = lower(${unitKey})`);
        refCount = c;
      }

      if (refCount > 0) {
        throw new AppError(
          409,
          `Cannot delete '${current.name}' while ${refCount} product(s) reference it.`,
          "TAXONOMY_IN_USE"
        );
      }

      await tx.delete(taxonomyItems).where(eq(taxonomyItems.id, id));

      await writeAuditLog(tx, {
        userId: actor.id,
        userName: actor.name,
        userRole: actor.role,
        action: `taxonomy.${current.kind}_deleted`,
        entityType: "taxonomy",
        entityId: id,
        entityLabel: current.name,
        ipAddress: req.ip,
      });
    });

    eventBroadcaster.broadcast("taxonomy_updated", { id });
    return { ok: true };
  });
}
