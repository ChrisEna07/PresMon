import { db } from '../db/db';

export interface BackupDump {
  app: 'PresMon';
  version: number;
  exportedAt: string;
  tenants: unknown[];
  users: unknown[];
  borrowers: unknown[];
  loans: unknown[];
  installments: unknown[];
  audit_logs: unknown[];
}

const BACKUP_TABLES = [
  'tenants',
  'users',
  'borrowers',
  'loans',
  'installments',
  'audit_logs',
] as const;

export async function buildBackupDump(): Promise<BackupDump> {
  return {
    app: 'PresMon',
    version: 2,
    exportedAt: new Date().toISOString(),
    tenants: await db.tenants.toArray(),
    users: await db.users.toArray(),
    borrowers: await db.borrowers.toArray(),
    loans: await db.loans.toArray(),
    installments: await db.installments.toArray(),
    audit_logs: await db.audit_logs.toArray(),
  };
}

export function downloadBackup(dump: BackupDump): void {
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `presmon-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportBackup(): Promise<void> {
  downloadBackup(await buildBackupDump());
}

export async function importBackup(file: File): Promise<number> {
  const text = await file.text();
  const dump = JSON.parse(text) as Record<string, unknown>;
  if (dump.app !== 'PresMon') throw new Error('Formato de respaldo no reconocido.');
  let count = 0;
  for (const name of BACKUP_TABLES) {
    const rows = dump[name];
    if (!Array.isArray(rows)) continue;
    const stamped = rows.map((r) => ({ ...(r as object), syncStatus: 'PENDING' }));
    await db.table(name).bulkPut(stamped as never);
    count += rows.length;
  }
  return count;
}
