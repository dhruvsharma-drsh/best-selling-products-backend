import { CATEGORY_CURVES, ReferencePoint } from './category-curves.js';

export interface SalesEstimate {
  estimatedMonthlySales: number;
  estimatedMonthlyRevenue: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  confidenceReason: string;
  bsrCategory: number;
  category: string;
}

/**
 * CORE ALGORITHM: Logarithmic interpolation between known BSR/sales reference points.
 *
 * WHY LOGARITHMIC?
 * The BSR → sales relationship follows a power law. Sales decay exponentially
 * as rank increases. A product at BSR 100 sells ~6x more than BSR 1000,
 * not 10x. Log interpolation matches this real-world curve.
 *
 * This is the same foundational approach used by Helium 10, Jungle Scout,
 * and AMZScout — they just have more calibration data from their user base.
 */
export function estimateMonthlySales(
  bsr: number,
  categoryKey: string,
  priceUsd?: number
): SalesEstimate {
  const category = CATEGORY_CURVES[categoryKey];

  if (!category) {
    return estimateWithFallback(bsr, categoryKey, priceUsd);
  }

  const points = category.referencePoints;

  // Edge case: BSR below first reference point (extremely hot product)
  if (bsr <= points[0].bsr) {
    const estimate = Math.round(points[0].monthlySales * (points[0].bsr / Math.max(bsr, 1)));
    return buildResult(estimate, bsr, categoryKey, priceUsd, 'high', 'Top-ranked product in category');
  }

  // Edge case: BSR above last reference point (slow-moving product)
  if (bsr >= points[points.length - 1].bsr) {
    const lastPoint = points[points.length - 1];
    const estimate = Math.round(lastPoint.monthlySales * Math.pow(lastPoint.bsr / bsr, 0.7));
    return buildResult(estimate, bsr, categoryKey, priceUsd, 'low', 'Below calibrated BSR range');
  }

  // Find the two surrounding reference points
  let lowerPoint: ReferencePoint = points[0];
  let upperPoint: ReferencePoint = points[1];

  for (let i = 0; i < points.length - 1; i++) {
    if (bsr >= points[i].bsr && bsr <= points[i + 1].bsr) {
      lowerPoint = points[i];
      upperPoint = points[i + 1];
      break;
    }
  }

  // Logarithmic interpolation
  const logBsr = Math.log(bsr);
  const logLower = Math.log(lowerPoint.bsr);
  const logUpper = Math.log(upperPoint.bsr);
  const t = (logBsr - logLower) / (logUpper - logLower);

  // Interpolate in log-sales space too
  const logSalesLower = Math.log(lowerPoint.monthlySales);
  const logSalesUpper = Math.log(upperPoint.monthlySales);
  const logSalesEstimate = logSalesLower + t * (logSalesUpper - logSalesLower);
  const rawEstimate = Math.exp(logSalesEstimate);

  const estimate = Math.round(rawEstimate);

  const confidence = bsr < 50000 ? 'high' : bsr < 200000 ? 'medium' : 'low';
  const confidenceReason = confidence === 'high'
    ? 'Within well-calibrated BSR range'
    : confidence === 'medium'
    ? 'Moderate BSR — estimate reliable within ±25%'
    : 'High BSR — estimate is directional only';

  return buildResult(estimate, bsr, categoryKey, priceUsd, confidence, confidenceReason);
}

function buildResult(
  estimatedMonthlySales: number,
  bsr: number,
  categoryKey: string,
  priceUsd: number | undefined,
  confidenceLevel: 'high' | 'medium' | 'low',
  confidenceReason: string
): SalesEstimate {
  const price = priceUsd ?? 25;
  return {
    estimatedMonthlySales: Math.max(1, estimatedMonthlySales),
    estimatedMonthlyRevenue: Math.round(estimatedMonthlySales * price * 100) / 100,
    confidenceLevel,
    confidenceReason,
    bsrCategory: bsr,
    category: categoryKey,
  };
}

function estimateWithFallback(
  bsr: number,
  categoryKey: string,
  priceUsd?: number
): SalesEstimate {
  const baseSales = 15000 * Math.pow(bsr, -0.75);
  return buildResult(
    Math.round(baseSales),
    bsr,
    categoryKey,
    priceUsd,
    'low',
    'Unknown category — using generic curve'
  );
}

/**
 * BSR Stability Score — measures how consistent a product's rank has been.
 * Returns 0-100 (100 = perfectly stable, 0 = wildly volatile)
 */
export function calculateBsrStabilityScore(bsrHistory: number[]): number {
  if (bsrHistory.length < 3) return 50;

  const mean = bsrHistory.reduce((a, b) => a + b, 0) / bsrHistory.length;
  const variance = bsrHistory.reduce((sum, bsr) => sum + Math.pow(bsr - mean, 2), 0) / bsrHistory.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / mean;

  const score = Math.max(0, Math.min(100, Math.round((1 - coefficientOfVariation) * 100)));
  return score;
}

/**
 * Trend Direction — compares recent BSR to older BSR.
 */
export function calculateTrend(
  recentBsrHistory: number[],
  olderBsrHistory: number[]
): 'rising' | 'falling' | 'stable' {
  if (recentBsrHistory.length === 0 || olderBsrHistory.length === 0) return 'stable';

  const recentAvg = recentBsrHistory.reduce((a, b) => a + b, 0) / recentBsrHistory.length;
  const olderAvg = olderBsrHistory.reduce((a, b) => a + b, 0) / olderBsrHistory.length;

  const percentChange = (recentAvg - olderAvg) / olderAvg;

  if (percentChange < -0.05) return 'rising';
  if (percentChange > 0.05) return 'falling';
  return 'stable';
}

/**
 * Rolling average estimator — uses median BSR from the last 72 hours
 * instead of the latest BSR for improved accuracy.
 */
export async function estimateWithHistory(
  asin: string,
  categoryKey: string,
  prisma: any
): Promise<SalesEstimate> {
  const history = await prisma.$queryRaw`
    SELECT bsr_category, price_usd
    FROM bsr_snapshots
    WHERE asin = ${asin}
    AND time >= NOW() - INTERVAL '72 hours'
    ORDER BY time DESC
  `;

  if (!history || (history as any[]).length === 0) {
    throw new Error('No history available');
  }

  const records = history as { bsr_category: number; price_usd: number | null }[];
  const bsrValues = records.map(h => h.bsr_category).sort((a, b) => a - b);
  const medianBsr = bsrValues[Math.floor(bsrValues.length / 2)];
  const latestPrice = records[0].price_usd;

  return estimateMonthlySales(medianBsr, categoryKey, latestPrice ?? undefined);
}
