import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './store/auth';
import { ToastProvider, useToast } from './components/ui/toast';
import { ErrorBoundary } from './components/ErrorBoundary';
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
import SuperPlansPage from './pages/SuperPlansPage';
import ClientPortalPage from './pages/ClientPortalPage';
import OfflineEditionPage from './pages/OfflineEditionPage';
import RequestsPage from './pages/RequestsPage';
import SocioPage from './pages/SocioPage';
import { seedDatabase } from './db/db';
import { runMoraEvaluation, startDayWatch } from './lib/moraEngine';
import { isSyncConfigured, runSync, setLastSync } from './lib/sync/syncEngine';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, ready } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-emerald-500 border-t-transparent" />
          <p className="text-xs font-medium text-slate-400">Iniciando PresMon…</p>
        </div>
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (session?.role !== 'SUPER_ADMIN') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RequireTenantAdmin({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (session?.role === 'SUPER_ADMIN') return <Navigate to="/super-admin" replace />;
  if (session?.role === 'SOCIO') return <Navigate to="/socio" replace />;
  return <>{children}</>;
}

function RootIndex() {
  const { session } = useAuth();
  if (session?.role === 'SUPER_ADMIN') return <Navigate to="/super-admin" replace />;
  if (session?.role === 'SOCIO') return <Navigate to="/socio" replace />;
  return <DashboardPage />;
}

function AppEffects() {
  const { session } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    void seedDatabase().catch((err) => console.warn('[Seed] Error inicializando base de datos:', err));
  }, []);

  useEffect(() => {
    if (!session) return;
    const actor = { id: session.userId, name: session.displayName };
    void runMoraEvaluation(session.tenantId || '', actor)
      .then((changed) => {
        if (changed > 0) {
          toast(`Motor de mora: ${changed} cuota(s) actualizada(s) automáticamente.`, 'info');
        }
      })
      .catch((err) => {
        console.warn('[Mora] Error en evaluación automática:', err);
      });
    return startDayWatch(session.tenantId || '', actor);
  }, [session?.userId]);

  useEffect(() => {
    if (!session || !isSyncConfigured()) return;
    const attempt = () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      void runSync(session.role === 'SUPER_ADMIN' ? undefined : session.tenantId)
        .then((r) => {
          if (r.pushed > 0 || r.pulled > 0) {
            setLastSync(session.tenantId || 'global');
          }
        })
        .catch(() => undefined);
    };
    const t = window.setTimeout(attempt, 1500);
    const interval = window.setInterval(attempt, 30 * 1000);
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
            <Route
              path="/login"
              element={
                <ErrorBoundary fallbackTitle="Error en pantalla de acceso">
                  <LoginPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/portal"
              element={
                <ErrorBoundary fallbackTitle="Error en portal de clientes">
                  <ClientPortalPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/edicion-offline"
              element={
                <ErrorBoundary fallbackTitle="Error en edición offline">
                  <OfflineEditionPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/socio"
              element={
                <ErrorBoundary fallbackTitle="Error en módulo de socio">
                  <SocioPage />
                </ErrorBoundary>
              }
            />
            <Route
              element={
                <RequireAuth>
                  <ErrorBoundary fallbackTitle="Error en la interfaz principal">
                    <Layout />
                  </ErrorBoundary>
                </RequireAuth>
              }
            >
              <Route index element={<RootIndex />} />
              <Route
                path="borrowers"
                element={
                  <RequireTenantAdmin>
                    <BorrowersPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="loans"
                element={
                  <RequireTenantAdmin>
                    <LoansPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="loans/new"
                element={
                  <RequireTenantAdmin>
                    <NewLoanPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="loans/:id"
                element={
                  <RequireTenantAdmin>
                    <LoanDetailPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="collections"
                element={
                  <RequireTenantAdmin>
                    <CollectionsPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="requests"
                element={
                  <RequireTenantAdmin>
                    <RequestsPage />
                  </RequireTenantAdmin>
                }
              />
              <Route
                path="simulator"
                element={
                  <RequireTenantAdmin>
                    <SimulatorPage />
                  </RequireTenantAdmin>
                }
              />
              <Route path="socio" element={<SocioPage />} />
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
              <Route
                path="super/plans"
                element={
                  <RequireSuperAdmin>
                    <SuperPlansPage />
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
