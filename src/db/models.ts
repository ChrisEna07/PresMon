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
  | 'PLAN_INSTALLMENT_ABONO'
  | 'DATA_EXPORTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_CONFLICT'
  | 'OFFLINE_WIPE_CONFIRMED'
  | 'OFFLINE_ONLINE_DETECTED'
  | 'PAYMENT_REPORT_CREATED'
  | 'PAYMENT_REPORT_APPROVED'
  | 'PAYMENT_REPORT_APPROVED_AS_ABONO'
  | 'PAYMENT_REPORT_REJECTED';

export interface BaseRecord {
  createdAt: string;
  updatedAt: string;
  syncStatus: SyncStatus;
}

export type NoticeLevel = 'info' | 'warning' | 'danger';

export interface TenantNotice {
  title?: string;
  message: string;
  level: NoticeLevel;
  updatedAt: string;
  /** Persistencia de tiempo: fecha/hora ISO límite. Si caduca, no se muestra. */
  expiresAt?: string;
  /**
   * Si es true, el usuario puede descartar temporalmente con el botón (X).
   * Si es false, queda persistente e inamovible hasta que pague o se desactive.
   */
  dismissible?: boolean;
  active?: boolean;
}

export interface BankAccountInfo {
  id: string;
  bankName: string;
  accountType: 'SAVINGS' | 'CHECKING' | 'WALLET' | 'OTHER';
  accountNumber: string;
  holderName: string;
  holderDoc?: string;
  notes?: string;
  active: boolean;
}

export type PaymentReportStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface PaymentReport extends BaseRecord {
  reportId: string;
  tenantId: string;
  amount: number;
  paymentDate: string;
  referenceNumber: string;
  bankName?: string;
  accountNumber?: string;
  /** Captura de pantalla o comprobante en base64 comprimido */
  receiptImageBase64?: string;
  notes?: string;
  status: PaymentReportStatus;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
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
  /** Orden de borrado remoto de todos los datos locales en cualquier dispositivo de la organización. */
  wipeLocalData?: boolean;
  /** Fecha/hora en que el dispositivo cliente ejecutó y confirmó la purga de datos. */
  wipeConfirmedAt?: string;
  /** Información del dispositivo que confirmó la purga de datos. */
  wipeConfirmedDevice?: string;
  /** Prohíbe la ejecución offline de la aplicación para esta organización. */
  offlineBlocked?: boolean;
  /** Desbloqueo administrativo expreso aplicado por el Super Admin (exime de bloqueo por mora > 5 días). */
  unlockedByAdmin?: boolean;
  /** Indica si el banner insistente de cobro fue desactivado expresamente por el Super Admin. */
  paymentBannerDeactivated?: boolean;
  /** Telemetría: indica si la edición offline fue detectada operando con conexión a internet. */
  offlineOnlineDetected?: boolean;
  /** Fecha/hora de la última detección de conexión en la edición offline. */
  offlineOnlineDetectedAt?: string;
  /** Datos del dispositivo/navegador detectado en línea para la app offline. */
  offlineDeviceInfo?: string;
  /** Número de WhatsApp personalizado de cobros (ej. 3183517802). */
  paymentWhatsAppPhone?: string;
  /** Cuentas bancarias para depósito directo configuradas por el Super Admin. */
  bankAccounts?: BankAccountInfo[];
  /** Si es true, el banner de cobro muestra botón (X). Si es false, es consistente hasta que pague. */
  paymentBannerDismissible?: boolean;
  /** Fecha/hora límite de persistencia para el aviso de cobro. */
  paymentBannerExpiresAt?: string;
  /** Telemetría en vivo: fecha/hora de la última actividad en línea (online y offline). */
  lastSeenOnlineAt?: string;
  /** Telemetría en vivo: información del dispositivo/navegador que registró actividad en línea. */
  lastSeenDevice?: string;
  /** Información del abono vigente con vigencia de 15 días para completar saldo. */
  activeAbono?: TenantAbonoInfo;
}

export interface TenantAbonoInfo {
  abonoId: string;
  installmentId?: string;
  concept: string;
  amountPaid: number;
  remainingAmount: number;
  totalDue: number;
  abonoDate: string;
  graceUntil: string;
  active: boolean;
  notes?: string;
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
  /** Monto acumulado abonado a esta cuota. */
  paidAmount?: number;
  /** Marca temporal ISO del último abono registrado. */
  lastAbonoAt?: string;
  /** Fecha límite de vigencia de 15 días concedida tras el abono. */
  graceUntil?: string;
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
