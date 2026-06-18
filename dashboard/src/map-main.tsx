import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MapApp } from './MapApp';
import { loadManifest } from './data';
import './styles.css';

// Resolve the run list from its approved sources before the first render
// (see main.tsx); the map module shares the same run picker.
loadManifest().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MapApp />
    </StrictMode>,
  );
});
