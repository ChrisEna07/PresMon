import { useMemo, useState, type ReactNode } from 'react';
import type { Frequency } from '../db/models';
import {
  FREQUENCY_LABELS,
  computeSchedule,
  summarize,
  type LoanInput,
} from '../lib/financialCalculations';
import { formatDateShort, formatCOP } from '../lib/format';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input, Label, Select } from './ui/input';

export function SimulatorForm({
  value,
  onChange,
}: {
  value: LoanInput;
  onChange: (v: LoanInput) => void;
}) {
  const set = (patch: Partial<LoanInput>) => onChange({ ...value, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <Label>Monto a prestar (COP)</Label>
        <Input
          type="number"
          min={0}
          step={50000}
          value={value.principalAmount || ''}
          onChange={(e) => set({ principalAmount: Number(e.target.value) })}
          placeholder="Ej: 2000000"
        />
      </div>
      <div>
        <Label>Tasa de interés (%) por periodo</Label>
        <Input
          type="number"
          min={0}
          max={100}
          step={0.1}
          value={value.interestRatePercent || ''}
          onChange={(e) => set({ interestRatePercent: Number(e.target.value) })}
          placeholder="Ej: 5"
        />
      </div>
      <div>
        <Label>Frecuencia de pago</Label>
        <Select
          value={value.frequency}
          onChange={(e) => set({ frequency: e.target.value as Frequency })}
        >
          {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
            <option key={f} value={f}>
              {FREQUENCY_LABELS[f]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Número de cuotas</Label>
        <Input
          type="number"
          min={1}
          max={360}
          value={value.totalInstallments || ''}
          onChange={(e) => set({ totalInstallments: Math.max(1, Number(e.target.value)) })}
          placeholder="Ej: 16"
        />
      </div>
      <div>
        <Label>Fecha de desembolso</Label>
        <Input
          type="date"
          value={value.startDate}
          onChange={(e) => set({ startDate: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Mora diaria (%)</Label>
          <Input
            type="number"
            min={0}
            step={0.1}
            value={value.dailyLateFeePercent || ''}
            onChange={(e) => set({ dailyLateFeePercent: Number(e.target.value) })}
            placeholder="0.5"
          />
        </div>
        <div>
          <Label>Recargo fijo/día</Label>
          <Input
            type="number"
            min={0}
            step={500}
            value={value.fixedLateFeeAmount || ''}
            onChange={(e) => set({ fixedLateFeeAmount: Number(e.target.value) })}
            placeholder="0"
          />
        </div>
      </div>
    </div>
  );
}

export function LivePreview({
  input,
  avgInstallment,
  totalInterest,
  totalPayable,
  profitMarginPct,
}: {
  input: LoanInput;
  avgInstallment: number;
  totalInterest: number;
  totalPayable: number;
  profitMarginPct: number;
}) {
  const items = [
    { label: 'Valor por cuota', value: formatCOP(avgInstallment), strong: true },
    { label: 'Interés total generado', value: formatCOP(totalInterest) },
    { label: 'Total a recolectar', value: formatCOP(totalPayable), highlight: true },
    { label: 'Ganancia neta', value: `${formatCOP(totalInterest)} (${profitMarginPct}% del capital)` },
  ];
  return (
    <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 to-white">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between text-sm">
          Vista previa en vivo
          <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white uppercase">
            $0 latencia
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-slate-500">{item.label}</span>
            <span
              className={
                item.highlight
                  ? 'text-base font-extrabold text-emerald-700'
                  : item.strong
                    ? 'font-bold text-slate-800'
                    : 'font-semibold text-slate-700'
              }
            >
              {item.value}
            </span>
          </div>
        ))}
        <p className="border-t border-emerald-100 pt-2 text-[11px] text-slate-400">
          {input.totalInstallments} cuotas {FREQUENCY_LABELS[input.frequency].toLowerCase()}es ·
          mora {input.dailyLateFeePercent}% diario
          {input.fixedLateFeeAmount > 0 ? ` + ${formatCOP(input.fixedLateFeeAmount)}/día` : ''} ·
          primer vencimiento {formatDateShort(input.startDate)}
        </p>
      </CardContent>
    </Card>
  );
}

export function AmortizationTable({ lines }: { lines: ReturnType<typeof computeSchedule> }) {
  if (!lines.length) return null;
  return (
    <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-max text-xs">
        <thead className="sticky top-0 z-10 bg-slate-900 text-white">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">#</th>
            <th className="px-3 py-2 text-left font-semibold">Fecha límite</th>
            <th className="px-3 py-2 text-right font-semibold">Abono a capital</th>
            <th className="px-3 py-2 text-right font-semibold">Interés</th>
            <th className="px-3 py-2 text-right font-semibold">Valor cuota</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((l) => (
            <tr key={l.installmentNumber} className="hover:bg-slate-50">
              <td className="px-3 py-1.5 font-medium text-slate-500">{l.installmentNumber}</td>
              <td className="px-3 py-1.5 text-slate-700">{formatDateShort(l.dueDate)}</td>
              <td className="px-3 py-1.5 text-right text-slate-600">{formatCOP(l.principalAmount)}</td>
              <td className="px-3 py-1.5 text-right text-slate-600">{formatCOP(l.interestAmount)}</td>
              <td className="px-3 py-1.5 text-right font-semibold text-slate-800">
                {formatCOP(l.baseAmountDue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LoanSimulator({
  action,
}: {
  action?: ReactNode;
}) {
  const [input, setInput] = useState<LoanInput>({
    principalAmount: 2000000,
    interestRatePercent: 5,
    frequency: 'WEEKLY',
    totalInstallments: 16,
    startDate: new Date().toISOString().slice(0, 10),
    dailyLateFeePercent: 0.5,
    fixedLateFeeAmount: 0,
  });

  const lines = useMemo(() => computeSchedule(input), [input]);
  const summary = useMemo(
    () => summarize(input.principalAmount, lines),
    [input.principalAmount, lines],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Personaliza el préstamo</CardTitle>
        </CardHeader>
        <CardContent>
          <SimulatorForm value={input} onChange={setInput} />
          {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
        </CardContent>
      </Card>
      <div className="space-y-4 lg:col-span-2">
        <LivePreview
          input={input}
          avgInstallment={summary.avgInstallment}
          totalInterest={summary.totalInterest}
          totalPayable={summary.totalPayable}
          profitMarginPct={summary.profitMarginPct}
        />
        <AmortizationTable lines={lines} />
      </div>
    </div>
  );
}
