import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Building2,
  FileDown,
  FileSpreadsheet,
  HandCoins,
  Loader2,
  Lock,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { AuditLog, Tenant } from '../db/models';
import { db } from '../db/db';
import { isSyncConfigured, runSync } from '../lib/sync/syncEngine';
import { useAuth } from '../store/auth';
import { ACTION_LABELS, AUDIT_FILTERS } from '../lib/auditLogger';
import { decryptString, downloadBlob, encryptString } from '../lib/crypto';
import { formatCOP, formatDateTime } from '../lib/format';
import { PageHeader, EmptyState } from '../components/misc';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { Tabs } from '../components/ui/tabs';
import { useToast } from '../components/ui/toast';

const ACTION_ICONS: Record<string, typeof ScrollText> = {
  LOAN_CREATED: HandCoins,
  PAYMENT_APPLIED: HandCoins,
  LATE_FEE_TRIGGERED: AlertTriangle,
  RATE_CUSTOMIZED: ScrollText,
  PDF_GENERATED: FileDown,
  AUTH_LOGIN: UserRound,
};

const PLATFORM_KEY = '__platform__';

export default function AuditPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const isSuper = session?.role === 'SUPER_ADMIN';
  const tenantScope = isSuper ? null : (session?.tenantId ?? '');
  const [filter, setFilter] = useState('all');
  const [orgFilter, setOrgFilter] = useState('all');
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [syncing, setSyncing] = useState(false);

  async function refreshFromCloud() {
    setSyncing(true);
    try {
      const r = await runSync();
      if (r.errors.length > 0) {
        toast(`Sincronización con errores: ${r.errors[0]}`, 'error');
      } else if (r.pulled === 0) {
        toast('Auditoría al día: no hay registros nuevos en la nube.', 'info');
      } else {
        toast(`${r.pulled} registro(s) nuevo(s) descargado(s) de las organizaciones.`, 'success');
      }
    } catch {
      toast('No se pudo conectar con la nube.', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const tenantsList = useLiveQuery(async () => db.tenants.toArray() as Promise<Tenant[]>, []);
  const tenantNameById = useMemo(() => {
    const map = new Map<string, string>();
    (tenantsList ?? []).forEach((t) => map.set(t.tenantId, t.name));
    return map;
  }, [tenantsList]);

  const logs = useLiveQuery(
    async () => {
      if (!session) return [] as AuditLog[];
      if (tenantScope !== null && tenantScope !== '') {
        const rows = await db.audit_logs.where('tenantId').equals(tenantScope).toArray();
        return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 300);
      }
      if (isSuper) {
        const rows = await db.audit_logs.toArray();
        return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 600);
      }
      return [] as AuditLog[];
    },
    [session?.userId, session?.tenantId],
  );

  const baseRows = useMemo(() => {
    const rows = logs ?? [];
    if (!isSuper || orgFilter === 'all') return rows;
    if (orgFilter === PLATFORM_KEY) return rows.filter((l) => !l.tenantId);
    return rows.filter((l) => l.tenantId === orgFilter);
  }, [logs, isSuper, orgFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: baseRows.length };
    for (const f of AUDIT_FILTERS) {
      if (f.key !== 'all') c[f.key] = baseRows.filter((l) => f.actions.includes(l.action)).length;
    }
    return c;
  }, [baseRows]);

  const filtered = useMemo(() => {
    const f = AUDIT_FILTERS.find((x) => x.key === filter);
    if (!f || f.key === 'all') return baseRows;
    return baseRows.filter((l) => f.actions.includes(l.action));
  }, [baseRows, filter]);

  function describePayload(log: AuditLog): string {
    try {
      const parsed = JSON.parse(log.payloadSnapshot) as Record<string, unknown>;
      if (log.action === 'PAYMENT_APPLIED' && 'montoAplicado' in parsed)
        return `${formatCOP(Number(parsed.montoAplicado))} aplicados · saldo ${formatCOP(Number(parsed.saldoRestante ?? 0))}`;
      if (log.action === 'LOAN_CREATED' && 'monto' in parsed)
        return `Préstamo de ${formatCOP(Number(parsed.monto))} a ${parsed.cuotas} cuotas`;
      if (log.action === 'LATE_FEE_TRIGGERED' && 'recargoAcumulado' in parsed)
        return `Recargo acumulado ${formatCOP(Number(parsed.recargoAcumulado))} · ${parsed.cuotasVencidas} cuota(s) vencida(s)`;
      if (log.action === 'SYNC_CONFLICT' && 'versionLocalPerdida' in parsed)
        return 'Conflicto resuelto: ganó la versión del servidor (LWW)';
      if ((log.action === 'TENANT_CREATED' || log.action === 'TENANT_DELETED') && 'nombre' in parsed)
        return `Organización «${String(parsed.nombre)}»`;
      return Object.entries(parsed)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
        .join(' · ');
    } catch {
      return log.payloadSnapshot;
    }
  }

  function exportCSV() {
    const header = ['fecha', 'organizacion', 'accion', 'actor', 'entidad', 'detalle'];
    const lines = filtered.map((l) => [
      l.timestamp,
      `"${(tenantNameById.get(l.tenantId) ?? 'Plataforma').replace(/"/g, "'")}"`,
      l.action,
      l.actorName,
      l.entityId.slice(0, 12),
      `"${describePayload(l).replace(/"/g, "'")}"`,
    ]);
    const csv = [header.join(','), ...lines.map((r) => r.join(','))].join('\n');
    downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), `presmon-auditoria-${Date.now()}.csv`);
    toast('Auditoría exportada a CSV.', 'success');
  }

  async function exportEncrypted() {
    if (!passphrase) {
      toast('Escribe una contraseña de cifrado.', 'error');
      return;
    }
    try {
      const payload = JSON.stringify(filtered, null, 2);
      const encrypted = await encryptString(payload, passphrase);
      downloadBlob(
        new Blob([encrypted], { type: 'application/json' }),
        `presmon-auditoria-${Date.now()}.pmaudit.json`,
      );
      setEncryptOpen(false);
      setPassphrase('');
      toast('Respaldo cifrado descargado (AES-256-GCM).', 'success');
    } catch {
      toast('No se pudo cifrar el respaldo.', 'error');
    }
  }

  return (
    <div>
      <PageHeader
        title="Auditoría"
        description={
          isSuper
            ? 'Registro global: todas las organizaciones y la plataforma'
            : 'Registro inmutable de las actividades de tu organización'
        }
        actions={
          <>
            {isSuper && isSyncConfigured() && (
              <Button variant="outline" size="sm" onClick={() => void refreshFromCloud()} disabled={syncing}>
                {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Actualizar desde la nube
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <FileSpreadsheet size={14} /> CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEncryptOpen(true)}>
              <Lock size={14} /> Exportar cifrado
            </Button>
          </>
        }
      />

      {isSuper && (
        <div className="mb-4 flex items-center gap-2">
          <Building2 size={15} className="text-slate-400" />
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="h-9 w-full max-w-xs cursor-pointer rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none focus:border-emerald-500"
          >
            <option value="all">Todas las organizaciones y plataforma</option>
            <option value={PLATFORM_KEY}>Plataforma (acciones de Super Admin)</option>
            {(tenantsList ?? []).map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.name}
              </option>
            ))}
          </select>
          {orgFilter !== 'all' && (
            <span className="text-[11px] text-slate-400">
              {baseRows.length} registro(s) en este ámbito
            </span>
          )}
        </div>
      )}

      <Tabs
        className="mb-4"
        value={filter}
        onChange={setFilter}
        items={AUDIT_FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] ?? 0 }))}
      />

      {filtered.length === 0 ? (
        <EmptyState icon={ScrollText} title="Sin registros" description="Las acciones aparecerán aquí automáticamente." />
      ) : (
        <div className="relative space-y-2 before:absolute before:top-2 before:bottom-2 before:left-[19px] before:w-px before:bg-slate-200">
          {filtered.map((log) => {
            const Icon = ACTION_ICONS[log.action] ?? ShieldCheck;
            const isMora = log.action === 'LATE_FEE_TRIGGERED';
            return (
              <div key={log.logId} className="relative flex gap-3">
                <span
                  className={`z-10 mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${
                    isMora ? 'border-red-200 bg-red-50 text-red-500' : 'border-slate-200 bg-white text-slate-500'
                  }`}
                >
                  <Icon size={16} />
                </span>
                <div className="flex-1 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <p className="text-sm font-semibold text-slate-800">{ACTION_LABELS[log.action]}</p>
                    <span className="text-[11px] text-slate-400">{formatDateTime(log.timestamp)}</span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    {log.actorName}
                    {isSuper && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                        {tenantNameById.get(log.tenantId) ?? 'Plataforma'}
                      </span>
                    )}
                    {log.entityId && ` · ref ${log.entityId.slice(0, 8)}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{describePayload(log)}</p>
                  {log.payloadSnapshot && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[11px] font-medium text-emerald-700">
                        Ver datos completos
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-slate-50 p-2 text-[10px] whitespace-pre-wrap text-slate-500">
                        {JSON.stringify(JSON.parse(log.payloadSnapshot), null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={encryptOpen}
        onClose={() => setEncryptOpen(false)}
        title="Exportar auditoría cifrada"
        description="Se cifra con AES-256-GCM derivado de tu contraseña (PBKDF2). Sin la contraseña es imposible leerlo."
      >
        <div className="space-y-3">
          <div>
            <Label>Contraseña de cifrado</Label>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Mínimo recomendado: 8 caracteres"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEncryptOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void exportEncrypted()}>
              <Lock size={14} /> Cifrar y descargar
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
