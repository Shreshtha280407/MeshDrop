import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Foundation from './Foundation';
import RoomApp from './RoomApp';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
const initialInvitation = window.location.hash ? window.location.href : '';
// Fragments are not sent to servers. Remove them from browser history promptly.
if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/foundation' ? (
      <Foundation />
    ) : (
      <RoomApp initialInvitation={initialInvitation} />
    )}
  </StrictMode>,
);
