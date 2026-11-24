import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  DEFAULT_COMPANY_ID,
  PERMISSION_MODULES,
  SYSTEM_ROLE_PRESETS,
  buildEmptyPermissionRecord,
  type PermissionMap,
} from "@erp/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalRules,
  auditLogs,
  branches,
  chartOfAccounts,
  companySettings,
  currencies,
  customRoles,
  documentSequences,
  fiscalYears,
  glAccountMappings,
  taxCodes,
  taxonomyItems,
  userCompanies,
  userMfa,
  userRoles,
} from "../../drizzle/schema.ts";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

const testDbUrl = process.env.TEST_DATABASE_URL?.trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

function extractSessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((c) => c.name === "erp_session")?.value;
}

function buildCustomPermissions(
  overrides: Partial<PermissionMap>
): PermissionMap {
  const base = buildEmptyPermissionRecord();
  return { ...base, ...overrides };
}

describe.skipIf(!testDbUrl)(
  "Wave 1 M2 — Multi-Company Tenancy, Dynamic Custom Roles, TOTP 2FA, Active Sessions & Audit Diffs",
  () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { buildApp } = await import("../../src/app.ts");
      app = await buildApp({ logger: false });
      await app.ready();

      const { getDb } = await import("../../src/db/index.ts");
      const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
      await assertTestDatabaseName(getDb(), testDbUrl!);
    });

    afterAll(async () => {
      if (app) await app.close();
      const { closeDatabase } = await import("../../src/db/index.ts");
      await closeDatabase();
    });

    it("enforces full M2 lifecycle: bootstrap, company CRUD & seeding, company switching, custom roles RBAC, TOTP 2FA, sessions & scrubbed audit diffs", async () => {
      const { generateTotp } = await import("../../src/services/mfa.service.ts");
      const { getDb } = await import("../../src/db/index.ts");
      const { resetTestDatabase } = await import("../helpers/db-reset.ts");
      const db = getDb();
      await resetTestDatabase(db);

      // =========================================================================
      // 1. Bootstrap & Backward Compatibility
      // =========================================================================
      const adminSignup = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        headers: { "user-agent": "TestBrowser/1.0" },
        payload: {
          name: "Root Admin",
          email: "root-admin@m2.test",
          password: "AdminPassword123!",
        },
      });
      expect(adminSignup.statusCode).toBe(201);
      const adminCookie = extractSessionCookie(adminSignup)!;
      expect(adminCookie).toBeTruthy();

      const adminUser = adminSignup.json().user;
      expect(adminUser.role).toBe("admin");
      expect(adminUser.activeCompanyId).toBe(DEFAULT_COMPANY_ID);
      expect(adminUser.customRoleName).toBe("Admin");
      expect(adminUser.customRoleId).toBeTruthy();
      expect(adminUser.mfaEnabled).toBe(false);
      expect(adminUser.companies).toHaveLength(1);
      expect(adminUser.companies[0].code).toBe("COMP-01");
      expect(Object.keys(adminUser.permissions)).toEqual([...PERMISSION_MODULES]);

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { erp_session: adminCookie },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().user.activeCompanyId).toBe(DEFAULT_COMPANY_ID);

      // Verify DB sync on user_roles & user_companies
      const [rootUserRole] = await db
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, adminUser.id));
      expect(rootUserRole?.role).toBe("admin");
      expect(rootUserRole?.customRoleId).toBe(adminUser.customRoleId);

      const [rootUserCompany] = await db
        .select()
        .from(userCompanies)
        .where(and(eq(userCompanies.userId, adminUser.id), eq(userCompanies.companyId, DEFAULT_COMPANY_ID)));
      expect(rootUserCompany?.isDefault).toBe(true);
      expect(rootUserCompany?.role).toBe("admin");

      // Second signup becomes regular user in COMP-01
      const secondSignup = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        headers: { "user-agent": "UserAgent/1.0" },
        payload: {
          name: "Staff User",
          email: "staff@m2.test",
          password: "StaffPassword123!",
        },
      });
      expect(secondSignup.statusCode).toBe(201);
      const staffUser = secondSignup.json().user;
      const staffCookie = extractSessionCookie(secondSignup)!;
      expect(staffUser.role).toBe("user");
      expect(staffUser.activeCompanyId).toBe(DEFAULT_COMPANY_ID);

      // =========================================================================
      // 2. Company CRUD, Auto-Seeding, Partial Update & Cross-Company Branch Guard
      // =========================================================================
      // Non-admin blocked from creating a company
      const forbiddenCreate = await app.inject({
        method: "POST",
        url: "/api/companies",
        cookies: { erp_session: staffCookie },
        payload: { name: "Unauthorized Co" },
      });
      expect(forbiddenCreate.statusCode).toBe(403);

      // Admin creates COMP-02
      const createComp2 = await app.inject({
        method: "POST",
        url: "/api/companies",
        cookies: { erp_session: adminCookie },
        payload: {
          name: "Beta Subsidiary LLC",
          legalName: "Beta Subsidiary Legal Name",
          baseCurrency: "EUR",
          einvoicingMode: "zatca_qr",
          address: "200 Enterprise Way",
        },
      });
      expect(createComp2.statusCode).toBe(201);
      const comp2 = createComp2.json().company;
      expect(comp2.code).toBe("COMP-02");
      expect(comp2.baseCurrency).toBe("EUR");
      expect(comp2.defaultBranchId).toBeTruthy();

      // Verify COMP-02 auto-seeding across all tables
      const [comp2Branches, comp2Roles, comp2Seqs, comp2Coa, comp2Mappings, comp2Currencies, comp2Tax, comp2Fy, comp2Rules, comp2Units] =
        await Promise.all([
          db.select().from(branches).where(eq(branches.companyId, comp2.id)),
          db.select().from(customRoles).where(eq(customRoles.companyId, comp2.id)),
          db.select().from(documentSequences).where(eq(documentSequences.companyId, comp2.id)),
          db.select().from(chartOfAccounts).where(eq(chartOfAccounts.companyId, comp2.id)),
          db.select().from(glAccountMappings).where(eq(glAccountMappings.companyId, comp2.id)),
          db.select().from(currencies).where(eq(currencies.companyId, comp2.id)),
          db.select().from(taxCodes).where(eq(taxCodes.companyId, comp2.id)),
          db.select().from(fiscalYears).where(eq(fiscalYears.companyId, comp2.id)),
          db.select().from(approvalRules).where(eq(approvalRules.companyId, comp2.id)),
          db.select().from(taxonomyItems).where(and(eq(taxonomyItems.companyId, comp2.id), eq(taxonomyItems.kind, "unit"))),
        ]);

      expect(comp2Branches).toHaveLength(1);
      expect(comp2Roles).toHaveLength(SYSTEM_ROLE_PRESETS.length);
      expect(comp2Seqs).toHaveLength(26);
      expect(comp2Coa).toHaveLength(22);
      expect(comp2Mappings.length).toBeGreaterThanOrEqual(22);
      expect(comp2Currencies[0]?.code).toBe("EUR");
      expect(comp2Tax).toHaveLength(1);
      expect(comp2Fy).toHaveLength(2);
      expect(comp2Rules).toHaveLength(4);
      expect(comp2Units).toHaveLength(3);

      // Duplicate code -> 409
      const dupComp = await app.inject({
        method: "POST",
        url: "/api/companies",
        cookies: { erp_session: adminCookie },
        payload: { code: "COMP-02", name: "Duplicate Code Co" },
      });
      expect(dupComp.statusCode).toBe(409);

      // Partial PUT /api/companies/:id preserves legalName, baseCurrency, einvoicingMode, address
      const partialUpdate = await app.inject({
        method: "PUT",
        url: `/api/companies/${comp2.id}`,
        cookies: { erp_session: adminCookie },
        payload: { name: "Beta Subsidiary Holdings" },
      });
      expect(partialUpdate.statusCode).toBe(200);
      const updatedComp2 = partialUpdate.json().company;
      expect(updatedComp2.name).toBe("Beta Subsidiary Holdings");
      expect(updatedComp2.legalName).toBe("Beta Subsidiary Legal Name");
      expect(updatedComp2.baseCurrency).toBe("EUR");
      expect(updatedComp2.einvoicingMode).toBe("zatca_qr");
      expect(updatedComp2.address).toBe("200 Enterprise Way");

      // Cross-company defaultBranchId validation on PUT /api/companies/:id
      const [comp1Branch] = await db
        .select()
        .from(branches)
        .where(eq(branches.companyId, DEFAULT_COMPANY_ID))
        .limit(1);
      const badBranchAssign = await app.inject({
        method: "PUT",
        url: `/api/companies/${comp2.id}`,
        cookies: { erp_session: adminCookie },
        payload: { defaultBranchId: comp1Branch!.id },
      });
      expect(badBranchAssign.statusCode).toBe(400);

      // Protect COMP-01 from deletion or deactivation
      const deleteDefault = await app.inject({
        method: "DELETE",
        url: `/api/companies/${DEFAULT_COMPANY_ID}`,
        cookies: { erp_session: adminCookie },
      });
      expect(deleteDefault.statusCode).toBe(400);

      const deactivateDefault = await app.inject({
        method: "PUT",
        url: `/api/companies/${DEFAULT_COMPANY_ID}`,
        cookies: { erp_session: adminCookie },
        payload: { isActive: false },
      });
      expect(deactivateDefault.statusCode).toBe(400);

      // Create COMP-03 and delete it cleanly
      const createComp3 = await app.inject({
        method: "POST",
        url: "/api/companies",
        cookies: { erp_session: adminCookie },
        payload: { name: "Disposable Co" },
      });
      expect(createComp3.statusCode).toBe(201);
      const comp3 = createComp3.json().company;
      expect(comp3.code).toBe("COMP-03");

      const deleteComp3 = await app.inject({
        method: "DELETE",
        url: `/api/companies/${comp3.id}`,
        cookies: { erp_session: adminCookie },
      });
      expect(deleteComp3.statusCode).toBe(200);

      // =========================================================================
      // 3. Company Switcher & Settings Scoping / Mirroring
      // =========================================================================
      // Non-member staffUser cannot switch to COMP-02
      const forbiddenSwitch = await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        cookies: { erp_session: staffCookie },
        payload: { companyId: comp2.id },
      });
      expect(forbiddenSwitch.statusCode).toBe(403);

      // Update COMP-01 settings -> mirrors to company_settings (id=1)
      const comp1SettingsRes = await app.inject({
        method: "PUT",
        url: "/api/settings/company",
        cookies: { erp_session: adminCookie },
        payload: { companyName: "Alpha HQ Corp", baseCurrency: "USD" },
      });
      expect(comp1SettingsRes.statusCode).toBe(200);

      const [singletonSettings] = await db
        .select()
        .from(companySettings)
        .where(eq(companySettings.id, 1));
      expect(singletonSettings?.companyName).toBe("Alpha HQ Corp");

      // Admin switches to COMP-02
      const adminSwitch = await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        cookies: { erp_session: adminCookie },
        payload: { companyId: comp2.id },
      });
      expect(adminSwitch.statusCode).toBe(200);
      expect(adminSwitch.json().user.activeCompanyId).toBe(comp2.id);
      expect(adminSwitch.json().user.branchIds).toEqual([comp2Branches[0]!.id]);

      // GET/PUT /api/settings/company on COMP-02 must NOT clobber company_settings (id=1)
      const comp2SettingsGet = await app.inject({
        method: "GET",
        url: "/api/settings/company",
        cookies: { erp_session: adminCookie },
      });
      expect(comp2SettingsGet.statusCode).toBe(200);
      expect(comp2SettingsGet.json().company.companyName).toBe("Beta Subsidiary Holdings");
      expect(comp2SettingsGet.json().company.baseCurrency).toBe("EUR");

      const comp2SettingsPut = await app.inject({
        method: "PUT",
        url: "/api/settings/company",
        cookies: { erp_session: adminCookie },
        payload: { companyName: "Beta Holdings Updated", baseCurrency: "EUR" },
      });
      expect(comp2SettingsPut.statusCode).toBe(200);

      const [singletonAfterComp2] = await db
        .select()
        .from(companySettings)
        .where(eq(companySettings.id, 1));
      expect(singletonAfterComp2?.companyName).toBe("Alpha HQ Corp");

      // Switch back to COMP-01 for role tests
      const switchBack = await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        cookies: { erp_session: adminCookie },
        payload: { companyId: DEFAULT_COMPANY_ID },
      });
      expect(switchBack.statusCode).toBe(200);

      // =========================================================================
      // 4. Dynamic Custom Roles CRUD, RBAC Enforcement & Legacy Compatibility
      // =========================================================================
      const listRolesRes = await app.inject({
        method: "GET",
        url: "/api/custom-roles",
        cookies: { erp_session: adminCookie },
      });
      expect(listRolesRes.statusCode).toBe(200);
      const seededRoles = listRolesRes.json().roles;
      expect(seededRoles).toHaveLength(8);

      const adminSystemRole = seededRoles.find((r: { name: string }) => r.name === "Admin");
      expect(adminSystemRole.isSystem).toBe(true);

      // Cannot delete or rename system role
      const deleteSysRole = await app.inject({
        method: "DELETE",
        url: `/api/custom-roles/${adminSystemRole.id}`,
        cookies: { erp_session: adminCookie },
      });
      expect(deleteSysRole.statusCode).toBe(400);

      const renameSysRole = await app.inject({
        method: "PUT",
        url: `/api/custom-roles/${adminSystemRole.id}`,
        cookies: { erp_session: adminCookie },
        payload: { name: "Renamed Admin" },
      });
      expect(renameSysRole.statusCode).toBe(400);

      // Partial/invalid 18-module permission map -> 400 VALIDATION_ERROR
      const badCustomRole = await app.inject({
        method: "POST",
        url: "/api/custom-roles",
        cookies: { erp_session: adminCookie },
        payload: {
          name: "Broken Role",
          baseRole: "user",
          permissions: { audit: { view: true } },
        },
      });
      expect(badCustomRole.statusCode).toBe(400);

      // Valid custom role: allows audit.view & products.view, denies products.create
      const auditorPerms = buildCustomPermissions({
        audit: { view: true, create: false, edit: false, delete: false, approve: false },
        products: { view: true, create: false, edit: false, delete: false, approve: false },
      });
      const createRoleRes = await app.inject({
        method: "POST",
        url: "/api/custom-roles",
        cookies: { erp_session: adminCookie },
        payload: {
          name: "External Auditor",
          description: "Read-only audit and catalog reviewer",
          baseRole: "user",
          permissions: auditorPerms,
        },
      });
      expect(createRoleRes.statusCode).toBe(201);
      const customAuditorRole = createRoleRes.json().role;
      expect(customAuditorRole.permissions.audit.view).toBe(true);
      expect(customAuditorRole.permissions.products.create).toBe(false);

      // Before role assignment, staffUser gets 403 on GET /api/audit-logs (user.audit.view === false)
      const deniedAudit = await app.inject({
        method: "GET",
        url: "/api/audit-logs",
        cookies: { erp_session: staffCookie },
      });
      expect(deniedAudit.statusCode).toBe(403);

      // Assign custom role via PUT /api/users/:id/role
      const assignCustomRes = await app.inject({
        method: "PUT",
        url: `/api/users/${staffUser.id}/role`,
        cookies: { erp_session: adminCookie },
        payload: { customRoleId: customAuditorRole.id },
      });
      expect(assignCustomRes.statusCode).toBe(200);

      // Cannot delete custom role while assigned -> 409
      const deleteInUse = await app.inject({
        method: "DELETE",
        url: `/api/custom-roles/${customAuditorRole.id}`,
        cookies: { erp_session: adminCookie },
      });
      expect(deleteInUse.statusCode).toBe(409);

      // Now staffUser can GET /api/audit-logs (200) but still cannot POST /api/products (403)
      const allowedAudit = await app.inject({
        method: "GET",
        url: "/api/audit-logs",
        cookies: { erp_session: staffCookie },
      });
      expect(allowedAudit.statusCode).toBe(200);

      const deniedProductCreate = await app.inject({
        method: "POST",
        url: "/api/products",
        cookies: { erp_session: staffCookie },
        payload: { sku: "AUD-1", name: "Blocked", unit: "pcs", price: 10 },
      });
      expect(deniedProductCreate.statusCode).toBe(403);

      // Legacy PUT /api/users/:id/role with { role: "manager" } clears customRoleId & keeps compat
      const legacyRoleUpdate = await app.inject({
        method: "PUT",
        url: `/api/users/${staffUser.id}/role`,
        cookies: { erp_session: adminCookie },
        payload: { role: "manager" },
      });
      expect(legacyRoleUpdate.statusCode).toBe(200);

      const staffMeAfterLegacy = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { erp_session: staffCookie },
      });
      expect(staffMeAfterLegacy.json().user.role).toBe("manager");
      expect(staffMeAfterLegacy.json().user.customRoleId).toBeNull();

      // Now unused custom role can be deleted cleanly
      const deleteCustomOk = await app.inject({
        method: "DELETE",
        url: `/api/custom-roles/${customAuditorRole.id}`,
        cookies: { erp_session: adminCookie },
      });
      expect(deleteCustomOk.statusCode).toBe(200);

      // Last-admin protection
      const demoteLastAdmin = await app.inject({
        method: "PUT",
        url: `/api/users/${adminUser.id}/role`,
        cookies: { erp_session: adminCookie },
        payload: { role: "user" },
      });
      expect(demoteLastAdmin.statusCode).toBe(400);
      expect(demoteLastAdmin.json().code).toBe("LAST_ADMIN_PROTECTED");

      // Legacy GET / PUT /api/roles/permissions backward compatibility
      const permsGet = await app.inject({
        method: "GET",
        url: "/api/roles/permissions",
        cookies: { erp_session: adminCookie },
      });
      expect(permsGet.statusCode).toBe(200);
      const matrix = permsGet.json().matrix;
      const permsPut = await app.inject({
        method: "PUT",
        url: "/api/roles/permissions",
        cookies: { erp_session: adminCookie },
        payload: { matrix },
      });
      expect(permsPut.statusCode).toBe(200);

      // =========================================================================
      // 5. TOTP 2FA Full Lifecycle
      // =========================================================================
      const mfaStatusInitial = await app.inject({
        method: "GET",
        url: "/api/auth/mfa/status",
        cookies: { erp_session: staffCookie },
      });
      expect(mfaStatusInitial.statusCode).toBe(200);
      expect(mfaStatusInitial.json().enabled).toBe(false);

      const enrollRes = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/enroll",
        cookies: { erp_session: staffCookie },
      });
      expect(enrollRes.statusCode).toBe(200);
      const enrollBody = enrollRes.json();
      expect(enrollBody.otpauthUrl).toContain("otpauth://totp/");
      expect(enrollBody.secretMasked).toContain("••••••••");
      expect(enrollBody.recoveryCodes).toHaveLength(8);

      const secretMatch = /secret=([A-Z2-7]+)/.exec(enrollBody.otpauthUrl);
      expect(secretMatch).toBeTruthy();
      const totpSecret = secretMatch![1]!;

      // Ensure DB holds encrypted secret and NOT plaintext secret
      const [mfaDbRow] = await db.select().from(userMfa).where(eq(userMfa.userId, staffUser.id));
      expect(mfaDbRow?.isEnabled).toBe(false);
      expect(mfaDbRow?.totpSecretEncrypted).not.toContain(totpSecret);

      // Wrong code fails verification
      const badVerify = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify",
        cookies: { erp_session: staffCookie },
        payload: { code: "000000" },
      });
      expect([400, 401]).toContain(badVerify.statusCode);

      // Valid TOTP enables MFA
      const validVerify = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify",
        cookies: { erp_session: staffCookie },
        payload: { code: generateTotp(totpSecret) },
      });
      expect(validVerify.statusCode).toBe(200);
      expect(validVerify.json().enabled).toBe(true);

      // Login now returns MFA challenge WITHOUT setting erp_session cookie
      const mfaLoginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "user-agent": "MfaDevice/1.0" },
        payload: { email: "staff@m2.test", password: "StaffPassword123!" },
      });
      expect(mfaLoginRes.statusCode).toBe(200);
      expect(mfaLoginRes.json().mfaRequired).toBe(true);
      expect(mfaLoginRes.json().mfaChallengeToken).toBeTruthy();
      expect(extractSessionCookie(mfaLoginRes)).toBeUndefined();

      const challengeToken = mfaLoginRes.json().mfaChallengeToken as string;

      // Wrong code on verify-login -> 401
      const wrongLoginCode = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        payload: { mfaChallengeToken: challengeToken, code: "999999" },
      });
      expect(wrongLoginCode.statusCode).toBe(401);

      // Valid TOTP completes login and sets erp_session cookie
      const okLoginMfa = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        headers: { "user-agent": "MfaDevice/1.0" },
        payload: { mfaChallengeToken: challengeToken, code: generateTotp(totpSecret) },
      });
      expect(okLoginMfa.statusCode).toBe(200);
      const mfaSessionCookie = extractSessionCookie(okLoginMfa);
      expect(mfaSessionCookie).toBeTruthy();

      // Replaying the same challenge token must fail
      const replayChallenge = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        payload: { mfaChallengeToken: challengeToken, code: generateTotp(totpSecret) },
      });
      expect(replayChallenge.statusCode).toBe(401);

      // Login using a single-use recovery code
      const mfaLoginRes2 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "staff@m2.test", password: "StaffPassword123!" },
      });
      const challenge2 = mfaLoginRes2.json().mfaChallengeToken as string;
      const recoveryCode = enrollBody.recoveryCodes[0] as string;

      const recoveryLogin = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        payload: { mfaChallengeToken: challenge2, code: recoveryCode },
      });
      expect(recoveryLogin.statusCode).toBe(200);
      expect(extractSessionCookie(recoveryLogin)).toBeTruthy();

      const statusAfterRecovery = await app.inject({
        method: "GET",
        url: "/api/auth/mfa/status",
        cookies: { erp_session: staffCookie },
      });
      expect(statusAfterRecovery.json().recoveryCodesRemaining).toBe(7);

      // Replaying consumed recovery code must fail
      const mfaLoginRes3 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "staff@m2.test", password: "StaffPassword123!" },
      });
      const replayRecovery = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/verify-login",
        payload: {
          mfaChallengeToken: mfaLoginRes3.json().mfaChallengeToken,
          code: recoveryCode,
        },
      });
      expect(replayRecovery.statusCode).toBe(401);

      // Empty {} to regenerate recovery codes -> 400 VALIDATION_ERROR
      const regenEmpty = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/recovery-codes",
        cookies: { erp_session: staffCookie },
        payload: {},
      });
      expect(regenEmpty.statusCode).toBe(400);

      // Valid password regenerates 8 fresh recovery codes
      const regenOk = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/recovery-codes",
        cookies: { erp_session: staffCookie },
        payload: { password: "StaffPassword123!" },
      });
      expect(regenOk.statusCode).toBe(200);
      expect(regenOk.json().recoveryCodes).toHaveLength(8);

      // Disable MFA (wrong password -> 401, valid password -> 200)
      const disableWrongPw = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/disable",
        cookies: { erp_session: staffCookie },
        payload: { password: "WrongPassword!" },
      });
      expect(disableWrongPw.statusCode).toBe(401);

      const disableOk = await app.inject({
        method: "POST",
        url: "/api/auth/mfa/disable",
        cookies: { erp_session: staffCookie },
        payload: { password: "StaffPassword123!" },
      });
      expect(disableOk.statusCode).toBe(200);
      expect(disableOk.json().enabled).toBe(false);

      // =========================================================================
      // 6. Active Sessions Listing & Revocation
      // =========================================================================
      const adminLogin2 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "user-agent": "TestBrowser/2.0" },
        payload: { email: "root-admin@m2.test", password: "AdminPassword123!" },
      });
      expect(adminLogin2.statusCode).toBe(200);
      const adminCookie2 = extractSessionCookie(adminLogin2)!;

      const sessionsRes = await app.inject({
        method: "GET",
        url: "/api/auth/sessions",
        cookies: { erp_session: adminCookie },
      });
      expect(sessionsRes.statusCode).toBe(200);
      const adminSessions = sessionsRes.json().sessions as Array<{
        id: string;
        userAgent: string | null;
        isCurrent: boolean;
        tokenHash?: string;
      }>;
      expect(adminSessions).toHaveLength(2);
      expect(adminSessions.filter((s) => s.isCurrent)).toHaveLength(1);
      expect(adminSessions.every((s) => s.tokenHash === undefined)).toBe(true);

      // Staff user cannot revoke admin's session -> 404
      const crossUserRevoke = await app.inject({
        method: "DELETE",
        url: `/api/auth/sessions/${adminSessions[0]!.id}`,
        cookies: { erp_session: staffCookie },
      });
      expect(crossUserRevoke.statusCode).toBe(404);

      // Admin revokes their second session
      const otherAdminSession = adminSessions.find((s) => !s.isCurrent)!;
      const revokeOther = await app.inject({
        method: "DELETE",
        url: `/api/auth/sessions/${otherAdminSession.id}`,
        cookies: { erp_session: adminCookie },
      });
      expect(revokeOther.statusCode).toBe(200);

      // Revoked cookie is now unauthenticated
      const revokedMe = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { erp_session: adminCookie2 },
      });
      expect(revokedMe.statusCode).toBe(200);
      expect(revokedMe.json().user).toBeNull();

      // Create 2 more sessions for admin and call revoke-others
      const adminLogin3 = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "root-admin@m2.test", password: "AdminPassword123!" },
      });
      const adminCookie3 = extractSessionCookie(adminLogin3)!;

      const revokeOthersRes = await app.inject({
        method: "POST",
        url: "/api/auth/sessions/revoke-others",
        cookies: { erp_session: adminCookie },
      });
      expect(revokeOthersRes.statusCode).toBe(200);
      expect(revokeOthersRes.json().revokedCount).toBe(1);

      const thirdMe = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { erp_session: adminCookie3 },
      });
      expect(thirdMe.json().user).toBeNull();

      const currentMeStillValid = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { erp_session: adminCookie },
      });
      expect(currentMeStillValid.json().user.id).toBe(adminUser.id);

      // =========================================================================
      // 7. Audit Log Diffs, Scrubbing & Company Isolation
      // =========================================================================
      const comp1AuditRes = await app.inject({
        method: "GET",
        url: "/api/audit-logs?limit=100",
        cookies: { erp_session: adminCookie },
      });
      expect(comp1AuditRes.statusCode).toBe(200);
      const comp1AuditEntries = comp1AuditRes.json().entries as Array<{
        companyId: string;
        action: string;
        beforeJson: Record<string, unknown> | null;
        afterJson: Record<string, unknown> | null;
        changedFields: string[];
      }>;
      expect(comp1AuditEntries.length).toBeGreaterThan(0);
      expect(comp1AuditEntries.every((e) => e.companyId === DEFAULT_COMPANY_ID)).toBe(true);

      const settingsAudit = comp1AuditEntries.find((e) => e.action === "settings.company_updated");
      expect(settingsAudit?.afterJson?.companyName).toBe("Alpha HQ Corp");
      expect(settingsAudit?.changedFields).toContain("companyName");

      // Switch to COMP-02 and verify audit log isolation
      await app.inject({
        method: "POST",
        url: "/api/auth/switch-company",
        cookies: { erp_session: adminCookie },
        payload: { companyId: comp2.id },
      });

      const comp2AuditRes = await app.inject({
        method: "GET",
        url: "/api/audit-logs?limit=100",
        cookies: { erp_session: adminCookie },
      });
      expect(comp2AuditRes.statusCode).toBe(200);
      const comp2AuditEntries = comp2AuditRes.json().entries as Array<{
        companyId: string;
        action: string;
      }>;
      expect(comp2AuditEntries.length).toBeGreaterThan(0);
      expect(comp2AuditEntries.every((e) => e.companyId === comp2.id)).toBe(true);
      expect(comp2AuditEntries.some((e) => e.action === "company.created")).toBe(true);
      expect(comp2AuditEntries.some((e) => e.action === "auth.signup")).toBe(false);

      // Verify export-backup is scoped to COMP-02
      const comp2Backup = await app.inject({
        method: "GET",
        url: "/api/admin/export-backup",
        cookies: { erp_session: adminCookie },
      });
      expect(comp2Backup.statusCode).toBe(200);
      expect(comp2Backup.json().company.code).toBe("COMP-02");
      expect(comp2Backup.json().branches).toHaveLength(1);
      expect(comp2Backup.json().branches[0].companyId).toBe(comp2.id);

      // Verify no raw password/secret/token strings exist anywhere in audit_logs
      const allAuditRows = await db
        .select()
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(200);
      const serializedAudit = JSON.stringify(allAuditRows);
      expect(serializedAudit).not.toContain("AdminPassword123!");
      expect(serializedAudit).not.toContain("StaffPassword123!");
      expect(serializedAudit).not.toContain(totpSecret);
      expect(serializedAudit).not.toContain(recoveryCode);
    });
  }
);
