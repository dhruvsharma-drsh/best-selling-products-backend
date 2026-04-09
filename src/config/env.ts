/**
 * Centralized Backend Configuration
 *
 * All environment-dependent values are read here.
 * No hardcoded URLs, ports, or connection strings elsewhere.
 *
 * Environment variables (set in .env or hosting platform):
 *   DATABASE_URL       — PostgreSQL connection string
 *   REDIS_URL          — Full Redis URL (overrides host/port/password)
 *   REDIS_HOST         — Redis hostname (default: localhost)
 *   REDIS_PORT         — Redis port (default: 6379)
 *   REDIS_PASSWORD     — Redis password
 *   REDIS_TLS          — Enable TLS for Redis (default: false)
 *   PORT               — HTTP server port (default: 3001)
 *   NODE_ENV           — Environment: development | staging | production
 *   PUBLIC_BASE_URL    — Public-facing URL for log output
 *   CORS_ORIGIN        — Comma-separated allowed origins, or * for all
 */

import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

function normalizeCorsOrigin(origin: string): string {
  const trimmed = origin.trim();

  if (!trimmed || trimmed === '*') {
    return trimmed;
  }

  return trimmed.replace(/\/$/, '');
}

export const config = {
  /** Current environment */
  env: (process.env.NODE_ENV || 'development') as 'development' | 'staging' | 'production',

  /** Whether we're in production mode */
  isProduction: process.env.NODE_ENV === 'production',

  /** HTTP server port */
  port: parseInt(process.env.PORT || '3001', 10),

  /** Public-facing base URL (for log output) */
  publicBaseUrl: (() => {
    const url = process.env.PUBLIC_BASE_URL?.trim();
    if (!url) return '';
    const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return withProtocol.replace(/\/$/, '');
  })(),

  /** Database connection string */
  databaseUrl: process.env.DATABASE_URL || '',

  /** Redis configuration */
  redis: {
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true',
  },

  /** CORS allowed origins (parsed from CORS_ORIGIN env var) */
  cors: {
    origins: (process.env.CORS_ORIGIN || '')
      .split(',')
      .map(normalizeCorsOrigin)
      .filter(Boolean),
  },

  /** Currency conversion API configuration */
  currency: {
    apiUrl: process.env.CURRENCY_API_URL || '',
    apiKey: process.env.CURRENCY_API_KEY || '',
    cacheTtlMs: parseInt(process.env.CURRENCY_CACHE_TTL_MS || '3600000', 10),
  },
} as const;

// Re-export for backward compatibility
export default config;
