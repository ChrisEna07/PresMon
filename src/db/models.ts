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
  | 'LOAN_REQUEST_CREATED'
  | 'LOAN_REQUEST_APPROVED'
  | 'LOAN_REQUEST_REJECTED'
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

export interface OfflineLicenseInfo {
  /** Clave de activación (OFF-XXXXXX). */
  key: string;
  issuedAt: string;
  issuedByName: string;
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
  /** @deprecated Legado del modo híbrido: ya no afecta la sincronización (siempre activa). */
  cloudSyncEnabled?: boolean;
  /** Bloqueo total de la app hasta que pague (canal de control). */
  appLocked?: boolean;
  /** Aviso inyectado por ChrizDev que se muestra en su panel. */
  notice?: TenantNotice;
  /**
   * Licencia de la EDICIÓN OFFLINE (pago único confirmado por ChrizDev).
   * Sin licencia no existe enlace de instalación offline.
   */
  offlineLicense?: OfflineLicenseInfo;
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

/** Modo de pago de la licencia de la app. */
export type AppPaymentMode = 'FULL' | 'INSTALLMENTS';

export interface ServicePlan extends BaseRecord {
  planId: string;
  tenantId: string;
  name: string;
  cloudServiceIncluded: boolean;
  /** Cómo paga el cliente la app: de contado o financiada por cuotas. */
  appPaymentMode?: AppPaymentMode;
  /** Valor total acordado de la app (modo contado). */
  appTotalAmount?: number;
  /** Mensualidad recurrente de servicios cloud, independiente del pago de la app (0 = sin cobro). */
  cloudMonthlyFee?: number;
  /** Día del mes (1-28) en que vence la mensualidad cloud. */
  cloudBillingDay?: number;
  /** Fecha (YYYY-MM-DD) hasta la cual está pagada la mensualidad cloud. */
  cloudPaidThrough?: string;
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
  /** Solicitud de origen con la foto de la garantía (si nació del portal). */
  guaranteeRequestId?: string;
  /** Momento en que el admin confirmó la entrega física de la garantía. */
  guaranteeReceivedAt?: string | null;
  /** Referencia de consulta heredada de la solicitud del portal. */
  referenceCode?: string;
}

export type LoanRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** Solicitud de crédito enviada por un cliente desde el portal público. */
export interface LoanRequest extends BaseRecord {
  requestId: string;
  tenantId: string;
  borrowerId: string | null;
  fullName: string;
  documentType: DocumentType;
  documentNumber: string;
  phone: string;
  address: string;
  note: string;
  amountRequested: number;
  /** Momento exacto en que el cliente aceptó términos y cláusulas. */
  termsAcceptedAt: string;
  /** Versión del texto de términos aceptado (trazabilidad legal). */
  termsVersion: string;
  clientIp?: string;
  /** Descripción del bien dejado en garantía. */
  guaranteeDescription?: string;
  /** Soporte visual comprimido (JPEG base64): foto del cliente con su garantía. */
  supportDataUrl?: string;
  supportFileName?: string;
  /** Código corto de consulta (ej. PM-8F3K2A) para que el cliente verifique su estado sin documento. */
  referenceCode?: string;
  status: LoanRequestStatus;
  decidedByUid?: string;
  decidedByName?: string;
  decidedAt?: string;
  rejectReason?: string;
  createdLoanId?: string;
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
