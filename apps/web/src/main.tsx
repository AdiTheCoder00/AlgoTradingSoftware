import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
// Self-hosted Material Symbols (the mockups' icon set) — no CDN dependency.
// Only the Outlined cut is imported: the package root would also load ~9 MB of
// Rounded/Sharp fonts the design never references.
import 'material-symbols/outlined.css';
import './styles/theme.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The tape is pushed over the WebSocket, so REST reads are allowed to go
      // stale quickly without triggering a fetch on every render.
      staleTime: 1_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
