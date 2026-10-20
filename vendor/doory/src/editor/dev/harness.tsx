/** Entry point of /editor-harness.html (dev and e2e only; it is not part of the production build). */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Harness } from './HarnessApp'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)
