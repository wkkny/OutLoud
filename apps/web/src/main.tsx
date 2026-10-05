import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const root = createRoot(document.getElementById('root')!)
// Throwaway release exploration is reachable only in development, never the packaged renderer.
if (import.meta.env.DEV && new URLSearchParams(location.search).get('prototype') === 'study-release') {
  void import('./prototype-study-release').then(({ default: Prototype }) => {
    root.render(<StrictMode><Prototype /></StrictMode>)
  })
} else {
  root.render(<StrictMode><App /></StrictMode>)
}
