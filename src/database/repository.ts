import { eq, sql, desc, and, inArray } from "drizzle-orm";
import { db, getLatestRunId } from "./db.js";
import {
  runs,
  listings,
  reviews,
  purchaseCriteria,
  revenueEstimates,
  analysisBatches,
  type NewRun,
  type Run,
  type NewListing,
  type NewReview,
  type NewPurchaseCriterion,
  type NewRevenueEstimate,
  type NewAnalysisBatch,
  type Listing,
  type Review,
  type PurchaseCriterion,
  type RevenueEstimate,
  type AnalysisBatch,
} from "./schema.js";

// ── Runs ──────────────────────────────────────────────────────────────────────

export async function createRun(data: NewRun): Promise<Run> {
  await db.insert(runs).values(data);
  const row = await db.query.runs.findFirst({ where: eq(runs.id, data.id) });
  if (!row) throw new Error(`Failed to create run ${data.id}`);
  return row;
}

export async function updateRunStatus(
  runId: string,
  status: Run["status"]
): Promise<void> {
  await db.update(runs).set({ status }).where(eq(runs.id, runId));
}

export async function getLatestRun(): Promise<Run | undefined> {
  return db.query.runs.findFirst({ orderBy: [desc(runs.createdAt)] });
}

export async function getAllRuns(): Promise<Run[]> {
  return db.query.runs.findMany({ orderBy: [desc(runs.createdAt)] });
}

// Resolve run ID — use provided or fall back to latest
export async function resolveRunId(runId?: string): Promise<string> {
  if (runId) return runId;
  const latest = getLatestRunId();
  if (!latest) throw new Error("No runs found. Run `discover` first.");
  return latest;
}

// ── Listings ──────────────────────────────────────────────────────────────────

export async function insertListing(data: NewListing): Promise<Listing> {
  const result = await db.insert(listings).values(data).returning();
  const row = result[0];
  if (!row) throw new Error(`Failed to insert listing ${data.asin}`);
  return row;
}

export async function getListingsByRun(runId: string): Promise<Listing[]> {
  return db.query.listings.findMany({
    where: eq(listings.runId, runId),
    orderBy: [listings.isTarget],
  });
}

