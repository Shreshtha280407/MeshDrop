import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Foundation from './Foundation';
import RoomApp from './RoomApp';
import { consumeInvitationUrl } from './security/invitationUrl';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
const initialInvitation = consumeInvitationUrl();
createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/foundation' ? (
      <Foundation />
    ) : (
      <RoomApp initialInvitation={initialInvitation} />
    )}
  </StrictMode>,
);
