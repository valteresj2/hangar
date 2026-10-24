import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickEntry } from './features/settings'
import './styles.css'

// The same bundle serves every window; the URL hash picks the root view.
const Root = window.location.hash === '#quick-entry' ? QuickEntry : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
