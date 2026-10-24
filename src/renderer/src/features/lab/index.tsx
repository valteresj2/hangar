// Feature "lab" — renderer side. Owned by the lab agent.

/** Full-screen Harness Lab for one project directory: rounds, variants, blind selection. */
export function LabView({ onClose }: { cwd: string; onClose: () => void }) {
  return (
    <div style={{ padding: 24 }}>
      Harness Lab <button onClick={onClose}>Fechar</button>
    </div>
  )
}
