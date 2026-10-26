// Dev-only: the loading screen alone (loading.html), for editing it with hot reload.
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { LoadingScene } from './components/LoadingScene.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoadingScene />
  </StrictMode>,
);
