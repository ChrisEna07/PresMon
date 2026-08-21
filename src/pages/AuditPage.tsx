import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  FileDown,
  FileSpreadsheet,
  HandCoins,
  Lock,
  ScrollText,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { AuditLog } from '../db/models';
import { db } from '../db/db';
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

export default function AuditPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const tenantId = session?.tenantId ?? '';
  const [filter, setFilter] = useState('all');
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');

  const logs = useLiveQuery(
    async () => {
      if (!tenantId) return [] as AuditLog[];
      const rows = await db.audit_logs.where('tenantId').equals(tenantId).toArray();
      return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 300);
    },
    [tenantId],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: (logs ?? []).length };
    for (const f of AUDIT_FILTERS) {
      if (f.key !== 'all')
        c[f.key] = (logs ?? []).filter((l) => f.actions.includes(l.action)).length;
    }
    return c;
  }, [logs]);

  const filtered = useMemo(() => {
    const f = AUDIT_FILTERS.find((x) => x.key === filter);
    if (!f || f.key === 'all') return logs ?? [];
    return (logs ?? []).filter((l) => f.actions.includes(l.action));
  }, [logs, filter]);

  function describePayload(log: AuditLog): string {
    try {
      const parsed = JSON.parse(log.payloadSnapshot) as Record<string, unknown>;
      if (log.action === 'PAYMENT_APPLIED' && 'montoAplicado' in parsed)
        return `${formatCOP(Number(parsed.montoAplicado))} aplicados · saldo ${formatCOP(Number(parsed.saldoRestante ?? 0))}`;
      if (log.action === 'LOAN_CREATED' && 'monto' in parsed)
        return `Préstamo de ${formatCOP(Number(parsed.monto))} a ${parsed.cuotas} cuotas`;
      if (log.action === 'LATE_FEE_TRIGGERED' && 'recargoAcumulado' in parsed)
        return `Recargo acumulado ${formatCOP(Number(parsed.recargoAcumulado))} · ${parsed.cuotasVencidas} cuota(s) vencida(s)`;
      return Object.entries(parsed)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
        .join(' · ');
    } catch {
      return log.payloadSnapshot;
    }
  }

  function exportCSV() {
    const header = ['fecha', 'accion', 'actor', 'entidad', 'detalle'];
    const lines = filtered.map((l) => [
      l.timestamp,
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
        description="Registro inmutable de actividades · guardado local"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <FileSpreadsheet size={14} /> CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEncryptOpen(true)}>
              <Lock size={14} /> Exportar cifrado
            </Button>
          </>
        }
      />

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
                  <p className="mt-0.5 text-xs text-slate-500">
                    {log.actorName}
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
