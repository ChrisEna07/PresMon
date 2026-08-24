import type { BaseRecord } from '../../db/models';
import { db, nowISO } from '../../db/db';
import { loadFirebaseConfig } from './firebaseConfig';

const SYNCED_COLLECTIONS = [
  'tenants',
  'users',
  'borrowers',
  'loans',
  'installments',
  'audit_logs',
  'plans',
  'loan_requests',
] as const;

type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

export function isSyncConfigured(): boolean {
  return loadFirebaseConfig() !== null;
}

export function friendlySyncError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|err_name|network request failed|internetdisconnected/i.test(msg)) {
    return 'Sin conexión. Tus cambios están a salvo en este dispositivo y se subirán solos al reconectar.';
  }
  return msg;
}

function idKeyOf(collection: SyncedCollection): string {
  return collection === 'audit_logs' ? 'logId' : collection.slice(0, -1) + 'Id';
}

function sanitize(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function getFirestore() {
  const cfg = loadFirebaseConfig();
  if (!cfg) throw new Error('Firebase no está configurado.');
  const { initializeApp, getApps } = await import('firebase/app');
  const { getFirestore } = await import('firebase/firestore');
  const app = getApps()[0] ?? initializeApp(cfg);
  return getFirestore(app);
}

const OPERATIONAL_COLLECTIONS = new Set<string>([
  'borrowers',
  'loans',
  'installments',
  'audit_logs',
]);

async function getCloudDisabledTenants(): Promise<Set<string>> {
  const tenants = await db.tenants.toArray();
  return new Set(tenants.filter((t) => t.cloudSyncEnabled === false).map((t) => t.tenantId));
}

export async function runSync(tenantId?: string): Promise<SyncResult> {
  const fs = await getFirestore();
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };
  const disabled = await getCloudDisabledTenants();

  for (const name of SYNCED_COLLECTIONS) {
    try {
      const table = db.table(name);
      const key = idKeyOf(name);
      const all = (await table.toArray()) as Array<BaseRecord & Record<string, unknown>>;

      const pending = all.filter(
        (r) =>
          r.syncStatus !== 'SYNCED' &&
          (!tenantId || r.tenantId === tenantId) &&
          !(OPERATIONAL_COLLECTIONS.has(name) && disabled.has(String(r.tenantId ?? ''))),
      );

      if (pending.length > 0) {
        const { doc, setDoc } = await import('firebase/firestore');
        for (const record of pending) {
          await setDoc(doc(fs, name, String(record[key])), sanitize({ ...record }));
        }
        await table.bulkPut(pending.map((r) => ({ ...r, syncStatus: 'SYNCED' })));
        result.pushed += pending.length;
      }

      const { collection, doc, getDoc, getDocs, query, where } = await import(
        'firebase/firestore'
      );
      const colRef = tenantId
        ? query(collection(fs, name), where('tenantId', '==', tenantId))
        : collection(fs, name);
      const snap = await getDocs(colRef);

      for (const d of snap.docs) {
        const remote = d.data() as (BaseRecord & Record<string, unknown>) | undefined;
        if (!remote || !remote[key]) continue;
        if (OPERATIONAL_COLLECTIONS.has(name) && disabled.has(String(remote.tenantId ?? ''))) {
          continue;
        }
        const local = (await table.get(String(remote[key]))) as
          | (BaseRecord & Record<string, unknown>)
          | undefined;
        if (!local) {
          await table.put({ ...remote, syncStatus: 'SYNCED' });
          result.pulled += 1;
        } else if (String(remote.updatedAt ?? '') > String(local.updatedAt ?? '')) {
          const hadPendingLocalChanges = local.syncStatus === 'PENDING';
          await table.put({ ...remote, syncStatus: 'SYNCED' });
          result.pulled += 1;
          if (hadPendingLocalChanges) {
            const { logAudit } = await import('../auditLogger');
            await logAudit({
              tenantId: String(remote.tenantId ?? ''),
              action: 'SYNC_CONFLICT',
              actorId: 'system',
              actorName: 'Motor de sincronización',
              entityId: String(remote[key]),
              entityType: name,
              payloadSnapshot: { resolucion: 'LWW-gana-servidor', versionLocalPerdida: local },
            });
          }
        } else if (local.syncStatus === 'PENDING') {
          const { setDoc: setDoc2 } = await import('firebase/firestore');
          await setDoc2(doc(fs, name, String(local[key])), sanitize({ ...local }));
          await table.put({ ...local, syncStatus: 'SYNCED' });
          result.pushed += 1;
        }
      }
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export interface RemoteTenantState {
  found: boolean;
  status?: string;
  data?: Record<string, unknown>;
}

/**
 * Lee el documento remoto de una organización. Devuelve null si no hay
 * conexión o Firebase no está configurado (no se debe actuar en ese caso).
 */
export async function fetchRemoteTenant(tenantId: string): Promise<RemoteTenantState | null> {
  try {
    const fs = await getFirestore();
    const { doc, getDoc } = await import('firebase/firestore');
    const snap = await getDoc(doc(fs, 'tenants', tenantId));
    if (!snap.exists()) return { found: false };
    const data = snap.data() as Record<string, unknown> | undefined;
    return { found: true, status: String(data?.status ?? ''), data };
  } catch {
    return null;
  }
}

export async function pullBootstrap(): Promise<SyncResult> {
  const fs = await getFirestore();
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };
  const { collection, getDocs } = await import('firebase/firestore');

  for (const name of SYNCED_COLLECTIONS) {
    try {
      const table = db.table(name);
      const key = idKeyOf(name);
      const snap = await getDocs(collection(fs, name));
      for (const d of snap.docs) {
        const remote = d.data() as (BaseRecord & Record<string, unknown>) | undefined;
        if (!remote || !remote[key]) continue;
        const local = (await table.get(String(remote[key]))) as
          | (BaseRecord & Record<string, unknown>)
          | undefined;
        if (!local || String(remote.updatedAt ?? '') > String(local.updatedAt ?? '')) {
          await table.put({ ...remote, syncStatus: 'SYNCED' });
          result.pulled += 1;
        }
      }
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export async function purgeDocsFromCloud(
  entries: Array<{ collection: string; ids: string[] }>,
): Promise<number> {
  const fs = await getFirestore();
  const { doc, deleteDoc, writeBatch } = await import('firebase/firestore');
  let purged = 0;
  for (const { collection: name, ids } of entries) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      if (chunk.length <= 8) {
        for (const id of chunk) {
          await deleteDoc(doc(fs, name, id));
          purged += 1;
        }
      } else {
        const batch = writeBatch(fs);
        for (const id of chunk) batch.delete(doc(fs, name, id));
        await batch.commit();
        purged += chunk.length;
      }
    }
  }
  return purged;
}

export async function ensureSuperAdminSynced(userId: string): Promise<void> {
  try {
    const user = await db.users.get(userId);
    if (!user || user.role !== 'SUPER_ADMIN') return;
    if (user.syncStatus === 'SYNCED') {
      await db.users.put({ ...user, syncStatus: 'PENDING', updatedAt: nowISO() });
    }
  } catch {
    /* sin impacto local */
  }
}

export function getLastSync(tenantId: string): number {
  const raw = localStorage.getItem(`presmon_last_sync_${tenantId}`);
  return raw ? Number(raw) : 0;
}

export function setLastSync(tenantId: string): void {
  localStorage.setItem(`presmon_last_sync_${tenantId}`, String(Date.now()));
}
