import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WorkWindowStandalone } from './ui/WorkWindowStandalone.tsx'

const params = new URLSearchParams(location.search)
if (params.get('work') === '1') {
  createRoot(document.getElementById('root')!).render(<WorkWindowStandalone />)
} else {
  createRoot(document.getElementById('root')!).render(<App />)
}
