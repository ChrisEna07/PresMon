import type { BaseRecord } from '../../db/models';
import { db } from '../../db/db';
import { loadFirebaseConfig } from './firebaseConfig';

const SYNCED_COLLECTIONS = [
  'tenants',
  'users',
  'borrowers',
  'loans',
  'installments',
  'audit_logs',
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

export async function runSync(tenantId?: string): Promise<SyncResult> {
  const fs = await getFirestore();
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

  for (const name of SYNCED_COLLECTIONS) {
    if (tenantId && (name === 'tenants' || name === 'users')) continue;
    try {
      const table = db.table(name);
      const key = idKeyOf(name);
      const all = (await table.toArray()) as Array<BaseRecord & Record<string, unknown>>;

      const pending = all.filter(
        (r) => r.syncStatus !== 'SYNCED' && (!tenantId || r.tenantId === tenantId),
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

export function getLastSync(tenantId: string): number {
  const raw = localStorage.getItem(`presmon_last_sync_${tenantId}`);
  return raw ? Number(raw) : 0;
}

export function setLastSync(tenantId: string): void {
  localStorage.setItem(`presmon_last_sync_${tenantId}`, String(Date.now()));
}
