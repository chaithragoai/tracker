/**
 * Optional AI summaries — DISABLED by default.
 * Never calls external network services. Produces a deterministic local "digest"
 * unless a future local model hook is configured with explicit consent.
 */

import { formatDuration } from './analytics.js';

export function buildLocalDigest(summary, weekly) {
  const apps = JSON.parse(summary.app_breakdown_json || '{}');
  const topApp = Object.values(apps).sort((a, b) => b.seconds - a.seconds)[0];
  const domains = JSON.parse(summary.domain_breakdown_json || '{}');
  const topDomain = Object.entries(domains).sort((a, b) => b[1] - a[1])[0];

  const lines = [
    `Local digest for ${summary.day || 'today'} (not an external AI call).`,
    `Active time: ${formatDuration(summary.active_seconds)}.`,
    `Idle time: ${formatDuration(summary.idle_seconds)}.`,
    topApp ? `Top application: ${topApp.name} (${formatDuration(topApp.seconds)}).` : 'No application usage recorded.',
    topDomain ? `Top website: ${topDomain[0]} (${formatDuration(topDomain[1])}).` : 'No website usage recorded.',
    `Operations: ${summary.operation_count || 0}; errors: ${summary.error_count || 0}.`,
  ];
  if (weekly?.totals) {
    lines.push(
      `Last 7 days active: ${formatDuration(weekly.totals.active)} across ${weekly.days?.length || 0} days.`
    );
  }
  return lines.join(' ');
}

export function maybeSummarize({ settings, summary, weekly }) {
  if (!settings?.aiConsent || !settings?.aiSummariesEnabled) {
    return {
      enabled: false,
      text: 'AI summaries are disabled. Enable only with explicit consent in the dashboard.',
    };
  }
  // Still local-only: no external API keys, no uploads.
  return {
    enabled: true,
    provider: 'local-digest',
    text: buildLocalDigest(summary, weekly),
  };
}