export async function getListingByAsin(
  asin: string,
  runId: string
): Promise<Listing | undefined> {
  return db.query.listings.findFirst({
    where: and(eq(listings.asin, asin), eq(listings.runId, runId)),
  });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function bulkInsertReviews(rows: NewReview[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.insert(reviews).values(chunk).onConflictDoNothing();
  }
}

export async function getReviewsBatch(
  listingId: number,
  offset: number,
  limit: number
): Promise<Review[]> {
  return db.query.reviews.findMany({
    where: eq(reviews.listingId, listingId),
    offset,
    limit,
    orderBy: [reviews.id],
  });
}

export async function countReviews(listingId: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(reviews)
    .where(eq(reviews.listingId, listingId));
  return result[0]?.count ?? 0;
}

export async function getReviewTimelineByListing(
  listingId: number
): Promise<{ month: string; count: number }[]> {
  const rows = await db
    .select({
      month: sql<string>`strftime('%Y-%m', date)`,
      count: sql<number>`count(*)`,
    })
    .from(reviews)
    .where(eq(reviews.listingId, listingId))
    .groupBy(sql`strftime('%Y-%m', date)`)
    .orderBy(sql`strftime('%Y-%m', date)`);
  return rows.map((r) => ({ month: r.month ?? "unknown", count: r.count }));
}

// ── Purchase Criteria ─────────────────────────────────────────────────────────

export async function replaceCriteria(
  listingId: number,
  rows: NewPurchaseCriterion[]
): Promise<void> {
  await db.delete(purchaseCriteria).where(eq(purchaseCriteria.listingId, listingId));
  if (rows.length > 0) {
    await db.insert(purchaseCriteria).values(rows);
  }
}

export async function getCriteriaByListing(listingId: number): Promise<PurchaseCriterion[]> {
  return db.query.purchaseCriteria.findMany({
    where: eq(purchaseCriteria.listingId, listingId),
    orderBy: [desc(purchaseCriteria.frequency)],
  });
}

export async function getTopCriteriaForRun(
  runId: string,
  limit = 10
): Promise<{ criterion: string; totalFrequency: number; avgSentiment: number }[]> {
  const runListings = await getListingsByRun(runId);
  const listingIds = runListings.map((l) => l.id);
  if (listingIds.length === 0) return [];

  const rows = await db
    .select({
      criterion: purchaseCriteria.criterion,
      totalFrequency: sql<number>`sum(frequency)`,
      avgSentiment: sql<number>`avg(sentiment_avg)`,
    })
    .from(purchaseCriteria)
    .where(inArray(purchaseCriteria.listingId, listingIds))
    .groupBy(purchaseCriteria.criterion)
    .orderBy(desc(sql`sum(frequency)`))
    .limit(limit);

  return rows.map((r) => ({
    criterion: r.criterion,
    totalFrequency: r.totalFrequency,
    avgSentiment: r.avgSentiment ?? 0,
  }));
}

// ── Revenue Estimates ─────────────────────────────────────────────────────────

export async function upsertRevenueEstimate(row: NewRevenueEstimate): Promise<void> {
  await db
    .insert(revenueEstimates)
    .values(row)
    .onConflictDoUpdate({
      target: revenueEstimates.listingId,
      set: {
        bsr: row.bsr,
        categoryConst: row.categoryConst,
        salesPerMonth: row.salesPerMonth,
        price: row.price,
        revenuePerMonth: row.revenuePerMonth,
        estimatedAt: row.estimatedAt,
      },
    });
}

export async function getRevenueEstimatesForRun(
  runId: string
): Promise<(RevenueEstimate & { listing: Listing })[]> {
  const runListings = await getListingsByRun(runId);
  const listingIds = runListings.map((l) => l.id);
  if (listingIds.length === 0) return [];

  const estimates = await db.query.revenueEstimates.findMany({
    where: inArray(revenueEstimates.listingId, listingIds),
    with: { listing: true },
  });
  return estimates as (RevenueEstimate & { listing: Listing })[];
}

// ── Analysis Batches ──────────────────────────────────────────────────────────

export async function insertBatch(row: NewAnalysisBatch): Promise<void> {
  await db.insert(analysisBatches).values(row).onConflictDoNothing();
}

export async function getBatchesForListing(listingId: number): Promise<AnalysisBatch[]> {
  return db.query.analysisBatches.findMany({
    where: eq(analysisBatches.listingId, listingId),
    orderBy: [analysisBatches.batchIndex],
  });
}

export async function batchExists(listingId: number, batchIndex: number): Promise<boolean> {
  const row = await db.query.analysisBatches.findFirst({
    where: and(
      eq(analysisBatches.listingId, listingId),
      eq(analysisBatches.batchIndex, batchIndex)
    ),
  });
  return row !== undefined;
}

export async function getSentimentHeatmapForRun(
  runId: string
): Promise<{ asin: string; title: string | null; criterion: string; sentimentAvg: number }[]> {
  const runListings = await getListingsByRun(runId);
  const listingIds = runListings.map((l) => l.id);
  if (listingIds.length === 0) return [];

  const rows = await db
    .select({
      asin: listings.asin,
      title: listings.title,
      criterion: purchaseCriteria.criterion,
      sentimentAvg: purchaseCriteria.sentimentAvg,
    })
    .from(purchaseCriteria)
    .innerJoin(listings, eq(purchaseCriteria.listingId, listings.id))
    .where(inArray(purchaseCriteria.listingId, listingIds));

  return rows.map((r) => ({ ...r, sentimentAvg: r.sentimentAvg ?? 0 }));
}
