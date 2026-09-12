import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { ErrorBoundary } from './components/error-boundary'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Renderer root element #root is missing')
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
