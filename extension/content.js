/**
 * Content script — semantic operations only (not raw keylogging).
 * Never records password/sensitive field values.
 */

(function () {
  if (window.__macActivityTrackerContent) return;
  window.__macActivityTrackerContent = true;

  const SENSITIVE_TYPE = /password|email|tel|hidden/i;
  const SENSITIVE_NAME = /pass|token|secret|card|cvv|ssn|otp|auth/i;

  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('change', onChange, true);

  // Detect in-page search boxes (heuristic)
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return;
      const el = e.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
      if (isSensitive(el)) return;
      if (looksLikeSearch(el)) {
        send('search', 'unknown', {
          semantic: 'search_submitted',
          fieldName: safeName(el),
          queryLength: (el.value || '').length,
          // Do not send the query text by default (privacy)
        });
      }
    },
    true
  );

  function onClick(e) {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const interactive = el.closest('a, button, [role="button"], input[type="submit"], input[type="button"]');
    if (!interactive) return;

    const semantic = classifyClick(interactive);
    send('click', 'unknown', {
      semantic,
      tag: interactive.tagName.toLowerCase(),
      text: clipText(interactive),
      href: interactive instanceof HTMLAnchorElement ? safeHref(interactive.href) : undefined,
    });
  }

  function onSubmit(e) {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (formHasSensitiveFields(form)) {
      send('formSubmit', 'unknown', {
        semantic: 'form_submitted_sensitive_redacted',
        action: safeHref(form.action || location.href),
        method: (form.method || 'get').toLowerCase(),
        fieldCount: form.elements.length,
      });
      return;
    }
    send('formSubmit', 'unknown', {
      semantic: 'form_submitted',
      action: safeHref(form.action || location.href),
      method: (form.method || 'get').toLowerCase(),
      fieldCount: form.elements.length,
    });
  }

  function onChange(e) {
    const el = e.target;
    if (!(el instanceof HTMLSelectElement || el instanceof HTMLInputElement)) return;
    if (isSensitive(el)) return;
    if (el instanceof HTMLSelectElement || el.type === 'checkbox' || el.type === 'radio' || el.type === 'search') {
      send('operation', 'unknown', {
        semantic: el instanceof HTMLSelectElement ? 'filter_changed' : 'input_changed',
        fieldName: safeName(el),
        inputType: el instanceof HTMLInputElement ? el.type : 'select',
      });
    }
  }

  function classifyClick(el) {
    const text = (el.textContent || '').toLowerCase();
    if (/search|find|filter|query/.test(text)) return 'clicked_search_control';
    if (/submit|save|send|create|update|delete/.test(text)) return 'clicked_action_control';
    if (el instanceof HTMLAnchorElement) return 'opened_link';
    return 'clicked_control';
  }

  function looksLikeSearch(el) {
    if (el instanceof HTMLInputElement && (el.type === 'search' || el.name === 'q' || el.name === 'query')) return true;
    const attrs = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    return /search|query|filter|find/.test(attrs);
  }

  function isSensitive(el) {
    if (el instanceof HTMLInputElement) {
      if (SENSITIVE_TYPE.test(el.type || '')) return true;
      if (el.autocomplete && /password|cc-|one-time/i.test(el.autocomplete)) return true;
    }
    return SENSITIVE_NAME.test(safeName(el));
  }

  function formHasSensitiveFields(form) {
    for (const el of Array.from(form.elements)) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (isSensitive(el)) return true;
      }
    }
    return false;
  }

  function safeName(el) {
    return el.name || el.id || el.getAttribute('aria-label') || '';
  }

  function clipText(el) {
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 80);
  }

  function safeHref(href) {
    try {
      const u = new URL(href, location.href);
      // Strip likely secrets from query
      for (const key of [...u.searchParams.keys()]) {
        if (/token|pass|secret|key|auth|session/i.test(key)) u.searchParams.set(key, 'REDACTED');
      }
      return u.toString().slice(0, 500);
    } catch {
      return undefined;
    }
  }

  function send(operationType, outcome, metadata) {
    try {
      chrome.runtime.sendMessage({
        type: 'pageOperation',
        operationType,
        outcome,
        metadata,
      });
    } catch {
      // Extension context invalidated
    }
  }
})();
