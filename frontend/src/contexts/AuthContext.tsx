import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import type { User } from "@/types";

export interface PosSessionMeta {
  terminalId: string | null;
  isLocked: boolean;
  terminalOwnerId: string | null;
}

interface AuthContextType {
  user: User | null;
  posSession: PosSessionMeta | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  applyPosSessionUpdate: (user: User, posSession: PosSessionMeta) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [posSession, setPosSession] = useState<PosSessionMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiRequest<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setUser(res.user);
    setPosSession({ terminalId: null, isLocked: false, terminalOwnerId: res.user.id });
  }, []);

  const signup = useCallback(async (name: string, email: string, password: string) => {
    const res = await apiRequest<{ user: User; needsConfirmation?: boolean }>("/api/auth/signup", {
      method: "POST",
      body: { name, email, password },
    });
    setUser(res.user);
    setPosSession({ terminalId: null, isLocked: false, terminalOwnerId: res.user.id });
    return { needsConfirmation: Boolean(res.needsConfirmation) };
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRequest<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setPosSession(null);
    }
  }, []);

  const applyPosSessionUpdate = useCallback((nextUser: User, nextPosSession: PosSessionMeta) => {
    setUser(nextUser);
    setPosSession(nextPosSession);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, posSession, isLoading, login, signup, logout, refreshUser, applyPosSessionUpdate }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
