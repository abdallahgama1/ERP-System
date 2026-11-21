import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './i18n'
import { initFrontendSentry } from './lib/observability/sentry'

void initFrontendSentry();

createRoot(document.getElementById("root")!).render(<App />);
