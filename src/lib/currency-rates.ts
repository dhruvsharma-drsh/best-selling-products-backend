/**
 * Currency metadata and exchange rates for supported Amazon regions.
 *
 * Exchange rates are mid-market rates as of April 2026.
 * Source: xe.com, Google Finance
 *
 * NOTE: These are static / hardcoded. For live rates, integrate an
 * external API (e.g. Open Exchange Rates, exchangerate-api.com).
 */

export interface CurrencyInfo {
  /** ISO 4217 code, e.g. "USD" */
  code: string;
  /** Symbol for display, e.g. "$", "¥" */
  symbol: string;
  /** How many USD does 1 unit of this currency buy? */
  rateToUsd: number;
}

/**
 * Map of country codes → currency metadata.
 *
 * `rateToUsd` converts FROM the local currency TO USD:
 *   priceInUsd = priceLocal * rateToUsd
 */
export const CURRENCY_META: Record<string, CurrencyInfo> = {
  US: { code: 'USD', symbol: '$',     rateToUsd: 1.0 },
  UK: { code: 'GBP', symbol: '£',     rateToUsd: 1.27 },
  CA: { code: 'CAD', symbol: 'CA$',   rateToUsd: 0.73 },
  DE: { code: 'EUR', symbol: '€',     rateToUsd: 1.09 },
  FR: { code: 'EUR', symbol: '€',     rateToUsd: 1.09 },
  IT: { code: 'EUR', symbol: '€',     rateToUsd: 1.09 },
  ES: { code: 'EUR', symbol: '€',     rateToUsd: 1.09 },
  IN: { code: 'INR', symbol: '₹',     rateToUsd: 0.012 },
  JP: { code: 'JPY', symbol: '¥',     rateToUsd: 0.0067 },
  AU: { code: 'AUD', symbol: 'A$',    rateToUsd: 0.64 },
  AE: { code: 'AED', symbol: 'د.إ',   rateToUsd: 0.2723 },
};

/**
 * Get currency info for a country.
 * Falls back to USD if country is unknown.
 */
export function getCountryCurrency(country: string): CurrencyInfo {
  return CURRENCY_META[country.toUpperCase()] ?? CURRENCY_META['US'];
}

/**
 * Convert a price from local currency to USD.
 *
 * @param localPrice  The price in the country's local currency
 * @param country     Country code (e.g. 'JP', 'AE')
 * @returns           Price in USD (rounded to 2 decimal places)
 */
export function convertToUsd(localPrice: number, country: string): number {
  const info = getCountryCurrency(country);
  return Math.round(localPrice * info.rateToUsd * 100) / 100;
}
