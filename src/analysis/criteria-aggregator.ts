import {
  getListingsByRun,
  getBatchesForListing,
  replaceCriteria,
  resolveRunId,
  updateRunStatus,
} from "../database/repository.js";
import type { BatchAnalysisResult } from "./review-analyzer.js";
import type { NewPurchaseCriterion } from "../database/schema.js";

interface MergedCriterion {
  criterion: string;
  frequency: number;
  sentimentSum: number;
  sentimentCount: number;
  complaints: Set<string>;
  positives: Set<string>;
}

export class CriteriaAggregator {
  async aggregateAll(runId?: string): Promise<void> {
    const resolvedRunId = await resolveRunId(runId);
    const runListings = await getListingsByRun(resolvedRunId);

    console.log(`\n📋 Aggregating criteria for ${runListings.length} listings in run ${resolvedRunId}...`);

    for (const listing of runListings) {
      await this.aggregateListing(listing.id, listing.title ?? listing.asin);
    }

    await updateRunStatus(resolvedRunId, "complete");
    console.log("\n✅ Criteria aggregation complete.");
  }

  async aggregateListing(listingId: number, title: string): Promise<void> {
    const batches = await getBatchesForListing(listingId);
    if (batches.length === 0) {
      console.log(`  ⏭ Listing ${listingId}: no batches, skipping`);
      return;
    }

    const results: BatchAnalysisResult[] = batches.map(
      (b) => JSON.parse(b.resultJson) as BatchAnalysisResult
    );

    const merged = this.mergeCriteria(results);
    const rows: NewPurchaseCriterion[] = merged.map((m) => ({
      listingId,
      criterion: m.criterion,
      frequency: m.frequency,
      sentimentAvg: m.sentimentCount > 0 ? m.sentimentSum / m.sentimentCount : null,
      topComplaints: JSON.stringify([...m.complaints].slice(0, 5)),
      topPositives: JSON.stringify([...m.positives].slice(0, 5)),
    }));

    await replaceCriteria(listingId, rows);
    console.log(`  ✓ ${title.slice(0, 45)}: ${rows.length} criteria`);
  }

  private mergeCriteria(results: BatchAnalysisResult[]): MergedCriterion[] {
    const map = new Map<string, MergedCriterion>();

    for (const result of results) {
      for (const raw of result.purchase_criteria ?? []) {
        const key = raw.criterion.toLowerCase().trim();
        const existing = map.get(key);

        if (existing) {
          existing.frequency += raw.mention_count ?? 1;
          existing.sentimentSum += raw.sentiment * (raw.mention_count ?? 1);
          existing.sentimentCount += raw.mention_count ?? 1;
          for (const c of raw.complaints ?? []) existing.complaints.add(c);
          for (const p of raw.positives ?? []) existing.positives.add(p);
        } else {
          map.set(key, {
            criterion: raw.criterion,
            frequency: raw.mention_count ?? 1,
            sentimentSum: raw.sentiment * (raw.mention_count ?? 1),
            sentimentCount: raw.mention_count ?? 1,
            complaints: new Set(raw.complaints ?? []),
            positives: new Set(raw.positives ?? []),
          });
        }
      }
    }

    return [...map.values()].sort((a, b) => b.frequency - a.frequency);
  }
}
