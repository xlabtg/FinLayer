/**
 * Affiliate redirect target policy.
 */

import { AffiliateRedirectTargetNotAllowedError } from '../shared/errors/index.js';

const DEFAULT_MARKETPLACE_BASE_URL = 'https://app.finlayer.io';
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

export function resolveAffiliateRedirectAllowedOrigins(
  value = process.env['AFFILIATE_REDIRECT_ALLOWED_ORIGINS'],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const configured = splitCsv(value);
  const bases = configured.length > 0
    ? configured
    : [
      env['MARKETPLACE_BASE_URL'] ?? DEFAULT_MARKETPLACE_BASE_URL,
      env['API_BASE_URL'] ?? DEFAULT_API_BASE_URL,
    ];

  const origins = new Set(bases.map(normalizeOrigin));
  return [...origins].sort();
}

export function assertAffiliateRedirectTargetAllowed(
  targetUrl: string,
  allowedOrigins = resolveAffiliateRedirectAllowedOrigins()
): void {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new AffiliateRedirectTargetNotAllowedError('(invalid URL)', allowedOrigins);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new AffiliateRedirectTargetNotAllowedError(target.origin, allowedOrigins);
  }

  if (!allowedOrigins.includes(target.origin)) {
    throw new AffiliateRedirectTargetNotAllowedError(target.origin, allowedOrigins);
  }
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(',').map(part => part.trim()).filter(Boolean) ?? [];
}

function normalizeOrigin(value: string): string {
  if (value.includes('*')) {
    throw new Error('AFFILIATE_REDIRECT_ALLOWED_ORIGINS must not include wildcards');
  }
  return parseHttpUrl(value.includes('://') ? value : `https://${value}`, 'allowed origin').origin;
}

function parseHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid affiliate redirect ${field}: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Affiliate redirect ${field} must use http or https: ${value}`);
  }

  return url;
}
