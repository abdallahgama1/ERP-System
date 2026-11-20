import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Mail, Shield, User } from "lucide-react";

export default function Profile() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getRoleLabel = (role?: string) => {
    switch (role) {
      case 'admin':
        return t('users.admin');
      case 'manager':
        return t('users.manager');
      default:
        return t('users.user');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('profile.title')}</h1>
        <p className="text-muted-foreground">
          {t('profile.description')}
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t('profile.personalInfo')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <Avatar className="h-24 w-24 border-4 border-border">
                <AvatarImage src={undefined} alt={user?.name || 'User'} />
                <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">
                  {user?.name ? getInitials(user.name) : 'U'}
                </AvatarFallback>
              </Avatar>
              
              <div className="space-y-4 flex-1">
                <div className="flex items-center gap-3">
                  <User className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t('profile.fullName')}</p>
                    <p className="font-medium">{user?.name || t('profile.unknownUser')}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t('profile.emailAddress')}</p>
                    <p className="font-medium">{user?.email || t('profile.noEmail')}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">{t('common.role')}</p>
                    <Badge variant="secondary" className="capitalize">
                      {getRoleLabel(user?.role)}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.accountStatus')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t('profile.accountStatus')}</span>
              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">
                {t('common.active')}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t('profile.emailVerified')}</span>
              <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">
                {t('profile.verified')}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">{t('profile.twoFactorAuth')}</span>
              <Badge variant="outline">{t('profile.disabled')}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}