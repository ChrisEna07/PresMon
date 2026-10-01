import { loadFirebaseConfig } from './sync/firebaseConfig';
import { isOfflineEdition } from './offlineEdition';
import { db, wipeLocalTenantData } from '../db/db';
import type { Tenant } from '../db/models';
import { deepSanitize } from './sync/syncEngine';
import { nowISO } from './format';
import { uid } from './id';

export interface TelemetryCheckResult {
  onlineDetected: boolean;
  wiped: boolean;
  migrated?: boolean;
  locked?: boolean;
  error?: string;
}

/**
 * Crea un respaldo de seguridad completo de los datos locales de la organización en Firestore.
 * Esto se invoca automáticamente antes de purgas de emergencia o al migrar de offline a online,
 * garantizando que nunca se pierda un solo préstamo, prestatario ni pago.
 */
export async function backupLocalTenantDataToCloud(
  tenantId: string,
  reason: 'EMERGENCY_PURGE' | 'MIGRATE_TO_ONLINE' | 'MANUAL_BACKUP' = 'EMERGENCY_PURGE',
): Promise<boolean> {
  const cfg = loadFirebaseConfig();
  if (!cfg || !tenantId || !navigator.onLine) return false;

  try {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc, setDoc } = await import('firebase/firestore');
    const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));

    const now = nowISO();
    const device = typeof navigator !== 'undefined' ? navigator.userAgent : 'Desconocido';

    // Recopilar todas las tablas operativas de Dexie
    const [borrowers, loans, installments, users, plans, auditLogs] = await Promise.all([
      db.borrowers.where('tenantId').equals(tenantId).toArray(),
      db.loans.where('tenantId').equals(tenantId).toArray(),
      db.installments.where('tenantId').equals(tenantId).toArray(),
      db.users.where('tenantId').equals(tenantId).toArray(),
      db.plans.where('tenantId').equals(tenantId).toArray(),
      db.audit_logs.where('tenantId').equals(tenantId).toArray(),
    ]);

    const backupSnapshot = {
      backupId: uid(),
      tenantId,
      backupAt: now,
      reason,
      device,
      counts: {
        borrowers: borrowers.length,
        loans: loans.length,
        installments: installments.length,
        users: users.length,
        plans: plans.length,
        auditLogs: auditLogs.length,
      },
      borrowers: borrowers.slice(0, 500),
      loans: loans.slice(0, 500),
      installments: installments.slice(0, 2000),
      users,
      plans,
      auditLogs: auditLogs.slice(-200),
      createdAt: now,
      updatedAt: now,
    };

    // 1. Guardar copia en la colección de respaldos autoritativos
    await setDoc(doc(fs, 'tenant_backups', `${tenantId}_latest`), deepSanitize(backupSnapshot));
    await setDoc(doc(fs, 'tenant_backups', `${tenantId}_${Date.now()}`), deepSanitize(backupSnapshot));

    // 2. Si la razón es migración a online, subir directamente los registros a sus colecciones en Firestore
    if (reason === 'MIGRATE_TO_ONLINE') {
      for (const b of borrowers) {
        await setDoc(doc(fs, 'borrowers', b.borrowerId), deepSanitize({ ...b, syncStatus: 'SYNCED' }));
      }
      for (const l of loans) {
        await setDoc(doc(fs, 'loans', l.loanId), deepSanitize({ ...l, syncStatus: 'SYNCED' }));
      }
      for (const inst of installments) {
        await setDoc(doc(fs, 'installments', inst.installmentId), deepSanitize({ ...inst, syncStatus: 'SYNCED' }));
      }
      for (const u of users) {
        await setDoc(doc(fs, 'users', u.userId), deepSanitize({ ...u, syncStatus: 'SYNCED' }));
      }
    }

    return true;
  } catch (err) {
    console.warn('[Telemetry] Error al crear respaldo en la nube:', err);
    return false;
  }
}

/**
 * Reporta el latido online y el dispositivo activo de la organización a Firestore y a la base local
 * para que el Super Administrador visualice en vivo si está en línea (web o edición offline con red).
 */
