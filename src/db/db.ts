import Dexie, { type Table } from 'dexie';
import type {
  AuditLog,
  Borrower,
  Installment,
  Loan,
  LoanRequest,
  PdfBlob,
  ServicePlan,
  Tenant,
  UserAccount,
} from './models';
import { uid } from '../lib/id';
import { sha256Hex } from '../lib/crypto';
import {
  computeSchedule,
  addPeriod,
  round2,
} from '../lib/financialCalculations';
import { todayStr } from '../lib/format';
import { loadFirebaseConfig } from '../lib/sync/firebaseConfig';

class PresmonDB extends Dexie {
  tenants!: Table<Tenant, string>;
  users!: Table<UserAccount, string>;
  borrowers!: Table<Borrower, string>;
  loans!: Table<Loan, string>;
  installments!: Table<Installment, string>;
  audit_logs!: Table<AuditLog, string>;
  pdf_blobs!: Table<PdfBlob, string>;
  plans!: Table<ServicePlan, string>;
  loan_requests!: Table<LoanRequest, string>;

  constructor() {
    super('presmon-db');
    this.version(1).stores({
      tenants:
        'tenantId, status, syncStatus, createdAt',
      users:
        'userId, tenantId, username, role, syncStatus',
      borrowers:
        'borrowerId, tenantId, documentNumber, fullName, syncStatus, [tenantId+documentNumber]',
      loans:
        'loanId, tenantId, borrowerId, status, startDate, syncStatus, [tenantId+status], [tenantId+borrowerId]',
      installments:
        'installmentId, loanId, tenantId, dueDate, status, syncStatus, [tenantId+dueDate], [loanId+installmentNumber]',
      audit_logs:
        'logId, tenantId, timestamp, action, entityId, syncStatus, [tenantId+timestamp]',
      pdf_blobs: 'blobId, loanId, tenantId',
    });
    this.version(2).stores({
      plans: 'planId, tenantId, syncStatus',
    });
    this.version(3).stores({
      loan_requests:
        'requestId, tenantId, status, documentNumber, createdAt, syncStatus, [tenantId+status], [tenantId+documentNumber]',
    });
  }
}

export const db = new PresmonDB();

export function nowISO(): string {
  return new Date().toISOString();
}

const TENANT_TABLES = [
  'users',
  'borrowers',
  'loans',
  'installments',
  'pdf_blobs',
  'audit_logs',
  'plans',
  'loan_requests',
] as const;

const TENANT_KEY_OF: Record<(typeof TENANT_TABLES)[number], string> = {
  users: 'userId',
  borrowers: 'borrowerId',
  loans: 'loanId',
  installments: 'installmentId',
  pdf_blobs: 'blobId',
  audit_logs: 'logId',
  plans: 'planId',
  loan_requests: 'requestId',
};

export async function deleteTenantCascade(tenantId: string): Promise<{
  removed: Record<string, number>;
  ids: Record<string, string[]>;
}> {
  const ids: Record<string, string[]> = {};
  for (const name of TENANT_TABLES) {
    const rows = await db.table(name).where('tenantId').equals(tenantId).toArray();
    const key = TENANT_KEY_OF[name];
    ids[name] = rows.map((r) => String((r as Record<string, unknown>)[key]));
  }
  await db.transaction(
    'rw',
    [
      db.tenants,
      db.users,
      db.borrowers,
      db.loans,
      db.installments,
      db.pdf_blobs,
      db.audit_logs,
      db.plans,
      db.loan_requests,
    ],
    async () => {
      await db.tenants.delete(tenantId);
      await purgeLocalTenantData(tenantId);
    },
  );
  const removed: Record<string, number> = {};
  for (const name of TENANT_TABLES) {
    removed[name] = ids[name].length;
  }
  return { removed, ids };
}

/**
 * Borra ÚNICAMENTE los datos operativos de UNA organización (todas las
 * consultas filtran por tenantId). La fila del tenant NO se toca.
 */
export async function purgeLocalTenantData(tenantId: string): Promise<void> {
  for (const name of TENANT_TABLES) {
    await db.table(name).where('tenantId').equals(tenantId).delete();
  }
}

/**
 * Purga TOTAL de datos locales de la organización en este dispositivo:
 * elimina todas las tablas operativas (usuarios, prestatarios, préstamos,
 * cuotas, auditoría, planes, solicitudes) y limpia estados de sesión y
 * edición offline si corresponden a esta organización.
 */
export async function wipeLocalTenantData(tenantId: string): Promise<void> {
  await purgeLocalTenantData(tenantId);
  try {
    localStorage.removeItem(`presmon_last_sync_${tenantId}`);
    const rawSession = localStorage.getItem('presmon_session_v1');
    if (rawSession) {
      const parsed = JSON.parse(rawSession) as { tenantId?: string };
      if (parsed.tenantId === tenantId) {
        localStorage.removeItem('presmon_session_v1');
        localStorage.removeItem('presmon_edition');
      }
    }
  } catch {
    /* localStorage restringido */
  }
}

