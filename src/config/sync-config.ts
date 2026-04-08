export interface SupportedCountryConfig {
  code: string;
  label: string;
  domain: string;
  currencyCode: string;
  currencySymbol: string;
  platform: 'amazon' | 'local_fallback';
  locale: string;
}

export const PRODUCT_LIMIT_OPTIONS = [10, 20, 50, 100] as const;
export const DEFAULT_PRODUCT_LIMIT = PRODUCT_LIMIT_OPTIONS[0];
export type ProductLimitOption = (typeof PRODUCT_LIMIT_OPTIONS)[number];

export function normalizeProductLimit(input: number | null | undefined): ProductLimitOption {
  const value = Number(input ?? DEFAULT_PRODUCT_LIMIT);
  if (PRODUCT_LIMIT_OPTIONS.includes(value as ProductLimitOption)) {
    return value as ProductLimitOption;
  }
  return DEFAULT_PRODUCT_LIMIT;
}

export const SUPPORTED_COUNTRY_CONFIGS: SupportedCountryConfig[] = [
  { code: 'US', label: 'United States', domain: 'amazon.com', currencyCode: 'USD', currencySymbol: '$', platform: 'amazon', locale: 'en-US' },
  { code: 'UK', label: 'United Kingdom', domain: 'amazon.co.uk', currencyCode: 'GBP', currencySymbol: '£', platform: 'amazon', locale: 'en-GB' },
  { code: 'DE', label: 'Germany', domain: 'amazon.de', currencyCode: 'EUR', currencySymbol: 'EUR', platform: 'amazon', locale: 'de-DE' },
  { code: 'FR', label: 'France', domain: 'amazon.fr', currencyCode: 'EUR', currencySymbol: 'EUR', platform: 'amazon', locale: 'fr-FR' },
  { code: 'JP', label: 'Japan', domain: 'amazon.co.jp', currencyCode: 'JPY', currencySymbol: 'JPY', platform: 'amazon', locale: 'ja-JP' },
  { code: 'IN', label: 'India', domain: 'amazon.in', currencyCode: 'INR', currencySymbol: 'INR', platform: 'amazon', locale: 'en-IN' },
  { code: 'CA', label: 'Canada', domain: 'amazon.ca', currencyCode: 'CAD', currencySymbol: 'CAD', platform: 'amazon', locale: 'en-CA' },
  { code: 'MX', label: 'Mexico', domain: 'amazon.com.mx', currencyCode: 'MXN', currencySymbol: 'MXN', platform: 'amazon', locale: 'es-MX' },
  { code: 'BR', label: 'Brazil', domain: 'amazon.com.br', currencyCode: 'BRL', currencySymbol: 'BRL', platform: 'amazon', locale: 'pt-BR' },
  { code: 'AU', label: 'Australia', domain: 'amazon.com.au', currencyCode: 'AUD', currencySymbol: 'AUD', platform: 'amazon', locale: 'en-AU' },
  { code: 'AE', label: 'UAE', domain: 'amazon.ae', currencyCode: 'AED', currencySymbol: 'AED', platform: 'amazon', locale: 'en-AE' },
  { code: 'SA', label: 'Saudi Arabia', domain: 'amazon.sa', currencyCode: 'SAR', currencySymbol: 'SAR', platform: 'amazon', locale: 'ar-SA' },
  { code: 'SG', label: 'Singapore', domain: 'amazon.sg', currencyCode: 'SGD', currencySymbol: 'SGD', platform: 'amazon', locale: 'en-SG' },
  { code: 'TR', label: 'Turkey', domain: 'amazon.com.tr', currencyCode: 'TRY', currencySymbol: 'TRY', platform: 'amazon', locale: 'tr-TR' },
  { code: 'NL', label: 'Netherlands', domain: 'amazon.nl', currencyCode: 'EUR', currencySymbol: 'EUR', platform: 'amazon', locale: 'nl-NL' },
  { code: 'PL', label: 'Poland', domain: 'amazon.pl', currencyCode: 'PLN', currencySymbol: 'PLN', platform: 'amazon', locale: 'pl-PL' },
  { code: 'SE', label: 'Sweden', domain: 'amazon.se', currencyCode: 'SEK', currencySymbol: 'SEK', platform: 'amazon', locale: 'sv-SE' },
  { code: 'BE', label: 'Belgium', domain: 'amazon.com.be', currencyCode: 'EUR', currencySymbol: 'EUR', platform: 'amazon', locale: 'nl-BE' },
  { code: 'CN', label: 'China', domain: 'amazon.cn', currencyCode: 'CNY', currencySymbol: 'CNY', platform: 'local_fallback', locale: 'zh-CN' },
];

export const SUPPORTED_COUNTRIES = SUPPORTED_COUNTRY_CONFIGS.map((entry) => entry.code);
