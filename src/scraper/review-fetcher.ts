import { AmazonInClient, normalizeAmazonInReview, type AmazonInReview } from "./amazon-client.js";
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
      await client.checkSession(); // verify session is alive before starting
      console.log("  ✓ Amazon session is active\n");
    } catch (err) {
      throw new Error(`Cookie error: ${(err as Error).message}`);
    }

    let csrfFailCount = 0;

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
          csrfFailCount++;
          console.log(`  ⚠ No reviews returned for ${listing.asin}`);
          // 3 consecutive failures = session expired
          if (csrfFailCount >= 3) {
            throw new Error(
              "Session expired — Amazon.in cookies are no longer valid. Please refresh your cookies and try again."
            );
          }
          continue;
        }

        csrfFailCount = 0;
        const rows = rawReviews.map((r: AmazonInReview) => normalizeAmazonInReview(r, listing.id));
        await bulkInsertReviews(rows);
        console.log(`  ✓ ${listing.asin}: saved ${rows.length} reviews`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`  ⚠ ${listing.asin} failed: ${msg}`);
        if (msg.includes("Session expired") || msg.includes("cookies")) {
          console.error("  Stopping — re-login required: bun run test/login-amazon-in.ts");
          throw err;
        }
      }
    }

    console.log("\n✅ All reviews scraped.");
  }
}
