import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

const loadedLocales = new Set<string>(['en']);

export async function ensureLocaleLoaded(lng: string): Promise<void> {
  const normalized = lng.toLowerCase().startsWith('ar') ? 'ar' : 'en';
  if (loadedLocales.has(normalized)) return;
  if (normalized === 'ar') {
    const mod = await import('./locales/ar.json');
    i18n.addResourceBundle('ar', 'translation', mod.default, true, true);
    loadedLocales.add('ar');
  }
}

const resources = {
  en: { translation: en },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ar'],
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng'
    },
    interpolation: {
      escapeValue: false
    }
  });

const applyLanguage = (lng: string) => {
  const normalized = lng.toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const dir = normalized === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.dir = dir;
  document.documentElement.lang = normalized;
  localStorage.setItem('i18nextLng', normalized);
};

// Update document direction and lazily load locale JSON when language changes
i18n.on('languageChanged', (lng) => {
  applyLanguage(lng);
  void ensureLocaleLoaded(lng).then(() => {
    if (i18n.language === lng) {
      i18n.emit('loaded', { [lng]: { translation: true } });
    }
  });
});

// Set initial direction and load Arabic lazily only if active
const initDirection = () => {
  const currentLng = i18n.language || 'en';
  applyLanguage(currentLng);
  if (currentLng.toLowerCase().startsWith('ar')) {
    void ensureLocaleLoaded('ar').then(() => {
      void i18n.changeLanguage('ar');
    });
  }
};

initDirection();

export default i18n;
