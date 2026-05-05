import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  getListingsByRun,
  getReviewsBatch,
  countReviews,
  insertBatch,
  batchExists,
  resolveRunId,
  updateRunStatus,
} from "../database/repository.js";
import type { Review } from "../database/schema.js";

export interface BatchCriterion {
  criterion: string;
  sentiment: number;
  mention_count: number;
  complaints: string[];
  positives: string[];
}

export interface BatchAnalysisResult {
  purchase_criteria: BatchCriterion[];
  common_complaints: string[];
  standout_positives: string[];
}

const SYSTEM_PROMPT = `You are an expert Amazon product review analyst. Extract structured purchase decision intelligence from customer reviews.

Return ONLY valid JSON with this exact shape — no markdown fences, no explanation:

{
  "purchase_criteria": [
    {
      "criterion": "<1-4 words, Title Case, e.g. Battery Life>",
      "sentiment": <float -1.0 to 1.0>,
      "mention_count": <integer>,
      "complaints": ["<max 15 words each>"],
      "positives": ["<max 15 words each>"]
    }
  ],
  "common_complaints": ["<string>"],
  "standout_positives": ["<string>"]
}

Rules:
- Return ONLY valid JSON. No markdown. No explanation.
- Limit purchase_criteria to top 5 most-mentioned criteria.
- Criterion names: 1-4 words, Title Case.
- Sentiment: float between -1.0 and 1.0 (not integer).
- complaints and positives: max 3 items each.
- common_complaints and standout_positives: max 5 items each.`;

function buildUserMessage(reviewBatch: Review[], listingTitle: string): string {
  const reviewsText = reviewBatch
    .map(
      (r, i) =>
        `[Review ${i + 1}] Rating: ${r.rating ?? "?"}/5\nTitle: ${r.title ?? ""}\n${r.body ?? ""}`
    )
    .join("\n\n---\n\n");
  return `Product: "${listingTitle}"\n\nAnalyze these ${reviewBatch.length} customer reviews:\n\n${reviewsText}`;
}

export class ReviewAnalyzer {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  async analyzeAll(runId?: string, batchSize = 20): Promise<void> {
    const resolvedRunId = await resolveRunId(runId);
    const runListings = await getListingsByRun(resolvedRunId);

    console.log(`\n🧠 Analyzing reviews for ${runListings.length} listings in run ${resolvedRunId}...`);

    for (const listing of runListings) {
      await this.analyzeListing(listing.id, listing.title ?? listing.asin, batchSize);
    }

    await updateRunStatus(resolvedRunId, "analyzing");
    console.log("\n✅ Analysis complete.");
  }

  async analyzeListing(listingId: number, title: string, batchSize: number): Promise<void> {
    const total = await countReviews(listingId);
    if (total === 0) {
      console.log(`  ⏭ Listing ${listingId}: no reviews, skipping`);
      return;
    }

    const totalBatches = Math.ceil(total / batchSize);
    console.log(`\n  📊 ${title.slice(0, 40)}: ${total} reviews → ${totalBatches} batches`);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      if (await batchExists(listingId, batchIdx)) {
        process.stdout.write(".");
        continue;
      }

      const reviewBatch = await getReviewsBatch(listingId, batchIdx * batchSize, batchSize);
      if (reviewBatch.length === 0) break;

      try {
        const result = await this.analyzeBatch(reviewBatch, title);
        await insertBatch({
          listingId,
          batchIndex: batchIdx,
          resultJson: JSON.stringify(result),
          processedAt: new Date().toISOString(),
        });
        process.stdout.write("✓");
      } catch (err) {
        console.error(`\n    ⚠ Batch ${batchIdx} failed: ${(err as Error).message}`);
      }
    }

    console.log(`\n  Done listing ${listingId}`);
  }

  private async analyzeBatch(
    reviewBatch: Review[],
    listingTitle: string
  ): Promise<BatchAnalysisResult> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserMessage(reviewBatch, listingTitle) }],
    });

    const block = response.content[0];
    if (!block || block.type !== "text") throw new Error("Unexpected Claude response type");

    try {
      return JSON.parse(block.text) as BatchAnalysisResult;
    } catch {
      const reason = response.stop_reason === "max_tokens"
        ? "Response was cut off — max tokens reached"
        : "Response was not valid JSON";
      throw new Error(`Claude analysis failed (${reason}): ${block.text.slice(0, 150)}...`);
    }
  }
}