export function stamp<T extends { updatedAt: string; syncStatus: string }>(obj: T): T {
  obj.updatedAt = nowISO();
  obj.syncStatus = 'PENDING';
  return obj;
}

export async function saveTenant(t: Tenant): Promise<string> {
  await db.tenants.put(stamp(t));
  return t.tenantId;
}

export async function saveUser(u: UserAccount): Promise<string> {
  await db.users.put(stamp(u));
  return u.userId;
}

export async function saveBorrower(b: Borrower): Promise<string> {
  await db.borrowers.put(stamp(b));
  return b.borrowerId;
}

export async function saveLoan(l: Loan): Promise<string> {
  await db.loans.put(stamp(l));
  return l.loanId;
}

export async function saveInstallments(list: Installment[]): Promise<void> {
  await db.installments.bulkPut(list.map((i) => stamp(i)));
}

export async function savePdfBlob(blob: PdfBlob): Promise<void> {
  await db.pdf_blobs.put(blob);
}

export async function getPdfBlobByLoan(loanId: string): Promise<PdfBlob | undefined> {
  return db.pdf_blobs.where('loanId').equals(loanId).first();
}

function baseFields() {
  const now = nowISO();
  return { createdAt: now, updatedAt: now, syncStatus: 'PENDING' as const };
}

const SEED_FLAG = 'presmon_seeded_v1';

