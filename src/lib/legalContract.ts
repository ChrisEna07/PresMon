/**
 * Marco Contractual y Legal - PresMon Cloud SaaS
 * Ley 527 de 1999, Ley 1480 de 2011, Código Civil Arts. 1602 y 1609 de la República de Colombia.
 */

export const CURRENT_CONTRACT_VERSION = '2026.1-CO';
export const CONTRACT_TITLE = 'CONTRATO DE LICENCIA DE SOFTWARE SAAS, TÉRMINOS DE SERVICIO Y ACUERDO VINCULANTE DE PAGO';

export const CONTRACT_SECTIONS = [
  {
    number: '1',
    title: 'NATURALEZA DEL SERVICIO Y LICENCIAMIENTO',
    body: 'El presente contrato regula el acceso y uso del software especializado de administración de préstamos y cartera PresMon (en adelante el "Software"), suministrado en modalidad de Software como Servicio (SaaS) y/o despliegue asistido por ChrizDev (en adelante el "Proveedor"). La licencia concedida a la Organización/Cliente es de carácter temporal, revocable, no exclusiva e intransferible, condicionada indispensablemente al cumplimiento oportuno de las obligaciones económicas pactadas.',
  },
  {
    number: '2',
    title: 'OBLIGACIÓN PECUNIARIA PRINCIPAL Y SERVICIOS CLOUD',
    body: 'El Cliente se obliga de manera irrevocable e incondicional a cancelar dentro de las fechas límites estipuladas la tarifa mensual por concepto de uso de la plataforma, así como los costos correspondientes a infraestructura y servicios Cloud (alojamiento en servidores, sincronización multi-dispositivo y base de datos distribuida). El Cliente declara comprender que los costos de operación cloud demandan erogaciones financieras periódicas e inaplazables asumidas ante proveedores de telecomunicaciones e infraestructura, por lo que la omisión en su pago directo por parte del Cliente impide materialmente la subsistencia técnica del servicio.',
  },
  {
    number: '3',
    title: 'SUSPENSIÓN INMEDIATA POR MORA Y EXCEPCIÓN DE CONTRATO NO CUMPLIDO (ART. 1609 C.C.)',
    body: 'En observancia del Artículo 1609 del Código Civil de Colombia (excepción de contrato no cumplido: "ninguno de los contratantes está en mora dejando de cumplir lo pactado, mientras el otro no lo cumpla por su parte"), la falta de pago oportuno de una o más mensualidades o cargos del servicio cloud facultará de pleno derecho al Proveedor para suspender, inhabilitar o bloquear remotamente el acceso al sistema, la visualización de datos en línea y sus aplicaciones cliente. Dicha suspensión no genera derecho a indemnización por daños, perjuicios, lucro cesante o daño emergente alegado por el Cliente.',
  },
  {
    number: '4',
    title: 'REQUISITO INDISPENSABLE DE PAGO TOTAL PARA DESBLOQUEO',
    body: 'Para el restablecimiento de los servicios y el levantamiento de cualquier suspensión o bloqueo por mora, el Cliente deberá cancelar la TOTALIDAD DE LAS MENSUALIDADES Y PERÍODOS CLOUD VENCIDOS Y ACUMULADOS (100% de la deuda en mora). No procederán reactivaciones basadas en abonos fraccionados ni prórrogas extemporáneas una vez agotada la condición de gracia inicial.',
  },
  {
    number: '5',
    title: 'RÉGIMEN EXCEPCIONAL DE ABONOS Y GRACIA TEMPORAL (15 DÍAS)',
    body: 'El otorgamiento de prórrogas de hasta quince (15) días calendario mediante abono parcial constituye una gracia extraordinaria y voluntaria del Proveedor aplicable EXCLUSIVAMENTE en el primer período facturado de la Organización. Una vez transcurrido o utilizado dicho beneficio único, las mensualidades posteriores deberán satisfacerse de manera íntegra e improrrogable en su fecha de corte. El retraso reiterado causará el bloqueo inmediato e incondicional del sistema.',
  },
  {
    number: '6',
    title: 'VALIDEZ PROBATORIA ELECTRÓNICA Y MENSAJE DE DATOS (LEY 527 DE 1999)',
    body: 'Conforme a los Artículos 6, 7, 8 y 10 de la Ley 527 de 1999 de la República de Colombia, la aceptación digital del presente acuerdo mediante pulsación del botón de confirmación ("Acepto") goza de plena equivalencia funcional respecto a la firma manuscrita. Las partes convienen que los registros digitales de auditoría, sellos cronológicos (timestamps UTC/ISO), direcciones IP de origen, identificadores de dispositivo (User-Agent) e identificadores de usuario registrados en la base de datos constituyen plena prueba judicial de la aceptación libre y espontánea de este contrato.',
  },
  {
    number: '7',
    title: 'PROTECCIÓN DE DATOS Y JURISDICCIÓN APLICABLE',
    body: 'El Cliente es el Responsable del Tratamiento de los datos de sus deudores de conformidad con la Ley 1581 de 2012. ChrizDev actúa como Encargado del Tratamiento. Cualquier controversia, diferencia o reclamación relativa a este contrato será resuelta bajo la legislación sustantiva y procesal de la República de Colombia, renunciando el Cliente a cualquier vía de hecho o reclamación improcedente frente a suspensiones legítimas por impago.',
  },
];

export function getFullContractPlainText(tenantName: string, clientName: string): string {
  const lines: string[] = [];
  lines.push(CONTRACT_TITLE);
  lines.push(`Versión: ${CURRENT_CONTRACT_VERSION} | Jurisdicción: República de Colombia`);
  lines.push(`Organización Licenciataria: ${tenantName}`);
  lines.push(`Representante / Usuario Autorizado: ${clientName}`);
  lines.push('------------------------------------------------------------------------');
  for (const s of CONTRACT_SECTIONS) {
    lines.push(`CLÁUSULA ${s.number} - ${s.title}:`);
    lines.push(s.body);
    lines.push('');
  }
  lines.push('Aceptado electrónicamente con validez legal según Ley 527 de 1999.');
  return lines.join('\n');
}
