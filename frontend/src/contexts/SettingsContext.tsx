import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";
import { useCompanySettingsQuery, usePreferencesQuery } from "@/hooks/queries/useSettingsQueries";

export interface UserSettings {
  appearance: "light" | "dark" | "system";
  currency: string;
  dateFormat: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD";
  timezone: string;
  lowStockThreshold: number;
  defaultView: "table" | "grid";
  emailNotifications: boolean;
  inAppNotifications: boolean;
  twoFactorEnabled: boolean;
}

export interface CompanyMeta {
  companyName: string;
  legalName: string | null;
  taxRegistrationNumber: string | null;
  baseCurrency: string;
  einvoicingMode: "none" | "zatca_qr" | "zatca_phase2" | "eta_egypt";
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface TaxCodeOption {
  id: string;
  code: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isInclusive: boolean;
  isActive: boolean;
  inputAccountId: string | null;
  outputAccountId: string | null;
}

const defaultSettings: UserSettings = {
  appearance: "system",
  currency: "USD",
  dateFormat: "MM/DD/YYYY",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lowStockThreshold: 10,
  defaultView: "table",
  emailNotifications: true,
  inAppNotifications: true,
  twoFactorEnabled: false,
};

interface SettingsContextType {
  settings: UserSettings;
  companyMeta: CompanyMeta | null;
  taxCodes: TaxCodeOption[];
  updateSettings: (newSettings: Partial<UserSettings>) => void;
  reloadCompanySettings: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const CACHE_KEY = "erp_user_settings_cache";

function readCachedSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<UserSettings>) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user, mfaEnabled } = useAuth();
  const queryClient = useQueryClient();
  const [localOverrides, setLocalOverrides] = useState<Partial<UserSettings>>(() => readCachedSettings());

  const companyQuery = useCompanySettingsQuery(Boolean(user));
  const preferencesQuery = usePreferencesQuery(Boolean(user));

  const companyMeta = useMemo<CompanyMeta | null>(() => {
    const c = companyQuery.data?.company;
    if (!c) return null;
    return {
      companyName: c.companyName,
      legalName: c.legalName ?? null,
      taxRegistrationNumber: c.taxRegistrationNumber ?? null,
      baseCurrency: c.baseCurrency || "USD",
      einvoicingMode: c.einvoicingMode || "none",
      address: c.address ?? null,
      phone: c.phone ?? null,
      email: c.email ?? null,
    };
  }, [companyQuery.data]);

  const taxCodes = useMemo<TaxCodeOption[]>(() => {
    const list = companyQuery.data?.taxCodes;
    if (!Array.isArray(list)) return [];
    return list.map((tc) => ({
      ...tc,
      rate: Number(tc.rate ?? 0),
    }));
  }, [companyQuery.data]);

  const settings = useMemo<UserSettings>(() => {
    const comp = companyQuery.data?.company;
    const compJson = comp?.settingsJson ?? {};
    const prefJson = preferencesQuery.data?.preferences?.preferencesJson ?? {};

    const base: UserSettings = {
      ...defaultSettings,
      ...localOverrides,
    };

    if (typeof comp?.baseCurrency === "string" && comp.baseCurrency.trim().length > 0) {
      base.currency = comp.baseCurrency.trim().toUpperCase();
    }
    if (typeof compJson.lowStockThreshold === "number") {
      base.lowStockThreshold = compJson.lowStockThreshold;
    }
    if (prefJson.appearance === "light" || prefJson.appearance === "dark" || prefJson.appearance === "system") {
      base.appearance = prefJson.appearance;
    }
    if (
      prefJson.dateFormat === "MM/DD/YYYY" ||
      prefJson.dateFormat === "DD/MM/YYYY" ||
      prefJson.dateFormat === "YYYY-MM-DD"
    ) {
      base.dateFormat = prefJson.dateFormat;
    }
    if (typeof prefJson.timezone === "string") {
      base.timezone = prefJson.timezone;
    }
    if (prefJson.defaultView === "table" || prefJson.defaultView === "grid") {
      base.defaultView = prefJson.defaultView;
    }
    if (typeof prefJson.emailNotifications === "boolean") {
      base.emailNotifications = prefJson.emailNotifications;
    }
    if (typeof prefJson.inAppNotifications === "boolean") {
      base.inAppNotifications = prefJson.inAppNotifications;
    }
    base.twoFactorEnabled = user ? mfaEnabled : base.twoFactorEnabled;

    return base;
  }, [companyQuery.data, preferencesQuery.data, localOverrides, user, mfaEnabled]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.appearance === "dark") {
      root.classList.add("dark");
    } else if (settings.appearance === "light") {
      root.classList.remove("dark");
    } else {
      const prefersDark =
        typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", prefersDark);
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage quota errors
    }
  }, [settings]);

  const reloadCompanySettings = useCallback(async () => {
    if (!user) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.companySettings }),
      queryClient.invalidateQueries({ queryKey: erpQueryKeys.preferences }),
    ]);
  }, [user, queryClient]);

  const updateSettings = useCallback(
    (newSettings: Partial<UserSettings>) => {
      setLocalOverrides((prev) => ({ ...prev, ...newSettings }));
      if (!user) return;

      const companyKeys: Array<keyof UserSettings> = ["currency", "lowStockThreshold"];
      const hasCompanyUpdate = companyKeys.some((k) => k in newSettings);
      if (hasCompanyUpdate && user.role === "admin") {
        void apiRequest("/api/settings/company", {
          method: "PUT",
          body: {
            ...(newSettings.currency ? { baseCurrency: newSettings.currency } : {}),
            ...(newSettings.lowStockThreshold !== undefined
              ? { settingsJson: { lowStockThreshold: newSettings.lowStockThreshold } }
              : {}),
          },
        })
          .then(() => queryClient.invalidateQueries({ queryKey: erpQueryKeys.companySettings }))
          .catch(() => {});
      }

      const prefUpdates: Record<string, unknown> = {};
      if (newSettings.appearance !== undefined) prefUpdates.appearance = newSettings.appearance;
      if (newSettings.dateFormat !== undefined) prefUpdates.dateFormat = newSettings.dateFormat;
      if (newSettings.timezone !== undefined) prefUpdates.timezone = newSettings.timezone;
      if (newSettings.defaultView !== undefined) prefUpdates.defaultView = newSettings.defaultView;
      if (newSettings.emailNotifications !== undefined)
        prefUpdates.emailNotifications = newSettings.emailNotifications;
      if (newSettings.inAppNotifications !== undefined)
        prefUpdates.inAppNotifications = newSettings.inAppNotifications;

      if (Object.keys(prefUpdates).length > 0) {
        void apiRequest("/api/settings/preferences", {
          method: "PUT",
          body: { preferencesJson: prefUpdates },
        })
          .then(() => queryClient.invalidateQueries({ queryKey: erpQueryKeys.preferences }))
          .catch(() => {});
      }
    },
    [user, queryClient]
  );

  const value = useMemo(
    () => ({ settings, companyMeta, taxCodes, updateSettings, reloadCompanySettings }),
    [settings, companyMeta, taxCodes, updateSettings, reloadCompanySettings]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
