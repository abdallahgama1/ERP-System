import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";

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
  const { user } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(readCachedSettings);
  const [companyMeta, setCompanyMeta] = useState<CompanyMeta | null>(null);
  const [taxCodes, setTaxCodes] = useState<TaxCodeOption[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.appearance === "dark") {
      root.classList.add("dark");
    } else if (settings.appearance === "light") {
      root.classList.remove("dark");
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
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
    try {
      const [compRes, prefRes] = await Promise.all([
        apiRequest<{
          company: (CompanyMeta & { settingsJson?: Record<string, unknown> }) | null;
          taxCodes?: Array<{
            id: string;
            code: string;
            name: string;
            rate: string | number;
            isDefault: boolean;
            isInclusive: boolean;
            isActive: boolean;
            inputAccountId: string | null;
            outputAccountId: string | null;
          }>;
        }>("/api/settings/company"),
        apiRequest<{
          preferences: {
            preferencesJson?: Record<string, unknown>;
          } | null;
        }>("/api/settings/preferences"),
      ]);

      const compJson = compRes.company?.settingsJson ?? {};
      const prefJson = prefRes.preferences?.preferencesJson ?? {};

      if (compRes.company) {
        setCompanyMeta({
          companyName: compRes.company.companyName,
          legalName: compRes.company.legalName ?? null,
          taxRegistrationNumber: compRes.company.taxRegistrationNumber ?? null,
          baseCurrency: compRes.company.baseCurrency || "USD",
          einvoicingMode: compRes.company.einvoicingMode || "none",
          address: compRes.company.address ?? null,
          phone: compRes.company.phone ?? null,
          email: compRes.company.email ?? null,
        });
      }

      if (Array.isArray(compRes.taxCodes)) {
        setTaxCodes(
          compRes.taxCodes.map((tc) => ({
            ...tc,
            rate: Number(tc.rate ?? 0),
          }))
        );
      }

      setSettings((prev) => ({
        ...prev,
        currency:
          typeof compRes.company?.baseCurrency === "string" && compRes.company.baseCurrency.trim().length > 0
            ? compRes.company.baseCurrency.trim().toUpperCase()
            : prev.currency,
        lowStockThreshold:
          typeof compJson.lowStockThreshold === "number" ? compJson.lowStockThreshold : prev.lowStockThreshold,
        appearance:
          prefJson.appearance === "light" || prefJson.appearance === "dark" || prefJson.appearance === "system"
            ? prefJson.appearance
            : prev.appearance,
        dateFormat:
          prefJson.dateFormat === "MM/DD/YYYY" ||
          prefJson.dateFormat === "DD/MM/YYYY" ||
          prefJson.dateFormat === "YYYY-MM-DD"
            ? prefJson.dateFormat
            : prev.dateFormat,
        timezone: typeof prefJson.timezone === "string" ? prefJson.timezone : prev.timezone,
        defaultView:
          prefJson.defaultView === "table" || prefJson.defaultView === "grid"
            ? prefJson.defaultView
            : prev.defaultView,
        emailNotifications:
          typeof prefJson.emailNotifications === "boolean"
            ? prefJson.emailNotifications
            : prev.emailNotifications,
        inAppNotifications:
          typeof prefJson.inAppNotifications === "boolean"
            ? prefJson.inAppNotifications
            : prev.inAppNotifications,
      }));
    } catch {
      // retain cached settings
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    void reloadCompanySettings();
  }, [user, reloadCompanySettings]);

  const updateSettings = useCallback(
    (newSettings: Partial<UserSettings>) => {
      setSettings((prev) => ({ ...prev, ...newSettings }));
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
        }).catch(() => {});
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
        }).catch(() => {});
      }
    },
    [user]
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