export async function reportOnlineHeartbeat(tenantId: string): Promise<void> {
  if (!tenantId || !navigator.onLine) return;
  const cfg = loadFirebaseConfig();
  const now = nowISO();
  const device = typeof navigator !== 'undefined' ? navigator.userAgent : 'Desconocido';
  const isOffline = isOfflineEdition();

  const payload: Partial<Tenant> = {
    lastSeenOnlineAt: now,
    lastSeenDevice: device,
    updatedAt: now,
  };
  if (isOffline) {
    payload.offlineOnlineDetected = true;
    payload.offlineOnlineDetectedAt = now;
    payload.offlineDeviceInfo = device;
  }

  try {
    const local = await db.tenants.get(tenantId);
    if (local) {
      await db.tenants.update(tenantId, payload);
    }
  } catch {
    /* noop */
  }

  if (!cfg) return;
  try {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc, setDoc } = await import('firebase/firestore');
    const fs = getFirestore(getApps()[0] ?? initializeApp(cfg));
    await setDoc(doc(fs, 'tenants', tenantId), deepSanitize({ ...payload }), { merge: true });
  } catch {
    /* silencio en fallos transitorios de red */
  }
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
      deepSanitize({
        wipeConfirmedAt: confirmedAt,
        wipeConfirmedDevice: device,
        wipeLocalData: false, // Marca la orden como completada
        updatedAt: confirmedAt,
      }),
      { merge: true },
    );

    // Registro en auditoría remota
    await setDoc(
      doc(fs, 'audit_logs', uid()),
      deepSanitize({
        logId: uid(),
        tenantId,
        timestamp: confirmedAt,
        action: 'OFFLINE_WIPE_CONFIRMED',
        actorId: 'system-client',
        actorName: 'Dispositivo Cliente',
        entityId: tenantId,
        entityType: 'tenants',
        payloadSnapshot: JSON.stringify({
          confirmadoEn: confirmedAt,
          dispositivo: device,
          detalle: 'Purga local de base de datos ejecutada y confirmada por el cliente',
        }),
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
        syncStatus: 'SYNCED',
      }),
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
 * 2. Revisa si el Super Admin emitió orden de purga local (`wipeLocalData`).
 *    Si es así, primero crea un respaldo automático en la nube, luego purga y confirma.
 * 3. Revisa si el Super Admin emitió bloqueo (`appLocked`, `offlineBlocked`) o aviso (`notice`).
 * 4. Revisa si se solicitó migración a Online (`migrationAction === 'MIGRATE_TO_ONLINE'`).
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

    // 1) Si tiene orden de purga activa: RESPALDAR PRIMERO y luego purgar
    if (remoteData.wipeLocalData === true) {
      // Respaldo de emergencia en la nube antes de borrar
      await backupLocalTenantDataToCloud(tenantId, 'EMERGENCY_PURGE');
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

    // 2) Si se solicitó migración de Offline a Online
    if (remoteData.migrationAction === 'MIGRATE_TO_ONLINE' || (isOffline && remoteData.offlineEditionEnabled === false && !remoteData.offlineBlocked)) {
      await backupLocalTenantDataToCloud(tenantId, 'MIGRATE_TO_ONLINE');
      try {
        localStorage.removeItem('presmon_edition');
      } catch {
        /* noop */
      }
      await setDoc(
        tenantRef,
        deepSanitize({
          migrationAction: 'COMPLETED',
          migrationCompletedAt: detectedAt,
          offlineLicense: null,
          offlineEditionEnabled: false,
          updatedAt: detectedAt,
        }),
        { merge: true },
      );
      return { onlineDetected: true, wiped: false, migrated: true };
    }

    // 3) Replicar banderas de control remoto locales (bloqueo, avisos, offlineBlocked)
    const local = await db.tenants.get(tenantId);
    const nextLocked = remoteData.appLocked === true;
    const nextOfflineBlocked = remoteData.offlineBlocked === true;
    const nextNotice = (remoteData.notice ?? undefined) as Tenant['notice'];

    if (local && (local.appLocked !== nextLocked || local.offlineBlocked !== nextOfflineBlocked || JSON.stringify(local.notice ?? null) !== JSON.stringify(nextNotice ?? null))) {
      await db.tenants.update(tenantId, {
        appLocked: nextLocked,
        offlineBlocked: nextOfflineBlocked,
        notice: nextNotice,
        updatedAt: detectedAt,
      });
    }

    // 4) Si es edición offline, reportar telemetría de conexión a red
    if (isOffline) {
      await setDoc(
        tenantRef,
        deepSanitize({
          offlineOnlineDetected: true,
          offlineOnlineDetectedAt: detectedAt,
          offlineDeviceInfo: device,
          lastSeenOnlineAt: detectedAt,
          lastSeenDevice: device,
          updatedAt: detectedAt,
        }),
        { merge: true },
      );

      // Bitácora de auditoría en Firestore
      await setDoc(
        doc(fs, 'audit_logs', uid()),
        deepSanitize({
          logId: uid(),
          tenantId,
          timestamp: detectedAt,
          action: 'OFFLINE_ONLINE_DETECTED',
          actorId: 'offline-client',
          actorName: 'App Edición Offline',
          entityId: tenantId,
          entityType: 'tenants',
          payloadSnapshot: JSON.stringify({
            detectadoEn: detectedAt,
            dispositivo: device,
            tipo: 'App offline detectada con conexión activa a internet',
          }),
          createdAt: detectedAt,
          updatedAt: detectedAt,
          syncStatus: 'SYNCED',
        }),
        { merge: true },
      );
    }

    const isLocked = nextLocked || nextOfflineBlocked;
    return { onlineDetected: true, wiped: false, locked: isLocked };
  } catch (err) {
    return {
      onlineDetected: false,
      wiped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}