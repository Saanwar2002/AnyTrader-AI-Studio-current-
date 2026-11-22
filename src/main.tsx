import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './components/AuthProvider';
import { RemoteConfigProvider } from './components/RemoteConfigProvider';
import { HelmetProvider } from 'react-helmet-async';
import { registerSW } from 'virtual:pwa-register';
import { installApiAuthInterceptor } from './lib/apiAuthInterceptor';

// Install Global Fetch Interceptor for Auth Token Injection
installApiAuthInterceptor();

// Register service worker for offline support and versioned cache management
if ('serviceWorker' in navigator) {
  // Clear legacy or outdated versioned caches and any legacy api-cache entries on startup
  if ('caches' in window) {
    const activeCachePrefix = 'anytrader-v1.0.4';
    caches.keys().then((cacheNames) => {
      cacheNames.forEach((cacheName) => {
        if (
          cacheName.startsWith('api-cache') ||
          (cacheName.startsWith('anytrader-') && !cacheName.startsWith(activeCachePrefix))
        ) {
          console.log(`[SW] Purging outdated or legacy API cache: ${cacheName}`);
          caches.delete(cacheName);
        }
      });
    }).catch((err) => console.warn('[SW] Cache cleanup check error:', err));
  }

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      console.log('App update available. Activating new service worker...');
      updateSW(true);
    },
    onOfflineReady() {
      console.log('App ready to work offline');
    },
    onRegisteredSW(_swUrl: string, registration?: ServiceWorkerRegistration) {
      if (registration) {
        // Periodically check for updates every hour
        setInterval(() => {
          registration.update().catch((e: any) => console.warn('[SW] Periodic update check failed:', e));
        }, 60 * 60 * 1000);
      }
    }
  });

  // Automatically refresh window when a new service worker controller takes over
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      console.log('[SW] Controller updated. Reloading page to ensure latest code execution...');
      window.location.reload();
    }
  });

  // Check for updates when the app comes back online
  window.addEventListener('online', () => {
    console.log('App is back online, checking for updates...');
    updateSW(true);
  });
}

const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('DIRECTIONS_ROUTE: UNKNOWN_ERROR')) {
    return; // Suppress internal Google Maps SDK noise
  }
  originalConsoleError(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <AuthProvider>
          <RemoteConfigProvider>
            <App />
          </RemoteConfigProvider>
        </AuthProvider>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>,
);
