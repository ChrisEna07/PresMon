export type SyncStatus = 'SYNCED' | 'PENDING' | 'CONFLICT';
export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN';
export type DocumentType = 'CC' | 'CE' | 'TI' | 'NIT' | 'PAS';
export type RiskBadge = 'A' | 'B' | 'C' | 'D';
export type Frequency = 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
export type LoanStatus = 'ACTIVE' | 'PAID' | 'IN_DEFAULT' | 'CANCELLED';
export type InstallmentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
export type AuditAction =
  | 'LOAN_CREATED'
  | 'PAYMENT_APPLIED'
  | 'LATE_FEE_TRIGGERED'
  | 'RATE_CUSTOMIZED'
  | 'PDF_GENERATED'
  | 'AUTH_LOGIN'
  | 'AUTH_PASSWORD_CHANGED'
  | 'BORROWER_CREATED'
  | 'BORROWER_UPDATED'
  | 'BORROWER_DELETED'
  | 'LOAN_CANCELLED'
  | 'TENANT_CREATED'
  | 'TENANT_UPDATED'
  | 'TENANT_DELETED'
  | 'PLAN_UPDATED'
  | 'DATA_EXPORTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_CONFLICT';

export interface BaseRecord {
  createdAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export type NoticeLevel = 'info' | 'warning' | 'danger';

export interface TenantNotice {
  message: string;
  level: NoticeLevel;
  updatedAt: string;
}

export interface Tenant extends BaseRecord {
  tenantId: string;
  name: string;
  adminUid: string;
  status: TenantStatus;
  clientPortalEnabled: boolean;
  /**
   * Canal de CONTROL DE CUENTA (antifraude): banner de pago, bloqueo
   * remoto por impago y avisos inyectados. Activo por defecto.
   */
  remoteControlEnabled?: boolean;
  /** Respaldo en la nube y sincronización multi-dispositivo. Activo por defecto. */
  cloudSyncEnabled?: boolean;
  /** Bloqueo total de la app hasta que pague (canal de control). */
  appLocked?: boolean;
  /** Aviso inyectado por ChrizDev que se muestra en su panel. */
  notice?: TenantNotice;
}

export interface UserAccount extends BaseRecord {
  userId: string;
  tenantId: string;
  username: string;
  passHash: string;
  displayName: string;
  role: UserRole;
  active: boolean;
}

export type PlanInstallmentStatus = 'PENDING' | 'PAID';

export interface PlanInstallment {
  installmentId: string;
  dueDate: string;
  amount: number;
  concept: string;
  status: PlanInstallmentStatus;
  paidAt?: string;
}

export interface ServicePlan extends BaseRecord {
  planId: string;
  tenantId: string;
  name: string;
  cloudServiceIncluded: boolean;
  notes?: string;
  installments: PlanInstallment[];
}

export interface Borrower extends BaseRecord {
  borrowerId: string;
  tenantId: string;
  fullName: string;
  documentType: DocumentType;
  documentNumber: string;
  phone: string;
  address: string;
  city: string;
  creditScore: number;
  riskBadge: RiskBadge;
  totalLoansCount: number;
  defaultCount: number;
  notes: string;
}

export interface Loan extends BaseRecord {
  loanId: string;
  tenantId: string;
  borrowerId: string;
  principalAmount: number;
  interestRatePercent: number;
  frequency: Frequency;
  totalInstallments: number;
  interestAmount: number;
  totalPayableAmount: number;
  balanceRemaining: number;
  dailyLateFeePercent: number;
  fixedLateFeeAmount: number;
  status: LoanStatus;
  startDate: string;
  contractPdfBlobRef: string | null;
}

export interface Installment extends BaseRecord {
  installmentId: string;
  loanId: string;
  tenantId: string;
  installmentNumber: number;
  dueDate: string;
  principalAmount: number;
  interestAmount: number;
  baseAmountDue: number;
  daysOverdue: number;
  lateFeeCharged: number;
  totalAmountWithLateFee: number;
  amountPaid: number;
  status: InstallmentStatus;
  paidAt: string | null;
}

export interface AuditLog extends BaseRecord {
  logId: string;
  tenantId: string;
  timestamp: string;
  action: AuditAction;
  actorId: string;
  actorName: string;
  entityId: string;
  entityType: string;
  payloadSnapshot: string;
}

export interface PdfBlob {
  blobId: string;
  loanId: string;
  tenantId: string;
  data: Blob;
  createdAt: string;
}