export async function seedDatabase(): Promise<void> {
  if (loadFirebaseConfig()) {
    localStorage.setItem(SEED_FLAG, 'done');
    return;
  }
  if (localStorage.getItem(SEED_FLAG) === 'done') return;
  if ((await db.tenants.count()) > 0 || (await db.users.count()) > 0) {
    localStorage.setItem(SEED_FLAG, 'done');
    return;
  }

  const now = nowISO();
  const superUserId = uid();
  const tenantId = uid();
  const adminUserId = uid();

  const superUser: UserAccount = {
    userId: superUserId,
    tenantId: '',
    username: 'chrizdev',
    passHash: await sha256Hex('ChrizDev2026*'),
    displayName: 'ChrizDev',
    role: 'SUPER_ADMIN',
    active: true,
    ...baseFields(),
    syncStatus: 'PENDING' as const,
  };

  const adminUser: UserAccount = {
    userId: adminUserId,
    tenantId,
    username: 'admin',
    passHash: await sha256Hex('admin123'),
    displayName: 'Administrador Demo',
    role: 'TENANT_ADMIN',
    active: true,
    ...baseFields(),
  };

  const tenant: Tenant = {
    tenantId,
    name: 'Créditos Ya S.A.S. (Demo)',
    adminUid: adminUserId,
    status: 'ACTIVE',
    clientPortalEnabled: false,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'PENDING',
  };

  const borrowers: Borrower[] = [
    {
      borrowerId: uid(),
      tenantId,
      fullName: 'Juan Pérez Gómez',
      documentType: 'CC',
      documentNumber: '1020304050',
      phone: '3101234567',
      address: 'Calle 45 # 12-30',
      city: 'Bogotá',
      creditScore: 88,
      riskBadge: 'A',
      totalLoansCount: 1,
      defaultCount: 0,
      notes: 'Cliente antiguo, excelente pago.',
      ...baseFields(),
    },
    {
      borrowerId: uid(),
      tenantId,
      fullName: 'María Fernanda Ruiz',
      documentType: 'CC',
      documentNumber: '1090887654',
      phone: '3209876543',
      address: 'Carrera 70 # 5-21',
      city: 'Medellín',
      creditScore: 64,
      riskBadge: 'B',
      totalLoansCount: 1,
      defaultCount: 0,
      notes: '',
      ...baseFields(),
    },
    {
      borrowerId: uid(),
      tenantId,
      fullName: 'Carlos Andrés Torres',
      documentType: 'CE',
      documentNumber: '4556778',
      phone: '3005554433',
      address: 'Av. Siempre Viva # 7-42',
      city: 'Cali',
      creditScore: 38,
      riskBadge: 'D',
      totalLoansCount: 0,
      defaultCount: 1,
      notes: 'Historial de mora en otro fondo.',
      ...baseFields(),
    },
  ];

  const today = todayStr();
  const startLoan1 = addPeriod(today, 'WEEKLY', -4);
  const schedule1 = computeSchedule({
    principalAmount: 2000000,
    interestRatePercent: 5,
    frequency: 'WEEKLY',
    totalInstallments: 16,
    startDate: startLoan1,
    dailyLateFeePercent: 0.5,
    fixedLateFeeAmount: 0,
  });
  const loan1TotalInterest = round2(2000000 * 0.05 * 16);
  const loan1TotalPayable = round2(2000000 + loan1TotalInterest);
  const loan1: Loan = {
    loanId: uid(),
    tenantId,
    borrowerId: borrowers[0].borrowerId,
    principalAmount: 2000000,
    interestRatePercent: 5,
    frequency: 'WEEKLY',
    totalInstallments: 16,
    interestAmount: loan1TotalInterest,
    totalPayableAmount: loan1TotalPayable,
    balanceRemaining: loan1TotalPayable,
    dailyLateFeePercent: 0.5,
    fixedLateFeeAmount: 0,
    status: 'ACTIVE',
    startDate: startLoan1,
    contractPdfBlobRef: null,
    ...baseFields(),
  };

  const installments1: Installment[] = schedule1.map((line) => ({
    installmentId: uid(),
    loanId: loan1.loanId,
    tenantId,
    installmentNumber: line.installmentNumber,
    dueDate: line.dueDate,
    principalAmount: line.principalAmount,
    interestAmount: line.interestAmount,
    baseAmountDue: line.baseAmountDue,
    daysOverdue: 0,
    lateFeeCharged: 0,
    totalAmountWithLateFee: line.baseAmountDue,
    amountPaid: 0,
    status: 'PENDING',
    paidAt: null,
    ...baseFields(),
  }));
  for (let i = 0; i < 3; i++) {
    installments1[i].amountPaid = installments1[i].baseAmountDue;
    installments1[i].status = 'PAID';
    installments1[i].paidAt = installments1[i].dueDate;
  }
  installments1[3].amountPaid = round2(installments1[3].baseAmountDue * 0.4);
  installments1[3].status = 'PARTIAL';

  const startLoan2 = addPeriod(today, 'MONTHLY', -1);
  const schedule2 = computeSchedule({
    principalAmount: 800000,
    interestRatePercent: 6,
    frequency: 'MONTHLY',
    totalInstallments: 6,
    startDate: startLoan2,
    dailyLateFeePercent: 0,
    fixedLateFeeAmount: 5000,
  });
  const loan2TotalInterest = round2(800000 * 0.06 * 6);
  const loan2TotalPayable = round2(800000 + loan2TotalInterest);
  const loan2: Loan = {
    loanId: uid(),
    tenantId,
    borrowerId: borrowers[1].borrowerId,
    principalAmount: 800000,
    interestRatePercent: 6,
    frequency: 'MONTHLY',
    totalInstallments: 6,
    interestAmount: loan2TotalInterest,
    totalPayableAmount: loan2TotalPayable,
    balanceRemaining: round2(loan2TotalPayable - schedule2[0].baseAmountDue),
    dailyLateFeePercent: 0,
    fixedLateFeeAmount: 5000,
    status: 'ACTIVE',
    startDate: startLoan2,
    contractPdfBlobRef: null,
    ...baseFields(),
  };
  const installments2: Installment[] = schedule2.map((line) => ({
    installmentId: uid(),
    loanId: loan2.loanId,
    tenantId,
    installmentNumber: line.installmentNumber,
    dueDate: line.dueDate,
    principalAmount: line.principalAmount,
    interestAmount: line.interestAmount,
    baseAmountDue: line.baseAmountDue,
    daysOverdue: 0,
    lateFeeCharged: 0,
    totalAmountWithLateFee: line.baseAmountDue,
    amountPaid: 0,
    status: 'PENDING',
    paidAt: null,
    ...baseFields(),
  }));
  installments2[0].amountPaid = installments2[0].baseAmountDue;
  installments2[0].status = 'PAID';
  installments2[0].paidAt = installments2[0].dueDate;

  const logs: AuditLog[] = [
    {
      logId: uid(),
      tenantId,
      timestamp: now,
      action: 'LOAN_CREATED',
      actorId: adminUserId,
      actorName: 'Administrador Demo',
      entityId: loan1.loanId,
      entityType: 'loans',
      payloadSnapshot: JSON.stringify({ monto: 2000000, cuotas: 16, frecuencia: 'Semanal' }),
      ...baseFields(),
    },
    {
      logId: uid(),
      tenantId,
      timestamp: now,
      action: 'LOAN_CREATED',
      actorId: adminUserId,
      actorName: 'Administrador Demo',
      entityId: loan2.loanId,
      entityType: 'loans',
      payloadSnapshot: JSON.stringify({ monto: 800000, cuotas: 6, frecuencia: 'Mensual' }),
      ...baseFields(),
    },
  ];

  await db.transaction(
    'rw',
    [db.tenants, db.users, db.borrowers, db.loans, db.installments, db.audit_logs],
    async () => {
      await db.tenants.put(tenant);
      await db.users.bulkPut([superUser, adminUser]);
      await db.borrowers.bulkPut(borrowers);
      await db.loans.bulkPut([loan1, loan2]);
      await db.installments.bulkPut([...installments1, ...installments2]);
      await db.audit_logs.bulkPut(logs);
    },
  );

  localStorage.setItem(SEED_FLAG, 'done');
}
