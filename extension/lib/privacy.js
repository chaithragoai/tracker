/** Shared privacy helpers (usable from Node tests and documented for the extension). */

export function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isProtectedUrl(url) {
  return /^(chrome|chrome-extension|devtools|edge|about|brave):/i.test(url || '');
}

export function isExcluded(url, excludedDomains = []) {
  const host = domainOf(url);
  if (!host) return false;
  for (const d of excludedDomains) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function sanitizeMetadata(meta = {}) {
  const out = {};
  const blocked = /password|token|cookie|secret|card|cvv|ssn|auth/i;
  for (const [k, v] of Object.entries(meta)) {
    if (blocked.test(k)) continue;
    if (typeof v === 'string' && v.length > 500) out[k] = `${v.slice(0, 500)}…`;
    else if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

export function redactSensitiveQuery(href) {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) {
      if (/token|pass|secret|key|auth|session/i.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    return u.toString().slice(0, 500);
  } catch {
    return undefined;
  }
}
