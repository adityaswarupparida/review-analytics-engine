import { getListingsByRun, upsertRevenueEstimate, resolveRunId, updateRunStatus } from "../database/repository.js";
import { config, getBsrConstant, type AmazonCategory } from "../config.js";

export function estimateMonthlySales(bsr: number, category: AmazonCategory): number {
  const C = getBsrConstant(category);
  return Math.round(C / Math.pow(bsr, 0.53));
}

export function estimateMonthlyRevenue(
  bsr: number,
  price: number,
  category: AmazonCategory
): { salesPerMonth: number; revenuePerMonth: number; categoryConst: number } {
  const C = getBsrConstant(category);
  const salesPerMonth = estimateMonthlySales(bsr, category);
  return {
    salesPerMonth,
    revenuePerMonth: Math.round(salesPerMonth * price * 100) / 100,
    categoryConst: C,
  };
}

export class RevenueEstimator {
  async estimateAll(runId?: string): Promise<void> {
    const resolvedRunId = await resolveRunId(runId);
    const runListings = await getListingsByRun(resolvedRunId);
    const category = config.AMAZON_CATEGORY;

    console.log(`\n💰 Estimating revenue for ${runListings.length} listings in run ${resolvedRunId}...`);

    for (const listing of runListings) {
      if (!listing.bsr) {
        console.warn(`  ⚠ ${listing.asin}: no BSR, skipping`);
        continue;
      }

      const price = listing.price ?? 0;
      const estimate = estimateMonthlyRevenue(listing.bsr, price, category);

      await upsertRevenueEstimate({
        listingId: listing.id,
        bsr: listing.bsr,
        categoryConst: estimate.categoryConst,
        salesPerMonth: estimate.salesPerMonth,
        price,
        revenuePerMonth: estimate.revenuePerMonth,
        estimatedAt: new Date().toISOString(),
      });

      console.log(
        `  ✓ ${listing.asin}: BSR #${listing.bsr.toLocaleString()} → ` +
        `~${estimate.salesPerMonth.toLocaleString()} units/mo → ` +
        `₹${estimate.revenuePerMonth.toLocaleString()}/mo`
      );
    }

    console.log("\n✅ Revenue estimation complete.");
  }
}
