/** Consume invitation navigation in memory; never turn it into a request or storage record. */
export function consumeInvitationUrl(): string {
  if (!window.location.hash) return '';
  const invitation = window.location.href;
  window.history.replaceState(window.history.state, '', window.location.pathname);
  return invitation.length <= 2048 ? invitation : '';
}

/** Hash-only navigation and BFCache/history restoration do not reexecute main.tsx. */
export function observeInvitationUrls(receive: (invitation: string) => void): () => void {
  const consume = () => {
    const invitation = consumeInvitationUrl();
    if (invitation) receive(invitation);
  };
  const events = ['hashchange', 'popstate', 'pageshow'] as const;
  for (const event of events) window.addEventListener(event, consume);
  consume(); // Close the gap between module startup and effect subscription.
  return () => {
    for (const event of events) window.removeEventListener(event, consume);
  };
}
