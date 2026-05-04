import pLimit from "p-limit";
import { RainforestClient, type RainforestReview } from "./rainforest-client.js";
import {
  getListingsByRun,
  bulkInsertReviews,
  countReviews,
  resolveRunId,
} from "../database/repository.js";
import { config } from "../config.js";
import type { NewReview, Listing } from "../database/schema.js";

function transformReview(raw: RainforestReview, listingId: number): NewReview {
  return {
    listingId,
    reviewId: raw.id ?? null,
    title: raw.title ?? null,
    body: raw.body ?? null,
    rating: raw.rating ?? null,
    verified: raw.verified_purchase ?? null,
    date: raw.date?.utc ?? raw.date?.raw ?? null,
    helpfulVotes: raw.helpful_votes ?? null,
  };
}

export class ReviewFetcher {
  private client: RainforestClient;

  constructor() {
    this.client = new RainforestClient();
  }

  async scrapeAll(runId?: string, concurrency = 3): Promise<void> {
    const resolvedRunId = await resolveRunId(runId);
    const runListings = await getListingsByRun(resolvedRunId);

    if (runListings.length === 0) {
      throw new Error(`No listings found for run ${resolvedRunId}. Run discover first.`);
    }

    console.log(`\n📥 Scraping reviews for ${runListings.length} listings in run ${resolvedRunId}...`);

    const limit = pLimit(concurrency);
    await Promise.all(
      runListings.map((listing) => limit(() => this.scrapeReviews(listing)))
    );

    console.log("\n✅ All reviews scraped.");
  }

  async scrapeReviews(listing: Listing): Promise<number> {
    const existing = await countReviews(listing.id);
    if (existing >= config.MAX_REVIEWS_PER_LISTING) {
      console.log(`  ⏭ ${listing.asin}: already has ${existing} reviews, skipping`);
      return existing;
    }

    const maxPages = Math.ceil((config.MAX_REVIEWS_PER_LISTING - existing) / 10);
    let fetched = 0;

    console.log(`\n  📄 ${listing.asin} (${listing.title?.slice(0, 40)})`);

    for (let page = 1; page <= maxPages; page++) {
      try {
        const response = await this.client.getReviews(listing.asin, page);
        const rawReviews = response.reviews ?? [];

        if (rawReviews.length === 0) {
          console.log(`    Page ${page}: no more reviews`);
          break;
        }

        const rows: NewReview[] = rawReviews.map((r) => transformReview(r, listing.id));
        await bulkInsertReviews(rows);
        fetched += rows.length;

        console.log(`    Page ${page}: +${rows.length} (total: ${existing + fetched})`);

        if (existing + fetched >= config.MAX_REVIEWS_PER_LISTING) break;
      } catch (err) {
        console.error(`    ⚠ Error on page ${page}: ${(err as Error).message}`);
        break;
      }
    }

    console.log(`  ✓ ${listing.asin}: fetched ${fetched} new reviews`);
    return existing + fetched;
  }
}
