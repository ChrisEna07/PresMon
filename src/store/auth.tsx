import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UserRole } from '../db/models';
import { db, deleteTenantCascade, wipeLocalTenantData } from '../db/db';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { fetchRemoteTenant, isSyncConfigured } from '../lib/sync/syncEngine';

export interface Session {
  userId: string;
  tenantId: string;
  role: UserRole;
  username: string;
  displayName: string;
  tenantName: string;
  clientPortalEnabled: boolean;
}

interface AuthContextValue {
  session: Session | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshSessionFlags: () => Promise<'ok' | 'forced-logout' | 'org-deleted'>;
}

const SESSION_KEY = 'presmon_session_v1';

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) setSession(JSON.parse(raw) as Session);
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
    setReady(true);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const uname = username.trim().toLowerCase();
    if (!uname || !password) throw new Error('Ingresa usuario y contraseña.');
    const user = await db.users.where('username').equals(uname).first();
    if (!user) throw new Error('Credenciales inválidas.');
    const hash = await sha256Hex(password);
    if (user.passHash !== hash) throw new Error('Credenciales inválidas.');
    if (!user.active) throw new Error('Este usuario está inactivo.');

    let tenantName = 'Plataforma Global';
    let clientPortalEnabled = false;
    if (user.role === 'TENANT_ADMIN') {
      // Verificación autoritativa contra la nube
      if (isSyncConfigured()) {
        const remote = await fetchRemoteTenant(user.tenantId);
        if (remote && remote.found && remote.data?.wipeLocalData === true) {
          await wipeLocalTenantData(user.tenantId).catch(() => undefined);
          throw new Error('Los datos locales de esta organización fueron eliminados por el Super Administrador.');
        }
        if (remote && (!remote.found || remote.status === 'DELETED')) {
          await deleteTenantCascade(user.tenantId).catch(() => undefined);
          throw new Error('Esta organización fue eliminada de la plataforma.');
        }
      }
      const tenant = await db.tenants.get(user.tenantId);
      if (!tenant) throw new Error('Organización no encontrada o datos locales eliminados.');
      if (tenant.wipeLocalData) {
        await wipeLocalTenantData(user.tenantId).catch(() => undefined);
        throw new Error('Los datos locales de esta organización fueron eliminados por el Super Administrador.');
      }
      if (tenant.offlineBlocked && !navigator.onLine) {
        throw new Error('El modo offline para esta organización fue revocado por el Super Administrador. Se requiere conexión.');
      }
      if (tenant.status === 'DELETED') {
        await deleteTenantCascade(user.tenantId).catch(() => undefined);
        throw new Error('Esta organización fue eliminada de la plataforma.');
      }
      if (tenant.status !== 'ACTIVE')
        throw new Error('Esta organización está suspendida. Contacta al administrador.');
      tenantName = tenant.name;
      clientPortalEnabled = tenant.clientPortalEnabled;
    }

    const next: Session = {
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      username: user.username,
      displayName: user.displayName,
      tenantName,
      clientPortalEnabled,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    try {
      void navigator.storage?.persist?.();
    } catch {
      /* noop */
    }
    await logAudit({
      tenantId: user.tenantId,
      action: 'AUTH_LOGIN',
      actorId: user.userId,
      actorName: user.displayName,
      entityType: 'users',
      entityId: user.userId,
    });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const refreshSessionFlags = useCallback(async (): Promise<
    'ok' | 'forced-logout' | 'org-deleted'
  > => {
    const current = sessionRef.current;
    if (!current) return 'ok';
    if (current.role !== 'TENANT_ADMIN') return 'ok';
    const user = await db.users.get(current.userId);
    if (!user || !user.active || user.tenantId !== current.tenantId) {
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      return 'forced-logout';
    }
    // Verificación autoritativa contra la nube (solo actúa si la lectura
    // tuvo éxito; offline no se toca nada).
    if (isSyncConfigured()) {
      const remote = await fetchRemoteTenant(current.tenantId);
      if (remote && remote.found && remote.data?.wipeLocalData === true) {
        await wipeLocalTenantData(current.tenantId).catch(() => undefined);
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
        return 'org-deleted';
      }
      if (remote && (!remote.found || remote.status === 'DELETED')) {
        await deleteTenantCascade(current.tenantId).catch(() => undefined);
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
        return 'org-deleted';
      }
    }
    const tenant = await db.tenants.get(current.tenantId);
    if (!tenant || tenant.wipeLocalData) {
      await wipeLocalTenantData(current.tenantId).catch(() => undefined);
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      return 'org-deleted';
    }
    if (tenant.offlineBlocked && !navigator.onLine) {
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      return 'forced-logout';
    }
    if (tenant.status !== 'ACTIVE') {
      const deleted = tenant.status === 'DELETED';
      if (deleted) await deleteTenantCascade(current.tenantId).catch(() => undefined);
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      return deleted ? 'org-deleted' : 'forced-logout';
    }
    const next: Session = {
      ...current,
      username: user.username,
      displayName: user.displayName,
      tenantName: tenant.name,
      clientPortalEnabled: tenant.clientPortalEnabled,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
    return 'ok';
  }, []);

  const value = useMemo(
    () => ({ session, ready, login, logout, refreshSessionFlags }),
    [session, ready, login, logout, refreshSessionFlags],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider.');
  return ctx;
}
