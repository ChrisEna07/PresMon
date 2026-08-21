import type { AuditAction, AuditLog } from '../db/models';
import { db } from '../db/db';
import { uid } from './id';

export async function logAudit(entry: {
  tenantId: string;
  action: AuditAction;
  actorId: string;
  actorName: string;
  entityId?: string;
  entityType?: string;
  payloadSnapshot?: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  const log: AuditLog = {
    logId: uid(),
    tenantId: entry.tenantId,
    timestamp: now,
    action: entry.action,
    actorId: entry.actorId,
    actorName: entry.actorName,
    entityId: entry.entityId ?? '',
    entityType: entry.entityType ?? '',
    payloadSnapshot:
      entry.payloadSnapshot === undefined ? '' : JSON.stringify(entry.payloadSnapshot),
    createdAt: now,
    updatedAt: now,
    syncStatus: 'PENDING',
  };
  await db.audit_logs.put(log);
}

export const ACTION_LABELS: Record<AuditAction, string> = {
  LOAN_CREATED: 'Préstamo creado',
  PAYMENT_APPLIED: 'Pago aplicado',
  LATE_FEE_TRIGGERED: 'Recargo de mora causado',
  RATE_CUSTOMIZED: 'Tasa personalizada',
  PDF_GENERATED: 'Pagaré generado',
  AUTH_LOGIN: 'Inicio de sesión',
  AUTH_PASSWORD_CHANGED: 'Contraseña actualizada',
  BORROWER_CREATED: 'Prestatario creado',
  BORROWER_UPDATED: 'Prestatario actualizado',
  BORROWER_DELETED: 'Prestatario eliminado',
  LOAN_CANCELLED: 'Préstamo cancelado',
  TENANT_CREATED: 'Organización creada',
  TENANT_UPDATED: 'Organización actualizada',
  TENANT_DELETED: 'Organización eliminada',
  DATA_EXPORTED: 'Respaldo exportado',
  SYNC_COMPLETED: 'Sincronización completada',
  SYNC_CONFLICT: 'Conflicto resuelto por sincronización',
};

export const AUDIT_FILTERS: Array<{ key: string; label: string; actions: AuditAction[] }> = [
  { key: 'all', label: 'Todos', actions: [] },
  { key: 'payments', label: 'Pagos', actions: ['PAYMENT_APPLIED'] },
  {
    key: 'loans',
    label: 'Préstamos',
    actions: ['LOAN_CREATED', 'LOAN_CANCELLED', 'RATE_CUSTOMIZED'],
  },
  { key: 'mora', label: 'Recargos de Mora', actions: ['LATE_FEE_TRIGGERED'] },
  { key: 'pdf', label: 'Documentos', actions: ['PDF_GENERATED'] },
];
