import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Borrower, Loan, Tenant } from '../db/models';
import {
  DOCUMENT_TYPE_LABELS,
  FREQUENCY_LABELS,
  type ScheduleLine,
} from './financialCalculations';
import { formatDateLong, formatCOP } from './format';

export const CLAUSE_MORA =
  'ADVERTENCIA DE INCUMPLIMIENTO Y MORA: En caso de mora o retardo en el pago de una o más de las cuotas en las fechas estipuladas, se causarán automáticamente intereses moratorios liquidados día a día a la tasa máxima legal permitida por la Superintendencia Financiera de Colombia. El valor del recargo se adicionará directamente a la cuota exigible, facultando al acreedor para declarar de plazo vencido la totalidad de la obligación (Cláusula Aceleratoria).';

export const CLAUSE_ACEPTACION =
  'CLÁUSULA DE ACEPTACIÓN Y PERFECCIONAMIENTO DEL NEGOCIO JURÍDICO: Las partes declaran que la entrega material del capital aquí pactado, así como la recepción conforme de las condiciones señaladas en este documento, implican el consentimiento expreso, libre y voluntario tanto del DEUDOR como del ACREEDOR, perfeccionando así el contrato de mutuo con o sin garantía en los términos de los artículos 2224 y siguientes del Código Civil colombiano. En consecuencia, ambas partes quedan jurídicamente vinculadas a cumplir las obligaciones estipuladas, renunciando el DEUDOR a cualquier reclamación posterior sobre las sumas recibidas, y otorgando a este documento plenos efectos probatorios y calidad de título ejecutivo conforme al artículo 422 del Código General del Proceso.';

export interface ContractData {
  tenant: Tenant;
  borrower: Borrower;
  loan: Loan;
  schedule: ScheduleLine[];
  generatedBy: string;
}

export function generateContractPDF(data: ContractData): Blob {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210;
  const M = 14;
  const usable = W - M * 2;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.text('PAGARÉ CON CARTA DE INSTRUCCIONES', W / 2, 16, { align: 'center' });
  doc.text('Y TABLA DE AMORTIZACIÓN', W / 2, 22, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(
    `Pagaré N° ${data.loan.loanId.slice(0, 8).toUpperCase()}    •    Ciudad y fecha de desembolso: ${data.borrower.city}, ${formatDateLong(data.loan.startDate)}`,
    W / 2,
    28,
    { align: 'center' },
  );

  let y = 36;
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(0.4);
  doc.line(M, y - 3, W - M, y - 3);

  const sectionTitle = (text: string, startY: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(text.toUpperCase(), M, startY);
    return startY + 5;
  };

  y = sectionTitle('1. Identificación de las partes', y);
  const col2 = M + usable / 2 + 4;
  doc.setFontSize(8.5);

  doc.setFont('helvetica', 'bold');
  doc.text('ACREEDOR (PRESTAMISTA):', M, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.tenant.name, M, y + 4.5);
  doc.text('NIT/Identificación: ______________', M, y + 9);
  doc.text('Dirección/Teléfono: ______________', M, y + 13.5);

  doc.setFont('helvetica', 'bold');
  doc.text('DEUDOR (PRESTATARIO):', col2, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.borrower.fullName, col2, y + 4.5);
  doc.text(
    `${DOCUMENT_TYPE_LABELS[data.borrower.documentType]} N° ${data.borrower.documentNumber}`,
    col2,
    y + 9,
  );
  doc.text(`Dirección: ${data.borrower.address}`, col2, y + 13.5);
  doc.text(`Ciudad: ${data.borrower.city}    Teléfono: ${data.borrower.phone}`, col2, y + 18);

  y += 26;

  y = sectionTitle('2. Detalles del préstamo pactado', y);
  doc.setFontSize(8.5);
  const details: Array<[string, string]> = [
    ['Capital prestado:', formatCOP(data.loan.principalAmount)],
    [
      'Tasa de interés remuneratoria:',
      `${data.loan.interestRatePercent}% por periodo (${FREQUENCY_LABELS[data.loan.frequency].toLowerCase()})`,
    ],
    [
      'Modalidad y plazo de pago:',
      `${data.loan.totalInstallments} cuotas ${FREQUENCY_LABELS[data.loan.frequency].toLowerCase()}es`,
    ],
    ['Intereses totales generados:', formatCOP(data.loan.interestAmount)],
    ['Valor total de la obligación:', formatCOP(data.loan.totalPayableAmount)],
    [
      'Recargo por mora pactado:',
      data.loan.dailyLateFeePercent > 0
        ? `${data.loan.dailyLateFeePercent}% diario sobre cuota vencida`
        : `${formatCOP(data.loan.fixedLateFeeAmount)} fijos por día vencido`,
    ],
  ];
  details.forEach(([label, value], idx) => {
    const rowY = y + idx * 5;
    doc.setFont('helvetica', 'bold');
    doc.text(label, M, rowY);
    doc.setFont('helvetica', 'normal');
    doc.text(value, M + 62, rowY);
  });
  y += details.length * 5 + 4;

  y = sectionTitle('3. Tabla de amortización', y);

  const body = data.schedule.map((l) => [
    String(l.installmentNumber),
    formatDateLong(l.dueDate),
    formatCOP(l.principalAmount),
    formatCOP(l.interestAmount),
    formatCOP(l.baseAmountDue),
  ]);

  autoTable(doc, {
    head: [['# Cuota', 'Fecha Límite de Pago', 'Abono a Capital', 'Interés Devengado', 'Valor Total Cuota']],
    body,
    foot: [
      [
        '',
        'TOTALES',
        formatCOP(data.loan.principalAmount),
        formatCOP(data.loan.interestAmount),
        formatCOP(data.loan.totalPayableAmount),
      ],
    ],
    startY: y,
    margin: { left: M, right: M },
    theme: 'grid',
    styles: { fontSize: 7.6, cellPadding: 1.4, lineColor: [203, 213, 225] },
    headStyles: { fillColor: [15, 23, 42], textColor: 255, fontSize: 7.8 },
    footStyles: { fillColor: [226, 232, 240], textColor: 15, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 14, halign: 'center' } },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  if (y > 235) {
    doc.addPage();
    y = 20;
  }

  y = sectionTitle('4. Cláusula de mora (aviso legal)', y);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(60, 60, 60);
  const clauseLines = doc.splitTextToSize(CLAUSE_MORA, usable);
  doc.text(clauseLines, M, y);
  y += clauseLines.length * 3.6 + 10;

  doc.setTextColor(15, 23, 42);
  y = sectionTitle('5. Aceptación del dinero y perfeccionamiento', y + 2);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(60, 60, 60);
  const aceptacionLines = doc.splitTextToSize(CLAUSE_ACEPTACION, usable);
  if (y + aceptacionLines.length * 3.6 > 275) {
    doc.addPage();
    y = 20;
    sectionTitle('5. Aceptación del dinero y perfeccionamiento (cont.)', y);
    y += 5;
  }
  doc.text(aceptacionLines, M, y);
  y += aceptacionLines.length * 3.6 + 8;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(
    `Emitido por PresMon by ChrizDev — Generado offline el ${new Date().toLocaleString('es-CO')} por ${data.generatedBy}.`,
    M,
    Math.min(y, 285),
  );

  return doc.output('blob');
}
