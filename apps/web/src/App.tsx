import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './layout/AppShell.tsx';
import { LiveTradingPage } from './features/LiveTradingPage.tsx';
import { StrategyIdePage } from './features/StrategyIdePage.tsx';
import { BacktestPage } from './features/BacktestPage.tsx';
import { RiskFleetPage } from './features/RiskFleetPage.tsx';

/* ============================================================================
 * Routes — one per Stitch screen, plus a fallback to the live terminal.
 * ==========================================================================*/

export function App() {
  return (
    // The shell renders NavLinks, so the router has to wrap it rather than sit
    // inside it — otherwise useLocation() throws on the first render.
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<LiveTradingPage />} />
          <Route path="/strategy-ide" element={<StrategyIdePage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/risk" element={<RiskFleetPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
