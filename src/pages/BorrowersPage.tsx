import { useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Pencil, Search, Trash2, UserPlus, Users } from 'lucide-react';
import type { Borrower, DocumentType, Loan } from '../db/models';
import { db, saveBorrower } from '../db/db';
import { useAuth } from '../store/auth';
import { DOCUMENT_TYPE_LABELS, riskBadgeFromScore } from '../lib/financialCalculations';
import { logAudit } from '../lib/auditLogger';
import { uid } from '../lib/id';
import { PageHeader, EmptyState } from '../components/misc';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Select, Textarea } from '../components/ui/input';
import { TBody, TD, TH, THead, TR, TableWrap } from '../components/ui/table';
import { useToast } from '../components/ui/toast';

const RISK_VARIANT = { A: 'success', B: 'info', C: 'warning', D: 'danger' } as const;

interface FormState {
  fullName: string;
  documentType: DocumentType;
  documentNumber: string;
  phone: string;
  address: string;
  city: string;
  notes: string;
}

const DEFAULT_CREDIT_SCORE = 70;

const emptyForm: FormState = {
  fullName: '',
  documentType: 'CC',
  documentNumber: '',
  phone: '',
  address: '',
  city: '',
  notes: '',
};

export default function BorrowersPage() {
  const { session } = useAuth();
  const { toast } = useToast();
  const tenantId = session?.tenantId ?? '';
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const borrowers = useLiveQuery(
    () =>
      tenantId
        ? db.borrowers.where('tenantId').equals(tenantId).toArray()
        : Promise.resolve([] as Borrower[]),
    [tenantId],
  );
  const loans = useLiveQuery(
    () => (tenantId ? db.loans.where('tenantId').equals(tenantId).toArray() : Promise.resolve([] as Loan[])),
    [tenantId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (borrowers ?? [])
      .filter(
        (b) =>
          !q ||
          b.fullName.toLowerCase().includes(q) ||
          b.documentNumber.toLowerCase().includes(q) ||
          b.phone.includes(q),
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [borrowers, query]);

  const loanCountByBorrower = useMemo(() => {
    const map = new Map<string, number>();
    (loans ?? []).forEach((l) => {
      if (l.status === 'ACTIVE' || l.status === 'IN_DEFAULT')
        map.set(l.borrowerId, (map.get(l.borrowerId) ?? 0) + 1);
    });
    return map;
  }, [loans]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(b: Borrower) {
    setEditingId(b.borrowerId);
    setForm({
      fullName: b.fullName,
      documentType: b.documentType,
      documentNumber: b.documentNumber,
      phone: b.phone,
      address: b.address,
      city: b.city,
      notes: b.notes,
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    if (!form.fullName.trim() || !form.documentNumber.trim()) {
      toast('Nombre y número de documento son obligatorios.', 'error');
      return;
    }
    const duplicate = (borrowers ?? []).find(
      (b) =>
        b.documentNumber === form.documentNumber.trim() &&
        b.documentType === form.documentType &&
        b.borrowerId !== editingId,
    );
    if (duplicate) {
      toast('Ya existe un prestatario con ese documento.', 'error');
      return;
    }
    const now = new Date().toISOString();
    if (editingId) {
      const existing = await db.borrowers.get(editingId);
      if (!existing) return;
      await saveBorrower({
        ...existing,
        ...form,
        riskBadge: riskBadgeFromScore(existing.creditScore),
      });
      await logAudit({
        tenantId,
        action: 'BORROWER_UPDATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: editingId,
        entityType: 'borrowers',
        payloadSnapshot: { fullName: form.fullName },
      });
      toast('Prestatario actualizado.', 'success');
    } else {
      const id = uid();
      await saveBorrower({
        borrowerId: id,
        tenantId,
        ...form,
        creditScore: DEFAULT_CREDIT_SCORE,
        riskBadge: riskBadgeFromScore(DEFAULT_CREDIT_SCORE),
        totalLoansCount: 0,
        defaultCount: 0,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'PENDING',
      });
      await logAudit({
        tenantId,
        action: 'BORROWER_CREATED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: id,
        entityType: 'borrowers',
        payloadSnapshot: { fullName: form.fullName, score: DEFAULT_CREDIT_SCORE },
      });
      toast('Prestatario creado.', 'success');
    }
    setDialogOpen(false);
  }

  async function handleDelete(b: Borrower) {
    if ((loanCountByBorrower.get(b.borrowerId) ?? 0) > 0) {
      toast('No se puede eliminar: tiene préstamos activos.', 'error');
      return;
    }
    if (!window.confirm(`¿Eliminar a ${b.fullName}? Esta acción no se puede deshacer.`)) return;
    await db.borrowers.delete(b.borrowerId);
    if (session) {
      await logAudit({
        tenantId,
        action: 'BORROWER_DELETED',
        actorId: session.userId,
        actorName: session.displayName,
        entityId: b.borrowerId,
        entityType: 'borrowers',
        payloadSnapshot: { fullName: b.fullName },
      });
    }
    toast('Prestatario eliminado.', 'success');
  }

  return (
    <div>
      <PageHeader
        title="Prestatarios"
        description={`${filtered.length} cliente(s) registrado(s)`}
        actions={
          <>
            <div className="relative">
              <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar nombre, cédula o teléfono…"
                className="w-64 pl-8"
              />
            </div>
            <Button size="sm" onClick={openCreate}>
              <UserPlus size={14} /> Nuevo
            </Button>
          </>
        }
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin prestatarios"
          description="Registra tu primer cliente para poder crear préstamos."
          action={
            <Button size="sm" onClick={openCreate}>
              <UserPlus size={14} /> Registrar prestatario
            </Button>
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Cliente</TH>
            <TH>Documento</TH>
            <TH>Contacto</TH>
            <TH>Ciudad</TH>
            <TH>Score</TH>
            <TH>Préstamos activos</TH>
            <TH className="text-right">Acciones</TH>
          </THead>
          <TBody>
            {filtered.map((b) => (
              <TR key={b.borrowerId}>
                <TD>
                  <p className="font-medium text-slate-800">{b.fullName}</p>
                  {b.notes && <p className="max-w-48 truncate text-[11px] text-slate-400">{b.notes}</p>}
                </TD>
                <TD className="text-slate-600">
                  {b.documentType} {b.documentNumber}
                </TD>
                <TD className="text-slate-600">{b.phone}</TD>
                <TD className="text-slate-600">{b.city}</TD>
                <TD>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-700">{b.creditScore}</span>
                    <Badge variant={RISK_VARIANT[b.riskBadge]}>{b.riskBadge}</Badge>
                  </div>
                </TD>
                <TD>
                  {(loanCountByBorrower.get(b.borrowerId) ?? 0) > 0 ? (
                    <Badge variant="info">{loanCountByBorrower.get(b.borrowerId)}</Badge>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(b)} title="Editar">
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleDelete(b)}
                      title="Eliminar"
                      className="text-red-500 hover:bg-red-50"
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </TableWrap>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingId ? 'Editar prestatario' : 'Nuevo prestatario'}
        description="Los datos quedan guardados en este dispositivo y se sincronizan cuando haya conexión."
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Nombre completo *</Label>
            <Input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              placeholder="Ej: Juan Pérez Gómez"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo de documento</Label>
              <Select
                value={form.documentType}
                onChange={(e) => setForm({ ...form, documentType: e.target.value as DocumentType })}
              >
                {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Número de documento *</Label>
              <Input
                value={form.documentNumber}
                onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Teléfono</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="3001234567"
              />
            </div>
            <div>
              <Label>Ciudad</Label>
              <Input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="Bogotá"
              />
            </div>
          </div>
          <div>
            <Label>Dirección</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </div>
          <div>
            <Label>Notas internas</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Observaciones sobre el cliente…"
            />
          </div>
          <p className="text-[11px] text-slate-400">
            El score crediticio se calcula automáticamente según el comportamiento de pago del
            cliente (sube al pagar a tiempo, baja con la mora).
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">{editingId ? 'Guardar cambios' : 'Crear prestatario'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
