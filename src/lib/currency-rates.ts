import { config } from '../config/env.js';
import { SUPPORTED_COUNTRY_CONFIGS } from '../config/sync-config.js';

export interface CurrencyInfo {
  code: string;
  symbol: string;
  locale: string;
}

export interface ConvertedUsdResult {
  amount: number | null;
  rate: number | null;
}

const CURRENCY_META: Record<string, CurrencyInfo> = SUPPORTED_COUNTRY_CONFIGS.reduce(
  (acc, entry) => {
    acc[entry.code] = {
      code: entry.currencyCode,
      symbol: entry.currencySymbol,
      locale: entry.locale,
    };
    return acc;
  },
  {} as Record<string, CurrencyInfo>
);

const exchangeRateCache = new Map<string, { rate: number; expiresAt: number }>();

export function getCountryCurrency(country: string): CurrencyInfo {
  return CURRENCY_META[country.toUpperCase()] ?? { code: 'USD', symbol: '$', locale: 'en-US' };
}

function extractRate(
  payload: {
  rates?: Record<string, number>;
  data?: Record<string, number | { value?: number; rate?: number }>;
  conversion_rates?: Record<string, number>;
},
  targetCurrencyCode: string
): number | null {
  const directData = payload?.data?.[targetCurrencyCode];
  if (typeof directData === 'number' && Number.isFinite(directData)) {
    return directData;
  }

  if (
    directData &&
    typeof directData === 'object' &&
    (typeof directData.value === 'number' || typeof directData.rate === 'number')
  ) {
    const nestedRate = directData.value ?? directData.rate ?? null;
    if (typeof nestedRate === 'number' && Number.isFinite(nestedRate)) {
      return nestedRate;
    }
  }

  const candidateRate =
    payload?.rates?.[targetCurrencyCode] ??
    payload?.conversion_rates?.[targetCurrencyCode] ??
    null;

  return typeof candidateRate === 'number' && Number.isFinite(candidateRate)
    ? candidateRate
    : null;
}

function buildCurrencyRequestUrl(
  baseCurrencyCode: string,
  targetCurrencyCode: string
): URL {
  const url = new URL(config.currency.apiUrl);
  const hostname = url.hostname.toLowerCase();
  const isCurrencyApi = hostname.includes('currencyapi.com');

  if (isCurrencyApi) {
    url.searchParams.set('base_currency', baseCurrencyCode);
    url.searchParams.set('currencies', targetCurrencyCode);
    if (config.currency.apiKey && !url.searchParams.has('apikey')) {
      url.searchParams.set('apikey', config.currency.apiKey);
    }
    return url;
  }

  url.searchParams.set('base', baseCurrencyCode);
  url.searchParams.set('symbols', targetCurrencyCode);
  if (config.currency.apiKey) {
    if (!url.searchParams.has('access_key')) {
      url.searchParams.set('access_key', config.currency.apiKey);
    }
    if (!url.searchParams.has('apikey')) {
      url.searchParams.set('apikey', config.currency.apiKey);
    }
  }

  return url;
}

async function fetchExchangeRate(
  baseCurrencyCode: string,
  targetCurrencyCode: string
): Promise<number> {
  if (baseCurrencyCode === targetCurrencyCode) return 1;

  const cacheKey = `${baseCurrencyCode}->${targetCurrencyCode}`;
  const cached = exchangeRateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rate;
  }

  if (!config.currency.apiUrl) {
    throw new Error('Missing CURRENCY_API_URL for conversion.');
  }

  const url = buildCurrencyRequestUrl(baseCurrencyCode, targetCurrencyCode);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Currency API failed: ${res.status}`);
  }
  const payload = await res.json() as {
    rates?: Record<string, number>;
    data?: Record<string, number | { value?: number; rate?: number }>;
    conversion_rates?: Record<string, number>;
  };
  const rate = extractRate(payload, targetCurrencyCode);

  if (typeof rate !== 'number' || Number.isNaN(rate)) {
    throw new Error(`Currency API response missing ${targetCurrencyCode} rate for ${baseCurrencyCode}`);
  }

  exchangeRateCache.set(cacheKey, {
    rate,
    expiresAt: Date.now() + Math.max(60_000, config.currency.cacheTtlMs),
  });
  return rate;
}

export async function convertLocalToUsd(localPrice: number, country: string): Promise<number | null> {
  const result = await convertLocalToUsdDetailed(localPrice, country);
  return result.amount;
}

export async function convertLocalToUsdDetailed(
  localPrice: number,
  country: string
): Promise<ConvertedUsdResult> {
  if (!Number.isFinite(localPrice)) {
    return { amount: null, rate: null };
  }
  const currency = getCountryCurrency(country);
  const rate = await fetchExchangeRate(currency.code, 'USD');
  return {
    amount: Math.round(localPrice * rate * 100) / 100,
    rate,
  };
}

export async function convertUsdToLocalDetailed(
  usdPrice: number,
  country: string
): Promise<ConvertedUsdResult> {
  if (!Number.isFinite(usdPrice)) {
    return { amount: null, rate: null };
  }

  const currency = getCountryCurrency(country);
  const rate = await fetchExchangeRate('USD', currency.code);
  return {
    amount: Math.round(usdPrice * rate * 100) / 100,
    rate,
  };
}
