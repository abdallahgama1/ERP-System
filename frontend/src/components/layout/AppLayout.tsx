import { useTranslation } from "react-i18next";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { HeaderProfileDropdown } from "./HeaderProfileDropdown";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ConnectivityBadge } from "@/components/ConnectivityBadge";
import { NotificationBell } from "./NotificationBell";
import { BranchSwitcher } from "./BranchSwitcher";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { t } = useTranslation();
  
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        
        <div className="flex-1 flex flex-col">
          <header className="h-16 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center justify-between px-4">
            <div className="flex items-center">
              <SidebarTrigger className="me-4" />
              <h1 className="text-xl font-semibold text-foreground">
                {t('common.appName')}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <BranchSwitcher />
              <ConnectivityBadge />
              <NotificationBell />
              <LanguageSwitcher />
              <HeaderProfileDropdown />
            </div>
          </header>
          
          <main className="flex-1 p-6 bg-muted/20">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
