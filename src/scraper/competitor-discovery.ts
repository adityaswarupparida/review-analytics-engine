import { ScraperAPIClient } from "./scraper-api-client.js";
import type { AmazonProduct } from "./types.js";
import { createRun, updateRunStatus, insertListing, getListingsByRun } from "../database/repository.js";
import { generateRunId } from "../database/db.js";
import { type AmazonCategory } from "../config.js";
import type { NewListing } from "../database/schema.js";

// Keywords that indicate an accessory, not a product
const ACCESSORY_KEYWORDS = [
  "replacement", "earpads", "ear pads", "ear pad", "ear cushion",
  "case", "cover", "strap", "pouch", "holder", "stand",
  "charger", "cable", "adapter", "mount", "hook", "hanger",
  "protective", "skin", "decal", "sticker",
];

function isAccessory(title: string): boolean {
  const lower = title.toLowerCase();
  return ACCESSORY_KEYWORDS.some((kw) => lower.includes(kw));
}

function extractReviewCount(product: AmazonProduct): number {
  return product.ratings_total ?? product.reviews_total ?? 0;
}

function extractBsr(product: AmazonProduct): number | null {
  return product.bestsellers_rank?.[0]?.rank ?? null;
}

function extractBsrCategory(product: AmazonProduct): string | null {
  return product.bestsellers_rank?.[0]?.category ?? null;
}


// Extract search keywords — prefer BSR category name, fall back to cleaned title
function extractSearchKeywords(product: AmazonProduct): string {
  // Use BSR category (e.g. "Smartphones", "On-Ear Headphones") — most accurate
  const bsrCategory = product.bestsellers_rank?.[product.bestsellers_rank.length - 1]?.category;
  if (bsrCategory) return bsrCategory;

  // Fallback: strip brand + noise from title
  const title = product.title ?? product.keywords ?? "";
  const lower = title.toLowerCase();
  const noise = /\b(black|white|brown|green|red|blue|gold|silver|v\d+|iv|iii|ii|i|-)\b/g;
  const cleaned = lower.replace(noise, "").replace(/\s+/g, " ").trim();
  return cleaned.split(" ").slice(1, 5).join(" ");
}

function productToListing(
  product: AmazonProduct,
  isTarget: boolean,
  runId: string
): NewListing {
  return {
    runId,
    asin: product.asin,
    title: product.title ?? null,
    brand: product.brand ?? null,
    price: product.buybox_winner?.price?.value ?? null,
    bsr: extractBsr(product),
    bsrCategory: extractBsrCategory(product),
    ratingAvg: product.rating ?? null,
    ratingCount: extractReviewCount(product),
    isTarget,
    imageUrl: product.main_image?.link ?? null,
    url: product.link ?? null,
    scrapedAt: new Date().toISOString(),
  };
}

export class CompetitorDiscovery {
  private client: ScraperAPIClient;

  constructor() {
    this.client = new ScraperAPIClient();
  }

  async run(targetAsin: string, category: AmazonCategory): Promise<string> {
    const runId = generateRunId();
    await createRun({
      id: runId,
      targetAsin,
      category,
      status: "discovering",
      createdAt: new Date().toISOString(),
    });
    console.log(`\n🆔 Run ID: ${runId}`);

    console.log(`\n🔍 Fetching target listing: ${targetAsin}`);
    const targetProduct = await this.client.getProduct(targetAsin);
    await insertListing(productToListing(targetProduct, true, runId));
    console.log(`  ✓ Saved: ${targetProduct.title?.slice(0, 60)}`);

    // Find competitors via also_bought variants + keyword search
    const existing = new Set([targetAsin]);
    let competitors = await this.fromAlsoBought(targetProduct, existing);

    if (competitors.length < 9) {
      const fromSearch = await this.fromKeywordSearch(targetProduct, existing);
      competitors = [...competitors, ...fromSearch];
    }

    // Take top 9
    const top9 = competitors.slice(0, 9);
    console.log(`\n💾 Saving ${top9.length} competitors...`);

    for (const candidate of top9) {
      try {
        const product = await this.client.getProduct(candidate.asin);
        await insertListing(productToListing(product, false, runId));
        console.log(`  ✓ ${product.asin}: ${product.title?.slice(0, 55)}`);
      } catch (err) {
        console.warn(`  ⚠ Skipping ${candidate.asin}: ${(err as Error).message}`);
      }
    }

    await updateRunStatus(runId, "scraping");
    const all = await getListingsByRun(runId);
    console.log(`\n✅ Discovery complete. ${all.length} listings saved under run ${runId}.`);
    return runId;
  }

  private async fromAlsoBought(
    product: AmazonProduct,
    exclude: Set<string>
  ): Promise<{ asin: string; title: string }[]> {
    const variants = (product.also_bought ?? [])
      .filter((v) => !exclude.has(v.asin))
      .map((v) => ({ asin: v.asin, title: v.title ?? "" }));

    variants.forEach((v) => exclude.add(v.asin));
    return variants.slice(0, 9);
  }

  private async fromKeywordSearch(
    product: AmazonProduct,
    exclude: Set<string>
  ): Promise<{ asin: string; title: string }[]> {
    const keywords = extractSearchKeywords(product);
    console.log(`  Searching: "${keywords}"`);

    const results = await this.client.search(keywords);
    return this.filterAndDedupe(
      results
        .filter((r) => !exclude.has(r.asin))
        .filter((r) => !isAccessory(r.title ?? ""))
        .map((r) => ({ asin: r.asin, title: r.title ?? "", brand: "" })),
      product.brand ?? ""
    );
  }

  // Remove duplicates: keep only 1 result per brand (highest review count first)
  private filterAndDedupe(
    candidates: { asin: string; title: string; brand: string }[],
    targetBrand: string
  ): { asin: string; title: string }[] {
    const seen = new Set<string>();
    const result: { asin: string; title: string }[] = [];

    for (const c of candidates) {
      // Allow max 2 results from the target brand (color variants etc)
      const brandKey = c.brand.toLowerCase() || c.title.split(" ")[0]?.toLowerCase() || c.asin;
      const isTargetBrand = brandKey === targetBrand.toLowerCase();
      const brandCount = [...seen].filter((k) => k.startsWith(brandKey)).length;

      if (isTargetBrand && brandCount >= 2) continue;
      if (!isTargetBrand && seen.has(brandKey)) continue;

      seen.add(`${brandKey}:${result.length}`);
      result.push({ asin: c.asin, title: c.title });
    }

    return result;
  }
}
