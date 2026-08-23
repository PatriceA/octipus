/**
 * Browser entry point.
 *
 * The document shell — `<html class="dark">`, the metadata, the icons — lives
 * in `index.html` now rather than in a layout component, which is the one real
 * structural difference from the file-router: there is no server render, so
 * there is nothing for a React component to emit into `<head>`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app/globals.css';
import { Router } from './router';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
