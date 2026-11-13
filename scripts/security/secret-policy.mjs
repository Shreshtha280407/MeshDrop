import { URL, URLSearchParams } from 'node:url';

/** Conservative source checks. Findings contain categories, never matched values. */
export function secretFindings(text) {
  const findings = new Set();
  if (
    /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(
      text,
    )
  )
    findings.add('possible embedded credential or private key');
  const placeholder = (value) =>
    /^(?:synthetic[-_]|fixture[-_]|task\d+[-_]|YOUR_|REPLACE_)/i.test(value) ||
    /[${}<>]/.test(value);
  const assignments =
    /\b(?:CLOUDFLARE_(?:API_TOKEN|TURN_API_TOKEN|ANALYTICS_API_TOKEN)|METERED_(?:SECRET_KEY|API_KEY)|TURN_SHARED_SECRET|BROWSERSTACK_ACCESS_KEY|OPS_REVOKE_SECRET|REHEARSAL_(?:FAULT_)?DB_(?:READER_)?PASSWORD|PREVIEW_CANARY_API_TOKEN)["']?\s*[:=]\s*(["'])([^"'\r\n]{20,256})\1/g;
  for (const match of text.matchAll(assignments))
    if (!placeholder(match[2])) findings.add('possible literal provider/operator credential');
  for (const match of text.matchAll(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>`]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.password && !placeholder(decodeURIComponent(url.password)))
        findings.add('possible credential-bearing URL');
      const fragment = new URLSearchParams(url.hash.slice(1));
      if (
        /^[a-f0-9-]{36}$/i.test(fragment.get('room') ?? '') &&
        /^[A-Za-z0-9_-]{43}$/.test(fragment.get('invite') ?? '')
      )
        findings.add('possible literal invitation capability');
      for (const [key, value] of url.searchParams)
        if (
          /^(?:token|api[_-]?key|access[_-]?token|secret|password|capability|invite|ticket|ownerCapability|peerCapability)$/i.test(
            key,
          ) &&
          value.length >= 20 &&
          !placeholder(value)
        )
          findings.add('possible secret in URL query');
    } catch {
      /* Code templates and incomplete documentation URLs are not live credentials. */
    }
  }
  return [...findings];
}
