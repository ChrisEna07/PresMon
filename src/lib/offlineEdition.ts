import type { BaseRecord, Tenant } from '../db/models';
import { db } from '../db/db';
import { loadFirebaseConfig } from './sync/firebaseConfig';

/**
 * EDICIÓN OFFLINE
 *
 * Variante de la app sin ninguna conexión a la nube: la base de datos se
 * descarga UNA sola vez (al abrir el enlace de licencia con conexión) y a
 * partir de ahí el dispositivo trabaja 100% local.
 *
 * El enlace solo puede ser generado por ChrizDev tras confirmar el pago
 * total de la licencia (una app offline no admite control remoto ni cuotas).
 */

const EDITION_KEY = 'presmon_edition';

export interface OfflineLicense {
  /** Clave de activación (OFF-XXXXXX), validada contra el documento del tenant. */
  key: string;
  issuedAt: string;
  issuedByName: string;
}

export function isOfflineEdition(): boolean {
  try {
    return localStorage.getItem(EDITION_KEY) === 'OFFLINE';
  } catch {
    return false;
  }
}

export function activateOfflineEdition(): void {
  try {
    localStorage.setItem(EDITION_KEY, 'OFFLINE');
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Genera una clave de licencia legible (sin caracteres ambiguos). */
export function generateLicenseKey(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const rnd = new Uint8Array(6);
  crypto.getRandomValues(rnd);
  let out = '';
  for (const b of rnd) out += alphabet[b % alphabet.length];
  return `OFF-${out}`;
}

export function offlineLinkFor(tenant: Tenant): string {
  const origin = window.location.origin;
  const key = tenant.offlineLicense?.key ?? '';
  return `${origin}/edicion-offline?t=${tenant.tenantId}&k=${key}`;
}

const SEED_COLLECTIONS = [
  ['users', 'userId'],
  ['borrowers', 'borrowerId'],
  ['loans', 'loanId'],
  ['installments', 'installmentId'],
  ['plans', 'planId'],
  ['loan_requests', 'requestId'],
  ['audit_logs', 'logId'],
] as const;

export interface SeedResult {
  ok: boolean;
  error?: string;
  counts?: Array<{ collection: string; rows: number }>;
}

/**
 * Única conexión en la vida del dispositivo: valida la licencia contra el
 * documento del tenant en Firestore y descarga TODA la base de datos de la
 * organización al almacenamiento local. Al terminar, la app ya no toca la red.
 */
export async function seedOfflineEdition(
  tenantId: string,
  key: string,
  onProgress?: (msg: string) => void,
): Promise<SeedResult> {
  const cfg = loadFirebaseConfig();
  if (!cfg) return { ok: false, error: 'Este dispositivo no tiene configuración de nube para validar la licencia.' };
  const normalizedKey = key.trim().toUpperCase();

  try {
    onProgress?.('Validando licencia…');
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc, getDoc, collection, getDocs, query, where } = await import(
      'firebase/firestore'
    );
    const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

    const tSnap = await getDoc(doc(fs, 'tenants', tenantId));
    if (!tSnap.exists()) return { ok: false, error: 'Organización no encontrada.' };
    const tenantData = tSnap.data() as unknown as Tenant;
    if (tenantData.status === 'DELETED') return { ok: false, error: 'Esta organización fue eliminada de la plataforma.' };
    if (!tenantData.offlineLicense || tenantData.offlineLicense.key !== normalizedKey) {
      return { ok: false, error: 'Licencia inválida. Verifica el enlace con ChrizDev.' };
    }

    // Tenant base
    await db.tenants.put({ ...tenantData, syncStatus: 'SYNCED' });

    const counts: Array<{ collection: string; rows: number }> = [];
    for (const [name, idKey] of SEED_COLLECTIONS) {
      onProgress?.(`Descargando ${name}…`);
      const snap = await getDocs(query(collection(fs, name), where('tenantId', '==', tenantId)));
      const table = db.table(name);
      const rows = snap.docs
        .map((d) => d.data() as (BaseRecord & Record<string, unknown>) | undefined)
        .filter((r): r is BaseRecord & Record<string, unknown> => !!r && !!r[idKey])
        .map((r) => ({ ...r, syncStatus: 'SYNCED' as const }));
      if (rows.length > 0) await table.bulkPut(rows);
      counts.push({ collection: name, rows: rows.length });
    }

    onProgress?.('Instalando base de datos local…');
    return { ok: true, counts };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && /fetch|network/i.test(err.message)
          ? 'Sin conexión. Este enlace necesita internet UNA sola vez para instalar la base de datos.'
          : err instanceof Error
            ? err.message
            : 'Error desconocido durante la instalación.',
    };
  }
}
