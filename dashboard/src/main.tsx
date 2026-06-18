import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadManifest } from './data';
import './styles.css';

// Resolve the run list from its approved sources (R2 + bundled) before the
// first render, so runMetas/defaultMeta are populated synchronously thereafter.
loadManifest().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
