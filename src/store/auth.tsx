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
import type { Tenant, UserAccount, UserRole } from '../db/models';
import { db, deleteTenantCascade, wipeLocalTenantData } from '../db/db';
import { sha256Hex } from '../lib/crypto';
import { logAudit } from '../lib/auditLogger';
import { fetchRemoteTenant, isSyncConfigured, deepSanitize, runSync } from '../lib/sync/syncEngine';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';
import { reportPurgeConfirmation } from '../lib/offlineTelemetry';
import { uid } from '../lib/id';
import { nowISO } from '../lib/format';

export interface Session {
  userId: string;
  tenantId: string;
  role: UserRole;
  username: string;
  displayName: string;
  tenantName: string;
  clientPortalEnabled: boolean;
  sessionId?: string;
  deviceId?: string;
}

interface AuthContextValue {
  session: Session | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setDirectSession: (sess: Session) => void;
  refreshSessionFlags: () => Promise<'ok' | 'forced-logout' | 'org-deleted' | 'concurrent-logout'>;
}

const SESSION_KEY = 'presmon_session_v1';
const DEVICE_KEY = 'presmon_device_id_v1';

export function getOrCreateDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'dev-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'dev-browser-' + Date.now();
  }
}

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
    let user = await db.users.where('username').equals(uname).first();

    // Si la app no detecta el usuario en la base local (p. ej. tras purga o en dispositivo nuevo)
    // y hay conexión con la nube, autentica directamente contra Firestore
    if (!user && isSyncConfigured() && navigator.onLine) {
      try {
        const cfg = loadFirebaseConfig();
        if (cfg) {
          const { initializeApp, getApps } = await import('firebase/app');
          const { getFirestore, collection, query, where, getDocs } = await import('firebase/firestore');
          const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
          const q = query(collection(fs, 'users'), where('username', '==', uname));
          const snap = await getDocs(q);
          if (!snap.empty) {
            const foundUser = snap.docs[0].data() as UserAccount;
            if (foundUser && foundUser.userId) {
              await db.users.put({ ...foundUser, syncStatus: 'SYNCED' });
              user = foundUser;
            }
          }
        }
      } catch (err) {
        console.warn('[Auth] Error buscando usuario en Firestore:', err);
      }
    }

    if (!user) throw new Error('Credenciales inválidas.');
    const hash = await sha256Hex(password);
    if (user.passHash !== hash) throw new Error('Credenciales inválidas.');
    if (!user.active) throw new Error('Este usuario está inactivo.');

    let tenantName = 'Plataforma Global';
    let clientPortalEnabled = false;
    const deviceId = getOrCreateDeviceId();
    const sessionId = uid();
    const deviceName =
      typeof navigator !== 'undefined'
        ? navigator.userAgent.slice(0, 120)
        : 'Navegador Web';
    const now = nowISO();

    if (user.role === 'TENANT_ADMIN') {
      let remoteTenantData: Record<string, unknown> | null = null;
      // Verificación autoritativa contra la nube
      if (isSyncConfigured() && navigator.onLine) {
        const remote = await fetchRemoteTenant(user.tenantId);
        if (remote && (!remote.found || remote.status === 'DELETED')) {
          await deleteTenantCascade(user.tenantId).catch(() => undefined);
          throw new Error('Esta organización fue eliminada de la plataforma.');
        }
        if (remote && remote.found && remote.data) {
          remoteTenantData = remote.data;
          // Si el Super Admin emitió orden remota de purga de datos locales
          if (remote.data.wipeLocalData === true) {
            await wipeLocalTenantData(user.tenantId).catch(() => undefined);
            await reportPurgeConfirmation(user.tenantId).catch(() => undefined);

            const isOrgBlocked = remote.data.appLocked === true && !remote.data.unlockedByAdmin;
            if (remote.status !== 'ACTIVE' || isOrgBlocked) {
              throw new Error('Los datos locales fueron eliminados y la organización se encuentra suspendida o bloqueada.');
            }

            // Purga local ejecutada y confirmada a la nube.
            // Si la organización no está bloqueada en la nube, se preserva el usuario actual en Dexie para habilitar la sesión:
            await db.users.put({ ...user, syncStatus: 'SYNCED' });
          }
        }
      }

      let tenant = await db.tenants.get(user.tenantId);
      // Si la base local no tiene el tenant pero tenemos los datos remotos de Firestore, hidratarlo localmente
      if (!tenant && remoteTenantData) {
        tenant = {
          ...(remoteTenantData as unknown as Tenant),
          wipeLocalData: false,
          syncStatus: 'SYNCED',
        };
        await db.tenants.put(tenant);
      }
      if (!tenant) throw new Error('Organización no encontrada o datos locales eliminados.');

      if (tenant.wipeLocalData) {
        await wipeLocalTenantData(user.tenantId).catch(() => undefined);
        if (isSyncConfigured() && navigator.onLine) {
          await reportPurgeConfirmation(user.tenantId).catch(() => undefined);
        }
        tenant.wipeLocalData = false;
        await db.tenants.put({ ...tenant, wipeLocalData: false, syncStatus: 'SYNCED' });
        await db.users.put({ ...user, syncStatus: 'SYNCED' });
        const isOrgBlocked = tenant.appLocked === true && !tenant.unlockedByAdmin;
        if (tenant.status !== 'ACTIVE' || isOrgBlocked) {
          throw new Error('Los datos locales fueron eliminados y el acceso está bloqueado.');
        }
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

      // Actualizar sesión autorizada en la organización (para detectar colisiones en otros dispositivos)
      const sessionUpdate: Partial<Tenant> = {
        currentSessionId: sessionId,
        currentDeviceId: deviceId,
        currentDeviceName: deviceName,
        sessionStartedAt: now,
        lastSeenOnlineAt: now,
        lastSeenDevice: deviceName,
        updatedAt: now,
      };

      await db.tenants.update(user.tenantId, sessionUpdate);

      // Notificar a Firestore de inmediato si hay conexión
      const cfg = loadFirebaseConfig();
      if (cfg && navigator.onLine) {
        try {
          const { initializeApp, getApps } = await import('firebase/app');
          const { getFirestore, doc, setDoc } = await import('firebase/firestore');
          const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
          await setDoc(doc(fs, 'tenants', user.tenantId), deepSanitize(sessionUpdate), { merge: true });
        } catch {
          /* noop */
        }
      }
    } else if (user.role === 'SOCIO') {
      const tenant = await db.tenants.get(user.tenantId);
      if (!tenant || tenant.status !== 'ACTIVE') {
        throw new Error('Organización inactiva o no encontrada.');
      }
      if (tenant.socioModuleEnabled === false) {
        throw new Error('El módulo de Socio no está habilitado para esta organización.');
      }
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
      sessionId,
      deviceId,
    };
    localStorage.removeItem('presmon_logout_reason');
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
      payloadSnapshot: {
        dispositivo: deviceName,
        deviceId,
        sessionId,
      },
    });

    // Sincronización inmediata con Firestore para traer clientes, préstamos y cuotas
    if (isSyncConfigured() && navigator.onLine) {
      void runSync(user.role === 'SUPER_ADMIN' ? undefined : user.tenantId).catch(() => undefined);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const setDirectSession = useCallback((sess: Session) => {
    localStorage.removeItem('presmon_logout_reason');
    localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    setSession(sess);
  }, []);

  const refreshSessionFlags = useCallback(async (): Promise<
    'ok' | 'forced-logout' | 'org-deleted' | 'concurrent-logout'
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

    // Verificación autoritativa contra la nube
    if (isSyncConfigured() && navigator.onLine) {
      const remote = await fetchRemoteTenant(current.tenantId);
      if (remote && remote.found && remote.data?.wipeLocalData === true) {
        await wipeLocalTenantData(current.tenantId).catch(() => undefined);
        await reportPurgeConfirmation(current.tenantId).catch(() => undefined);

        const isOrgBlocked = remote.data.appLocked === true && !remote.data.unlockedByAdmin;
        if (remote.status !== 'ACTIVE' || isOrgBlocked) {
          localStorage.removeItem(SESSION_KEY);
          setSession(null);
          return 'org-deleted';
        }
        // Si no está bloqueada, restauramos usuario y tenant en Dexie y re-sincronizamos desde Firestore
        const u = await db.users.get(current.userId);
        if (!u) {
          await db.users.put({
            userId: current.userId,
            tenantId: current.tenantId,
            role: current.role,
            username: current.username,
            displayName: current.displayName,
            passHash: '',
            active: true,
            createdAt: nowISO(),
            updatedAt: nowISO(),
            syncStatus: 'SYNCED',
          });
        }
        const t = remote.data as unknown as Tenant;
        await db.tenants.put({ ...t, wipeLocalData: false, syncStatus: 'SYNCED' });
        void runSync(current.tenantId).catch(() => undefined);
      }
      if (remote && (!remote.found || remote.status === 'DELETED')) {
        await deleteTenantCascade(current.tenantId).catch(() => undefined);
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
        return 'org-deleted';
      }

      // Verificación de sesión concurrente en la nube (si el plan no permite multidispositivo)
      if (remote && remote.data) {
        const allowMulti = remote.data.allowMultipleSessions === true;
        const remoteSessionId = remote.data.currentSessionId;
        if (!allowMulti && remoteSessionId && current.sessionId && remoteSessionId !== current.sessionId) {
          localStorage.removeItem(SESSION_KEY);
          setSession(null);
          localStorage.setItem('presmon_logout_reason', 'CONCURRENT_DEVICE');
          return 'concurrent-logout';
        }
      }
    }

    const tenant = await db.tenants.get(current.tenantId);
    if (!tenant) {
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      return 'org-deleted';
    }
    if (tenant.wipeLocalData) {
      await wipeLocalTenantData(current.tenantId).catch(() => undefined);
      if (isSyncConfigured() && navigator.onLine) {
        await reportPurgeConfirmation(current.tenantId).catch(() => undefined);
      }
      tenant.wipeLocalData = false;
      await db.tenants.put({ ...tenant, wipeLocalData: false, syncStatus: 'SYNCED' });
      const isOrgBlocked = tenant.appLocked === true && !tenant.unlockedByAdmin;
      if (tenant.status !== 'ACTIVE' || isOrgBlocked) {
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
        return 'org-deleted';
      }
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

    // Verificación local de sesión concurrente
    if (!tenant.allowMultipleSessions && tenant.currentSessionId && current.sessionId && tenant.currentSessionId !== current.sessionId) {
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      localStorage.setItem('presmon_logout_reason', 'CONCURRENT_DEVICE');
      return 'concurrent-logout';
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
    () => ({ session, ready, login, logout, setDirectSession, refreshSessionFlags }),
    [session, ready, login, logout, setDirectSession, refreshSessionFlags],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider.');
  return ctx;
}
