import { useEffect, useState } from 'react'
import type { JSX } from 'react'

function App(): JSX.Element {
  const [pong, setPong] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.teskra
      .ping()
      .then((result) => {
        if (!cancelled) {
          setPong(result.ok ? result.data : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPong(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main>
      <h1>Teskra</h1>
      <p>Orchestrate your coding agents.</p>
      <p>
        Bridge: {window.teskra.appName} v{window.teskra.appVersion}
        {pong ? ` — IPC ${pong}` : ''}
      </p>
    </main>
  )
}

export default App
