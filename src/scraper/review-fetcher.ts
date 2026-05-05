import { AmazonInClient, normalizeAmazonInReview } from "./amazon-client.js";
import {
  getListingsByRun,
  bulkInsertReviews,
  countReviews,
  resolveRunId,
} from "../database/repository.js";
import { config } from "../config.js";

export class ReviewFetcher {
  async scrapeAll(runId?: string): Promise<void> {
    const resolvedRunId = await resolveRunId(runId);
    const runListings = await getListingsByRun(resolvedRunId);

    if (runListings.length === 0) {
      throw new Error(`No listings found for run ${resolvedRunId}. Run discover first.`);
    }

    console.log(`\n📥 Scraping reviews for ${runListings.length} listings`);
    console.log(`   Max per listing: ${config.MAX_REVIEWS_PER_LISTING}`);
    console.log(`   Source: amazon.in AJAX + session cookies\n`);

    let client: AmazonInClient;
    try {
      client = new AmazonInClient();
    } catch (err) {
      console.error(`❌ ${(err as Error).message}`);
      return;
    }

    for (const listing of runListings) {
      const existing = await countReviews(listing.id);

      if (existing >= config.MAX_REVIEWS_PER_LISTING) {
        console.log(`  ⏭ ${listing.asin}: already has ${existing} reviews, skipping`);
        continue;
      }

      console.log(`\n  📦 ${listing.asin} — ${listing.title?.slice(0, 45)}`);
      console.log(`     Have: ${existing} | Target: ${config.MAX_REVIEWS_PER_LISTING}`);

      try {
        const rawReviews = await client.scrapeReviews(
          listing.asin,
          config.MAX_REVIEWS_PER_LISTING
        );

        if (rawReviews.length === 0) {
          console.log(`  ⚠ No reviews returned for ${listing.asin}`);
          continue;
        }

        const rows = rawReviews.map((r) => normalizeAmazonInReview(r, listing.id));
        await bulkInsertReviews(rows);
        console.log(`  ✓ ${listing.asin}: saved ${rows.length} reviews`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`  ⚠ ${listing.asin} failed: ${msg}`);
        if (msg.includes("Session expired")) {
          console.error("  Stopping — re-login required: bun run test/login-amazon-in.ts");
          break;
        }
      }
    }

    console.log("\n✅ All reviews scraped.");
  }
}
