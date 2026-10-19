# Browser capability matrix

What the Chrome extension can and cannot capture. Safari is designed for later with the same event shape.

| Capability | Automatic | Site-specific | Unsupported / limited |
|------------|-----------|---------------|------------------------|
| Browser name | Yes (Chrome) | — | Safari not yet |
| Tab ID / title / URL / domain | Yes (tabs API) | — | `chrome://`, Web Store, PDF viewer, and other protected pages |
| Tab create / activate / navigate / close | Yes | — | Cross-profile / Incognito only if extension allowed there |
| Time spent per tab URL session | Yes | — | Background tabs keep counting until closed/navigated |
| Page load complete | Yes (`tabs.onUpdated` / webNavigation) | — | — |
| Page load errors | Often (`webNavigation.onErrorOccurred`) | — | Soft app errors (HTTP 200 + error UI) need site hooks |
| Clicks on links/buttons | Heuristic content script | Better with site adapters | Cross-origin iframes, canvas-only UIs |
| Search submit | Heuristic (search inputs + Enter) | Site adapters for SPAs | Encrypted/custom widgets |
| Filter / select changes | Heuristic on `change` | Site adapters | Virtualized custom dropdowns |
| Form start/submit | Submit listener; sensitive forms redacted | — | Values of sensitive fields never recorded |
| Downloads | Yes (downloads API) | — | Upload progress limited; many SPAs use XHR without downloads API |
| Uploads | Partial (file input change can be detected later) | Site adapters | Binary contents never stored |
| “Opened customer record” style semantics | Only when UI text/URL patterns match | **Recommended via site adapters** | Not universal |
| Passwords / tokens / cookies / payment fields | **Never** | — | Blocked by design |
| Full page content / messages | **No by default** | Explicit future opt-in only | — |

## Important limitations (simple English)

1. **Protected pages** — Chrome blocks extensions on `chrome://` and the Web Store.
2. **Iframes** — Content scripts do not run in cross-origin frames (`all_frames: false` by design).
3. **SPAs** — Many apps change screens without full navigations; we still get tab URL changes when the URL updates, but in-page widgets may need site-specific hooks.
4. **Outcomes** — We mark `success` / `failure` only with evidence (e.g. download complete, navigation error). Otherwise `unknown`.
5. **Safari** — Not implemented yet; architecture keeps the same JSON event format for a future Safari App Extension.
