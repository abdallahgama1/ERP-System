import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { DEFAULT_COMPANY_ID, type UserCompanySummaryDto } from "@erp/shared";
import { apiRequest } from "@/lib/api-client";
import type { ModulePermissionFlags, User } from "@/types";

export interface PosSessionMeta {
  terminalId: string | null;
  isLocked: boolean;
  terminalOwnerId: string | null;
}

type LoginApiResponse =
  | {
      user: User;
      mfaRequired?: false;
    }
  | {
      mfaRequired: true;
      mfaChallengeToken: string;
    };

interface AuthContextType {
  user: User | null;
  posSession: PosSessionMeta | null;
  isLoading: boolean;
  activeCompanyId: string;
  companies: UserCompanySummaryDto[];
  customRoleId: string | null;
  customRoleName: string | null;
  mfaEnabled: boolean;
  permissions: Record<string, ModulePermissionFlags> | undefined;
  mfaRequired: boolean;
  mfaChallengeToken: string | null;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  verifyMfaLogin: (code: string, challengeToken?: string) => Promise<void>;
  clearMfaChallenge: () => void;
  signup: (name: string, email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
  applyPosSessionUpdate: (user: User, posSession: PosSessionMeta) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useContext(QueryClientContext);
  const [user, setUser] = useState<User | null>(null);
  const [posSession, setPosSession] = useState<PosSessionMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);

  const clearMfaChallenge = useCallback(() => {
    setMfaRequired(false);
    setMfaChallengeToken(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await apiRequest<{ user: User | null; posSession?: PosSessionMeta | null }>("/api/auth/me");
      setUser(res.user ?? null);
      setPosSession(res.posSession ?? null);
    } catch {
      setUser(null);
      setPosSession(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiRequest<{ user: User | null; posSession?: PosSessionMeta | null }>("/api/auth/me");
        if (active) {
          setUser(res.user ?? null);
          setPosSession(res.posSession ?? null);
        }
      } catch {
        if (active) {
          setUser(null);
          setPosSession(null);
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<{ mfaRequired: boolean }> => {
      const res = await apiRequest<LoginApiResponse>("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });

      if ("mfaRequired" in res && res.mfaRequired && "mfaChallengeToken" in res) {
        setMfaRequired(true);
        setMfaChallengeToken(res.mfaChallengeToken);
        return { mfaRequired: true };
      }

      if (!("user" in res) || !res.user) {
        throw new Error("Invalid login response");
      }

      setUser(res.user);
      setPosSession({ terminalId: null, isLocked: false, terminalOwnerId: res.user.id });
      clearMfaChallenge();
      return { mfaRequired: false };
    },
    [clearMfaChallenge]
  );

  const verifyMfaLogin = useCallback(
    async (code: string, challengeToken?: string) => {
      const token = challengeToken ?? mfaChallengeToken;
      if (!token) {
        throw new Error("Missing MFA challenge token");
      }
      const res = await apiRequest<{ user: User; posSession?: PosSessionMeta | null }>("/api/auth/mfa/verify-login", {
        method: "POST",
        body: { mfaChallengeToken: token, code },
      });
      setUser(res.user);
      setPosSession(res.posSession ?? { terminalId: null, isLocked: false, terminalOwnerId: res.user.id });
      clearMfaChallenge();
    },
    [mfaChallengeToken, clearMfaChallenge]
  );

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      const res = await apiRequest<{ user: User; needsConfirmation?: boolean }>("/api/auth/signup", {
        method: "POST",
        body: { name, email, password },
      });
      setUser(res.user);
      setPosSession({ terminalId: null, isLocked: false, terminalOwnerId: res.user.id });
      clearMfaChallenge();
      return { needsConfirmation: Boolean(res.needsConfirmation) };
    },
    [clearMfaChallenge]
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setPosSession(null);
      clearMfaChallenge();
      queryClient?.clear();
    }
  }, [clearMfaChallenge, queryClient]);

  const switchCompany = useCallback(
    async (companyId: string) => {
      const res = await apiRequest<{ user?: User; activeCompanyId?: string }>("/api/auth/switch-company", {
        method: "POST",
        body: { companyId },
      });
      queryClient?.clear();
      if (res.user) {
        setUser(res.user);
      } else {
        await refreshUser();
      }
      await queryClient?.invalidateQueries();
    },
    [queryClient, refreshUser]
  );

  const applyPosSessionUpdate = useCallback((nextUser: User, nextPosSession: PosSessionMeta) => {
    setUser(nextUser);
    setPosSession(nextPosSession);
  }, []);

  const companies = useMemo<UserCompanySummaryDto[]>(() => user?.companies ?? [], [user?.companies]);
  const activeCompanyId = useMemo(
    () => user?.activeCompanyId ?? companies.find((c) => c.isDefault)?.id ?? DEFAULT_COMPANY_ID,
    [user?.activeCompanyId, companies]
  );
  const customRoleId = user?.customRoleId ?? null;
  const customRoleName = user?.customRoleName ?? null;
  const mfaEnabled = Boolean(user?.mfaEnabled);
  const permissions = user?.permissions;

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      posSession,
      isLoading,
      activeCompanyId,
      companies,
      customRoleId,
      customRoleName,
      mfaEnabled,
      permissions,
      mfaRequired,
      mfaChallengeToken,
      login,
      verifyMfaLogin,
      clearMfaChallenge,
      signup,
      logout,
      refreshUser,
      switchCompany,
      applyPosSessionUpdate,
    }),
    [
      user,
      posSession,
      isLoading,
      activeCompanyId,
      companies,
      customRoleId,
      customRoleName,
      mfaEnabled,
      permissions,
      mfaRequired,
      mfaChallengeToken,
      login,
      verifyMfaLogin,
      clearMfaChallenge,
      signup,
      logout,
      refreshUser,
      switchCompany,
      applyPosSessionUpdate,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
