import {
  RainforestClient,
  type RainforestProduct,
  type RainforestBestseller,
} from "./rainforest-client.js";
import { createRun, updateRunStatus, insertListing, getListingsByRun } from "../database/repository.js";
import { generateRunId } from "../database/db.js";
import { config, type AmazonCategory } from "../config.js";
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

// Extract review count — Rainforest uses different fields for different product types
function extractReviewCount(product: RainforestProduct | RainforestBestseller): number {
  return (
    ("ratings_total" in product ? product.ratings_total : undefined) ??
    ("reviews_total" in product ? (product as RainforestProduct).reviews_total : undefined) ??
    0
  );
}

function extractBsr(product: RainforestProduct): number | null {
  return product.bestsellers_rank?.[0]?.rank ?? null;
}

function extractBsrCategory(product: RainforestProduct): string | null {
  return product.bestsellers_rank?.[0]?.category ?? null;
}

// Ensure we have a usable category URL for the bestsellers endpoint.
// Rainforest accepts any Amazon category URL — browse or bestsellers format.
// We only need to ensure it's an absolute URL.
function toAbsoluteCategoryUrl(categoryLink: string): string | null {
  try {
    const url = new URL(categoryLink);
    return url.href;
  } catch {
    // Relative URL — prepend domain base
    if (categoryLink.startsWith("/")) {
      return `https://www.${config.AMAZON_DOMAIN}${categoryLink}`;
    }
    return null;
  }
}

// Extract clean product-type keywords from a title for fallback search
// e.g. "Marshall Major V On-Ear Wireless Bluetooth Headphones - Black"
//   → "on-ear wireless headphones"
function extractSearchKeywords(title: string): string {
  const lower = title.toLowerCase();
  // Strip brand names (first 1-2 words often brand), colors, model numbers
  const noise = /\b(black|white|brown|green|red|blue|gold|silver|v\d+|iv|iii|ii|i|-)\b/g;
  const cleaned = lower.replace(noise, "").replace(/\s+/g, " ").trim();
  // Take middle portion — likely to be the product type
  const words = cleaned.split(" ").slice(1, 6);
  return words.join(" ");
}

function productToListing(
  product: RainforestProduct,
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
  private client: RainforestClient;

  constructor() {
    this.client = new RainforestClient();
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

    // Step 1: Try bestsellers from the product's own subcategory
    let competitors = await this.fromBestsellers(targetProduct, targetAsin);

    // Step 2: Fall back to filtered keyword search if bestsellers didn't yield enough
    if (competitors.length < 9) {
      console.log(
        `  ⚠ Only ${competitors.length} from bestsellers, falling back to keyword search...`
      );
      const existing = new Set(competitors.map((c) => c.asin));
      existing.add(targetAsin);
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

  private async fromBestsellers(
    product: RainforestProduct,
    targetAsin: string
  ): Promise<{ asin: string; title: string }[]> {
    // Find the most specific subcategory URL from BSR data
    const ranks = product.bestsellers_rank ?? [];
    const subcategoryLink = ranks
      .slice() // most specific = last entry
      .reverse()
      .map((r) => r.link)
      .filter(Boolean)[0];

    if (!subcategoryLink) {
      console.log("  No subcategory link found in BSR data, skipping bestsellers lookup");
      return [];
    }

    const bestsellersUrl = toAbsoluteCategoryUrl(subcategoryLink) ?? subcategoryLink;
    console.log(`\n🏆 Fetching bestsellers from subcategory...`);
    console.log(`  URL: ${bestsellersUrl}`);

    try {
      const bestsellers = await this.client.getBestsellers(bestsellersUrl);
      console.log(`  Found ${bestsellers.length} bestsellers`);

      return this.filterAndDedupe(
        bestsellers
          .filter((b) => b.asin !== targetAsin)
          .filter((b) => !isAccessory(b.title ?? ""))
          .map((b) => ({ asin: b.asin, title: b.title ?? "", brand: b.brand ?? "" })),
        product.brand ?? ""
      );
    } catch (err) {
      console.warn(`  ⚠ Bestsellers fetch failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async fromKeywordSearch(
    product: RainforestProduct,
    exclude: Set<string>
  ): Promise<{ asin: string; title: string }[]> {
    const keywords = extractSearchKeywords(product.title ?? "");
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
