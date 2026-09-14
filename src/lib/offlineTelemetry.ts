import { loadFirebaseConfig } from './sync/firebaseConfig';
import { isOfflineEdition } from './offlineEdition';
import { wipeLocalTenantData } from '../db/db';
import { nowISO } from './format';
import { uid } from './id';

export interface TelemetryCheckResult {
  onlineDetected: boolean;
  wiped: boolean;
  error?: string;
}

/**
 * Notifica a Firestore que una purga local fue ejecutada con éxito en este dispositivo,
 * proporcionando feedback autoritativo al panel del Super Administrador.
 */
export async function reportPurgeConfirmation(tenantId: string): Promise<boolean> {
  const cfg = loadFirebaseConfig();
  if (!cfg || !tenantId || !navigator.onLine) return false;
  try {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc, setDoc } = await import('firebase/firestore');
    const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

    const confirmedAt = nowISO();
    const device = typeof navigator !== 'undefined' ? navigator.userAgent : 'Desconocido';

    await setDoc(
      doc(fs, 'tenants', tenantId),
      {
        wipeConfirmedAt: confirmedAt,
        wipeConfirmedDevice: device,
        wipeLocalData: false, // Marca la orden como completada
        updatedAt: confirmedAt,
      },
      { merge: true },
    );

    // Registro en auditoría remota
    await setDoc(
      doc(fs, 'audit_logs', uid()),
      {
        logId: uid(),
        tenantId,
        action: 'OFFLINE_WIPE_CONFIRMED',
        actorId: 'system-client',
        actorName: 'Dispositivo Cliente',
        entityId: tenantId,
        entityType: 'tenants',
        payloadSnapshot: {
          confirmadoEn: confirmedAt,
          dispositivo: device,
          detalle: 'Purga local de base de datos ejecutada y confirmada por el cliente',
        },
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
        syncStatus: 'SYNCED',
      },
      { merge: true },
    );

    return true;
  } catch (err) {
    console.warn('[Telemetry] Error reportando confirmación de purga:', err);
    return false;
  }
}

/**
 * TELEMETRÍA Y AUDITORÍA DE EDICIÓN OFFLINE:
 * Si una aplicación instalada en modo offline cuenta con conexión a internet:
 * 1. Envía un latido (heartbeat) a Firestore para que el Super Admin identifique
 *    que la app está operando en un entorno con acceso a red.
 * 2. Registra un evento de auditoría en la nube.
 * 3. Revisa si el Super Admin ha emitido una orden de borrado local (`wipeLocalData`).
 *    Si es así, ejecuta la purga total de inmediato y notifica la confirmación.
 */
export async function checkOfflineTelemetry(tenantId: string): Promise<TelemetryCheckResult> {
  if (!tenantId || !navigator.onLine) {
    return { onlineDetected: false, wiped: false };
  }

  const isOffline = isOfflineEdition();
  const cfg = loadFirebaseConfig();
  if (!cfg) return { onlineDetected: false, wiped: false };

  try {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc, getDoc, setDoc } = await import('firebase/firestore');
    const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

    const tenantRef = doc(fs, 'tenants', tenantId);
    const snap = await getDoc(tenantRef);
    if (!snap.exists()) {
      return { onlineDetected: false, wiped: false };
    }

    const remoteData = snap.data() as Record<string, unknown>;
    const detectedAt = nowISO();
    const device = typeof navigator !== 'undefined' ? navigator.userAgent : 'Desconocido';

    // 1) Si tiene orden de purga activa: reportar y ejecutarla de inmediato
    if (remoteData.wipeLocalData === true) {
      await reportPurgeConfirmation(tenantId);
      await wipeLocalTenantData(tenantId);
      try {
        localStorage.removeItem('presmon_edition');
        localStorage.removeItem('presmon_session_v1');
      } catch {
        /* noop */
      }
      return { onlineDetected: true, wiped: true };
    }

    // 2) Si es edición offline, reportar telemetría de conexión a red
    if (isOffline) {
      await setDoc(
        tenantRef,
        {
          offlineOnlineDetected: true,
          offlineOnlineDetectedAt: detectedAt,
          offlineDeviceInfo: device,
          updatedAt: detectedAt,
        },
        { merge: true },
      );

      // Bitácora de auditoría en Firestore
      await setDoc(
        doc(fs, 'audit_logs', uid()),
        {
          logId: uid(),
          tenantId,
          action: 'OFFLINE_ONLINE_DETECTED',
          actorId: 'offline-client',
          actorName: 'App Edición Offline',
          entityId: tenantId,
          entityType: 'tenants',
          payloadSnapshot: {
            detectadoEn: detectedAt,
            dispositivo: device,
            tipo: 'App offline detectada con conexión activa a internet',
          },
          createdAt: detectedAt,
          updatedAt: detectedAt,
          syncStatus: 'SYNCED',
        },
        { merge: true },
      );
    }

    return { onlineDetected: true, wiped: false };
  } catch (err) {
    return {
      onlineDetected: false,
      wiped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}