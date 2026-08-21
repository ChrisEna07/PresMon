import LoanSimulator from '../components/LoanSimulator';
import { PageHeader } from '../components/misc';

export default function SimulatorPage() {
  return (
    <div>
      <PageHeader
        title="Simulador de préstamos"
        description="Ajusta monto, tasa, frecuencia y mora. La tabla de amortización se recalcula al instante."
      />
      <LoanSimulator />
    </div>
  );
}
