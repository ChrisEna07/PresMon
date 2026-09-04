<div align="center">

# 💼 PresMon
### Sistema Multi-inquilino de Gestión Crediticia, Control de Cartera y Cobranza Offline-First PWA

![Version](https://img.shields.io/badge/version-1.2.0-blue.svg?style=flat-square)
![React](https://img.shields.io/badge/React-19.1-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-v4.1-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7.0-646CFF?style=flat-square&logo=vite&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-11.9-FFCA28?style=flat-square&logo=firebase&logoColor=black)
![Dexie.js](https://img.shields.io/badge/Dexie.js-IndexedDB-orange.svg?style=flat-square)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-success.svg?style=flat-square)

**PresMon** es una solución integral y moderna concebida para cooperativas de crédito, casas de préstamos, entidades microfinancieras y prestamistas independientes. Diseñada bajo una estricta filosofía **Offline-First**, garantiza que los asesores y administradores puedan operar en campo o en oficina sin interrupciones, sincronizando automáticamente con la nube cuando existe conectividad.

[Características](#-características-principales) • [Arquitectura](#-arquitectura-y-diseño) • [Stack Tecnológico](#-stack-tecnológico) • [Estructura](#-estructura-del-proyecto) • [Instalación](#-instalación-y-despliegue) • [Seguridad](#-seguridad-y-reglas-firestore) • [Créditos](#-créditos-y-contacto)

---

</div>

## 🚀 Características Principales

### 1. 🏢 Arquitectura Multi-Organización (Multi-Tenant)
* **Aislamiento Total de Datos**: Cada organización opera con su propio espacio lógico y almacenamiento local, impidiendo fugas de información entre inquilinos.
* **Control Centralizado de Tenants**: El Super Administrador puede crear, suspender, desbloquear, auditar y purgar organizaciones desde un panel de control global.

### 2. 📊 Gestión Completa de Cartera y Préstamos
* **Modalidades y Frecuencias Flexibles**: Soporte para cobros diarios, semanales, quincenales y mensuales.
* **Simulador Financiero Integrado**: Cálculo en tiempo real de capital, interés simple o cuotas fijas, proyección de recargos y márgenes netos de rentabilidad.
* **Recargos Automáticos por Mora**: Motor de cálculo de mora acumulada por día con tasa porcentual diaria o recargo fijo por día de retraso.
* **Score Crediticio Dinámico**: Clasificación algorítmica de prestatarios en categorías **A, B, C y D** evaluando su historial y puntualidad de pago.

### 3. 📄 Generación Local de Contratos y Pagarés en PDF
* **Emisión Inmediata en el Dispositivo**: Genera pagarés legalmente estructurados con tabla de amortización, cláusulas de aceleración y espacios de firma mediante `jsPDF` y `jspdf-autotable`.
* **Zero Latencia**: No requiere conexión con servidores externos ni servicios de renderizado de terceros.

### 4. 🌐 Portal de Clientes (Autoconsulta y Solicitudes)
* **Acceso Seguro sin Contraseñas**: Los clientes ingresan mediante su número de documento de identidad y los últimos 4 dígitos de su teléfono celular registrado.
* **Enlace Exclusivo por Organización (`/portal?t=tenantId`)**: Vista de saldo restante, próxima cuota a vencer, estado de préstamos activos y formulario digital para radicar nuevas solicitudes de crédito.

### 5. 🛡️ Medidas Antifraude, Cobranza y Control Remoto (Super Admin)
* **Facturación Mensual Consolidada**: Switch interactivo para incluir servicios de nube en la factura mensual; el algoritmo suma las cuotas pendientes de la aplicación con la mensualidad cloud y refleja el total exigible en banners dinámicos.
* **Suspensión Automática por Mora (> 5 Días)**: Si una organización acumula más de 5 días de retraso en sus obligaciones de suscripción, el sistema despliega una pantalla central de bloqueo que impide operaciones hasta registrar el pago o ser desbloqueada por el Super Admin.
* **Purga Remota de Datos Locales (`wipeLocalTenantData`)**: Función que borra de inmediato préstamos, cuotas, clientes, usuarios y credenciales en cualquier equipo de la organización que abra la app.
* **Revocación de Operación Offline**: Capacidad de invalidar la ejecución desconectada de organizaciones que incumplan pagos de licenciamiento.
* **Módulo de Configuraciones Protegido**: Vista de ajustes restringida con difuminado visual y enlace directo a soporte técnico para evitar alteraciones operativas no autorizadas.
* **Edición Offline Licenciada**: Generación y emisión de claves de activación (`OFF-XXXXXX`) para clientes que operan 100% desconectados mediante pago único.

### 6. 📜 Auditoría Inmutable
* Registro cronológico y criptográfico de cada operación crítica (creación de préstamos, pagos aplicados, cambios de contraseña, accesos, modificaciones de planes y exportaciones).
* Reglas en Firebase que protegen la inmutabilidad de la bitácora (`allow update: if false`).

---

## 🏗️ Arquitectura y Diseño

PresMon utiliza un flujo bidireccional asíncrono con base de datos local y reconciliación hacia la nube:

```
┌─────────────────────────────────────────────────────────────┐
│                       NAVEGADOR / PWA                       │
│                                                             │
│   ┌─────────────────────┐       ┌───────────────────────┐   │
│   │   Interfaz de UI    │       │    Motor de Reglas    │   │
│   │ (React 19 + Tailwind)│ <───> │  (Mora, Score, Fact.) │   │
│   └──────────┬──────────┘       └───────────┬───────────┘   │
│              │                              │               │
│              ▼                              ▼               │
│   ┌─────────────────────────────────────────────────────┐   │
│   │            IndexedDB Local (Dexie.js)               │   │
│   │    (100% de operaciones funcionales sin internet)   │   │
│   └──────────────────────────┬──────────────────────────┘   │
└──────────────────────────────┼──────────────────────────────┘
                               │
               Sincronización Híbrida LWW
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    GOOGLE FIREBASE CLOUD                    │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │            Cloud Firestore Database                 │   │
│   │      (Reglas de seguridad y segregación tenant)     │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

* **Offline-First**: La interfaz consulta y almacena en IndexedDB local a través de `Dexie.js`.
* **Last-Write-Wins (LWW) con Reconciliación**: Al detectar conexión, el motor de sincronización (`syncEngine.ts`) intercambia novedades pendientes (`PENDING`), resuelve conflictos y valida autorizaciones en segundo plano.
* **Tumbas Lógicas**: Las organizaciones eliminadas se marcan con estado `DELETED`, garantizando que ningún dispositivo desconectado resucite datos obsoletos al reconectarse.

---

## 🛠️ Stack Tecnológico

| Componente | Tecnología | Propósito |
| :--- | :--- | :--- |
| **Frontend Framework** | React 19.1 | Interfaz declarativa, reactiva y componentes funcionales |
| **Lenguaje** | TypeScript 5.8 | Tipado estático robusto y validación en compilación |
| **Estilos y Diseño** | Tailwind CSS v4.1 | Sistema de diseño moderno, adaptable y ligero |
| **Bundler & Dev Server** | Vite 7.0 | Compilación ultrarrápida y Hot Module Replacement (HMR) |
| **Base de Datos Local** | Dexie.js 4.0 (IndexedDB) | Persistencia cliente de alto rendimiento y consultas reactivas |
| **Base de Datos Remota** | Firebase Firestore 11.9 | Replicación en la nube, respaldo y soporte multi-dispositivo |
| **Enrutamiento** | React Router DOM 7.6 | Navegación SPA fluida y guardias de sesión por roles |
| **Generación de PDFs** | jsPDF + jsPDF-autotable | Generación cliente de pagarés y contratos financieros |
| **Iconografía** | Lucide React | Iconos vectoriales coherentes y limpios |
| **PWA** | Vite Plugin PWA | Service Worker, instalación en escritorio/móvil y manifiesto |

---

## 📁 Estructura del Proyecto

```
PresMon/
├── firestore.rules          # Reglas de seguridad declarativas de Firebase Firestore
├── index.html               # Punto de entrada HTML5 y metadatos de la PWA
├── package.json             # Dependencias, scripts y metadatos del proyecto
├── tsconfig.json            # Configuración de TypeScript (ES2022, bundler mode)
├── vite.config.ts           # Configuración de Vite, Tailwind CSS y plugins PWA
├── .env.example             # Plantilla de variables de entorno para Firebase
│
└── src/
    ├── main.tsx             # Inicialización de React y montaje en DOM
    ├── App.tsx              # Definición de rutas, contextos y proveedores
    │
    ├── components/          # Componentes reutilizables de UI
    │   ├── Layout.tsx       # Barra lateral, cabecera de sync, banner de facturación y bloqueo
    │   ├── LoanSimulator.tsx# Simulador interactivo de préstamos y recargos
    │   ├── misc.tsx         # Tarjetas de estadísticas, encabezados y utilidades
    │   └── ui/              # Componentes atómicos (Badge, Button, Card, Dialog, Input, etc.)
    │
    ├── db/                  # Capa de datos local (IndexedDB)
    │   ├── db.ts            # Inicialización de Dexie, esquemas, transacciones y purgas
    │   └── models.ts        # Interfaces y tipos del dominio (Tenant, Loan, Installment, etc.)
    │
    ├── lib/                 # Lógica de negocio y motores financieros
    │   ├── auditLogger.ts   # Registro inmutable de eventos de auditoría
    │   ├── backup.ts        # Exportación e importación de copias completas en JSON
    │   ├── billingEngine.ts # Cálculo de facturas mensuales, cuotas vencidas y gatillos de mora
    │   ├── crypto.ts        # Hasheo SHA-256 de contraseñas y cifrado
    │   ├── financialCalculations.ts # Cronogramas, amortizaciones, mora y score crediticio
    │   ├── format.ts        # Formateadores de moneda (COP), fechas y cálculos de días
    │   ├── generateContractPDF.ts   # Renderizado de contratos y pagarés oficiales
    │   ├── offlineEdition.ts# Emisión de licencias y validación para instalación offline
    │   ├── share.ts         # Integración para compartir en WhatsApp (app y web)
    │   └── sync/            # Motor de sincronización con Firestore (LWW, pull, push)
    │
    ├── pages/               # Vistas principales de la aplicación
    │   ├── AuditPage.tsx    # Consulta de registros de auditoría
    │   ├── BorrowerDetailPage.tsx # Ficha técnica y préstamos por prestatario
    │   ├── BorrowersPage.tsx# Directorio y registro de prestatarios
    │   ├── ClientPortalPage.tsx # Portal público de clientes (saldo y solicitudes)
    │   ├── CollectionsPage.tsx  # Agenda diaria y control de cobros
    │   ├── DashboardPage.tsx# Métricas clave de cartera, ingresos y vencimientos
    │   ├── LoanDetailPage.tsx   # Amortización, abonos, recibos y contrato PDF
    │   ├── LoansPage.tsx    # Listado general de préstamos y estados
    │   ├── LoginPage.tsx    # Inicio de sesión seguro con detección offline
    │   ├── OfflineEditionPage.tsx # Asistente de instalación de la edición 100% offline
    │   ├── RequestsPage.tsx # Bandeja de aprobación de solicitudes de crédito
    │   ├── SettingsPage.tsx # Ajustes, respaldos, conexión a la nube y control de acceso
    │   ├── SimulatorPage.tsx# Simulador y calculador financiero
    │   ├── SuperAdminPage.tsx   # Panel maestro de control de organizaciones y medidas antifraude
    │   └── SuperPlansPage.tsx   # Planes de suscripción, cobro cloud y cuotas de la app
    │
    └── store/
        └── auth.tsx         # Contexto de autenticación, sesiones y guardias de seguridad
```

---

## ⚡ Instalación y Despliegue

### Prerrequisitos
* **Node.js**: Versión 18.0 o superior (recomendado 20+ o 22+).
* **Gestor de Paquetes**: `npm`, `pnpm` o `yarn`.

### 1. Clonar el repositorio
```bash
git clone https://github.com/ChrisEna07/PresMon.git
cd PresMon
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
Crea un archivo `.env` en la raíz tomando como referencia `.env.example`:
```env
VITE_FIREBASE_API_KEY=tu_api_key
VITE_FIREBASE_AUTH_DOMAIN=tu_proyecto.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=tu_proyecto_id
VITE_FIREBASE_STORAGE_BUCKET=tu_proyecto.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=tu_messaging_sender_id
VITE_FIREBASE_APP_ID=tu_app_id
```

### 4. Ejecutar en desarrollo
```bash
npm run dev
```
La aplicación estará disponible de inmediato en `http://localhost:5173`.

### 5. Compilación para Producción (Vercel / Hosting Estático)
```bash
npm run build
```
Este comando ejecuta la comprobación estricta de TypeScript (`tsc --noEmit`) y compila los assets optimizados en la carpeta `dist/`.

Para previsualizar la compilación de producción localmente:
```bash
npm run preview
```

---

## 🔒 Seguridad y Reglas Firestore

Las reglas de seguridad en [`firestore.rules`](./firestore.rules) aseguran:
1. **Validación de Identidad Tenant**: Toda escritura en tablas operativas requiere especificar un `tenantId` válido en formato string.
2. **Inmutabilidad de Auditoría**: La colección `audit_logs` admite creación (`create`) y eliminación controlada por purga (`delete`), pero **prohíbe actualizaciones** (`update: if false`).
3. **Resiliencia en Eliminaciones**: Las operaciones `delete` están expresamente permitidas para posibilitar la purga en cascada cuando el Super Admin elimina una organización o ejecuta un borrado remoto.

Para publicar las reglas en Firebase:
```bash
firebase deploy --only firestore:rules
```

---

## 👥 Roles del Sistema

| Rol | Alcance | Funciones Clave |
| :--- | :--- | :--- |
| **SUPER_ADMIN** | Global (Plataforma) | Control de organizaciones, suspensión remota, purga de datos locales, emisión de licencias offline, planes de facturación mensual y configuración global de base de datos. |
| **TENANT_ADMIN** | Organización (Inquilino) | Registro de clientes, aprobación de préstamos, cobranza diaria, cálculo de mora, emisión de pagarés en PDF y visualización de facturas mensuales. |
| **CLIENTE** | Portal Web Público | Consulta de saldo de créditos, próximas fechas de pago y envío de solicitudes de crédito sin requerir usuario o clave. |

---

## 📞 Créditos y Contacto

Desarrollado y mantenido por **ChrizDev**.

Para soporte técnico, cotizaciones de licencias offline, configuración de planes a medida o solicitud de cambios en organizaciones activas, comunícate directamente a través de los canales oficiales de soporte integrados en la aplicación o vía WhatsApp.

---
<div align="center">
  <sub>PresMon © 2026 · Diseñado con pasión para un control financiero ágil, seguro y confiable.</sub>
</div>