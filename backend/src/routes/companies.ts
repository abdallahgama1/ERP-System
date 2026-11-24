import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.ts";
import { eventBroadcaster } from "../events/broadcaster.ts";
import { requirePermission } from "../middleware/auth.ts";
import {
  assignCompanyMember,
  createCompany,
  deleteCompany,
  getCompanyById,
  listCompanies,
  listCompanyMembers,
  removeCompanyMember,
  updateCompany,
  updateCompanyMember,
} from "../services/companies.service.ts";

export async function companiesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/companies", { preHandler: requirePermission("companies", "view") }, async (req) => {
    const companies = await listCompanies(getDb(), req.authUser!);
    return { companies };
  });

  app.get("/api/companies/:id", { preHandler: requirePermission("companies", "view") }, async (req) => {
    const { id } = req.params as { id: string };
    return getCompanyById(getDb(), req.authUser!, id);
  });

  app.post("/api/companies", { preHandler: requirePermission("companies", "create") }, async (req, reply) => {
    const company = await createCompany(getDb(), req.authUser!, req.body, req.ip);
    eventBroadcaster.broadcast("companies_updated", {}, null);
    return reply.status(201).send({ company });
  });

  app.put("/api/companies/:id", { preHandler: requirePermission("companies", "edit") }, async (req) => {
    const { id } = req.params as { id: string };
    const company = await updateCompany(getDb(), req.authUser!, id, req.body, req.ip);
    eventBroadcaster.broadcast("companies_updated", {}, null);
    return { company };
  });

  app.delete("/api/companies/:id", { preHandler: requirePermission("companies", "delete") }, async (req) => {
    const { id } = req.params as { id: string };
    const result = await deleteCompany(getDb(), req.authUser!, id, req.ip);
    eventBroadcaster.broadcast("companies_updated", {}, null);
    return result;
  });

  app.get(
    "/api/companies/:id/members",
    { preHandler: requirePermission("companies", "view") },
    async (req) => {
      const { id } = req.params as { id: string };
      const members = await listCompanyMembers(getDb(), req.authUser!, id);
      return { members };
    }
  );

  app.post(
    "/api/companies/:id/members",
    { preHandler: requirePermission("companies", "edit") },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const member = await assignCompanyMember(getDb(), req.authUser!, id, req.body, req.ip);
      eventBroadcaster.broadcast("users_updated", {}, null);
      return reply.status(201).send({ member });
    }
  );

  app.put(
    "/api/companies/:id/members/:userId",
    { preHandler: requirePermission("companies", "edit") },
    async (req) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const member = await updateCompanyMember(getDb(), req.authUser!, id, userId, req.body, req.ip);
      eventBroadcaster.broadcast("users_updated", {}, null);
      return { member };
    }
  );

  app.delete(
    "/api/companies/:id/members/:userId",
    { preHandler: requirePermission("companies", "edit") },
    async (req) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const res = await removeCompanyMember(getDb(), req.authUser!, id, userId, req.ip);
      eventBroadcaster.broadcast("users_updated", {}, null);
      return res;
    }
  );
}
