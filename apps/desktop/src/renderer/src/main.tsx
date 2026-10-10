import './theme/base.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { IpcError } from './lib/api';
import { showError } from './lib/ops';
import { applyTheme } from './theme/builtin';

// Paint with a theme before settings arrive to avoid a white flash.
applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'builtin:dark' : 'builtin:light');

// Safety net: actions are often fire-and-forget; never let a git failure vanish silently.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof IpcError) {
    e.preventDefault();
    showError(e.reason.error);
  }
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
