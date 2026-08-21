import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './store/auth';
import { ToastProvider, useToast } from './components/ui/toast';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import BorrowersPage from './pages/BorrowersPage';
import LoansPage from './pages/LoansPage';
import NewLoanPage from './pages/NewLoanPage';
import LoanDetailPage from './pages/LoanDetailPage';
import CollectionsPage from './pages/CollectionsPage';
import SimulatorPage from './pages/SimulatorPage';
import AuditPage from './pages/AuditPage';
import SettingsPage from './pages/SettingsPage';
import SuperAdminPage from './pages/SuperAdminPage';
import ClientPortalPage from './pages/ClientPortalPage';
import { seedDatabase } from './db/db';
import { runMoraEvaluation, startDayWatch } from './lib/moraEngine';
import { isSyncConfigured, runSync, setLastSync } from './lib/sync/syncEngine';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth();
  if (!ready) return null;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (session?.role !== 'SUPER_ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppEffects() {
  const { session } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    void seedDatabase();
  }, []);

  useEffect(() => {
    if (!session) return;
    const actor = { id: session.userId, name: session.displayName };
    void runMoraEvaluation(session.tenantId || '', actor).then((changed) => {
      if (changed > 0) {
        toast(`Motor de mora: ${changed} cuota(s) actualizada(s) automáticamente.`, 'info');
      }
    });
    return startDayWatch(session.tenantId || '', actor);
  }, [session?.userId]);

  useEffect(() => {
    if (!session || !isSyncConfigured()) return;
    const attempt = () => {
      void runSync(session.role === 'SUPER_ADMIN' ? undefined : session.tenantId)
        .then((r) => {
          if (r.pushed > 0 || r.pulled > 0) {
            setLastSync(session.tenantId || 'global');
          }
        })
        .catch(() => undefined);
    };
    const t = window.setTimeout(attempt, 2500);
    const interval = window.setInterval(attempt, 5 * 60 * 1000);
    window.addEventListener('online', attempt);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(interval);
      window.removeEventListener('online', attempt);
    };
  }, [session?.userId]);

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppEffects />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/portal" element={<ClientPortalPage />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="borrowers" element={<BorrowersPage />} />
              <Route path="loans" element={<LoansPage />} />
              <Route path="loans/new" element={<NewLoanPage />} />
              <Route path="loans/:id" element={<LoanDetailPage />} />
              <Route path="collections" element={<CollectionsPage />} />
              <Route path="simulator" element={<SimulatorPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route
                path="super-admin"
                element={
                  <RequireSuperAdmin>
                    <SuperAdminPage />
                  </RequireSuperAdmin>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
