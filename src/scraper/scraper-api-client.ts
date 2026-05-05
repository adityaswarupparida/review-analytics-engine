import { config } from "../config.js";
import type { AmazonProduct, AmazonSearchResult } from "./types.js";

// ScraperAPI structured Amazon endpoints
const BASE = "https://api.scraperapi.com/structured/amazon";

// country_code and tld per Amazon domain
const DOMAIN_PARAMS: Record<string, { country_code: string; tld: string }> = {
  "amazon.in":     { country_code: "in", tld: "in" },
  "amazon.com":    { country_code: "us", tld: "com" },
  "amazon.co.uk":  { country_code: "gb", tld: "co.uk" },
  "amazon.de":     { country_code: "de", tld: "de" },
  "amazon.co.jp":  { country_code: "jp", tld: "co.jp" },
  "amazon.ca":     { country_code: "ca", tld: "ca" },
};

function domainParams(): { country_code: string; tld: string } {
  return DOMAIN_PARAMS[config.AMAZON_DOMAIN] ?? { country_code: "in", tld: "in" };
}

// ── Internal ScraperAPI shapes ────────────────────────────────────────────────

interface SAPIProduct {
  name?: string;
  brand?: string;
  product_information?: {
    asin?: string;
    brand?: string;
    best_sellers_rank?: string[];
    customer_reviews?: { ratings_count?: number };
    price?: string;
  };
  pricing?: string | number;
  list_price?: string | number;
  average_rating?: number;
  total_reviews?: number;
  images?: string[];
  product_category?: string;
  customization_options?: {
    [key: string]: Array<{ asin?: string; value?: string; is_selected?: boolean; url?: string | null }>;
  };
}

interface SAPISearchItem {
  asin?: string;
  name?: string;
  stars?: number | string;
  total_reviews?: number | string;
  price?: string | number;
}

interface SAPISearchResponse {
  results?: SAPISearchItem[];
  organic_results?: SAPISearchItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrice(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === 0) return undefined;
  if (typeof raw === "number" && raw > 0) return raw;
  const m = String(raw).match(/[\d,.]+/);
  if (!m) return undefined;
  const val = parseFloat(m[0]!.replace(/,/g, ""));
  return val > 0 ? val : undefined;
}

function parseBsr(ranks: string[] | undefined): { rank?: number; category?: string }[] {
  if (!ranks?.length) return [];
  return ranks.map((r) => {
    // "#9,307 in Home & Kitchen (See Top 100 in Home & Kitchen)" → rank=9307, category="Home & Kitchen"
    const m = r.match(/#([\d,]+)\s+in\s+([^(]+)/i);
    if (!m) return {};
    return { rank: parseInt(m[1]!.replace(/,/g, "")), category: m[2]!.trim() };
  });
}

function extractAsinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/dp\/([A-Z0-9]{10})/);
  return m?.[1] ?? null;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ScraperAPIClient {
  private key: string;

  constructor() {
    const key = process.env.SCRAPER_API_KEY;
    if (!key) throw new Error("SCRAPER_API_KEY not set in environment");
    this.key = key;
  }

  private async get<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const { country_code, tld } = domainParams();
    const url = new URL(`${BASE}/${endpoint}`);
    url.searchParams.set("api_key", this.key);
    url.searchParams.set("country_code", country_code);
    url.searchParams.set("tld", tld);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    if (endpoint === "product") console.log(`  Scraped product ${params.ASIN}`);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ScraperAPI ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async getProduct(asin: string): Promise<AmazonProduct> {
    const data = await this.get<SAPIProduct>("product", { ASIN: asin });

    const bsr = parseBsr(data.product_information?.best_sellers_rank);

    // Extract also_bought from customization_options URLs (e.g. /dp/B0XXXXXXXX/)
    const also_bought: { asin: string; title?: string }[] = [];
    if (data.customization_options) {
      for (const opts of Object.values(data.customization_options)) {
        for (const opt of opts) {
          if (opt.is_selected) continue; // skip current variant
          const variantAsin = extractAsinFromUrl(opt.url);
          if (variantAsin && variantAsin !== asin) {
            also_bought.push({ asin: variantAsin, title: opt.value });
          }
        }
      }
    }

    // Price: try pricing, list_price, product_information.price in order
    const priceRaw = data.pricing || data.list_price || data.product_information?.price;

    return {
      asin: data.product_information?.asin ?? asin,
      title: data.name,
      brand: data.product_information?.brand ?? data.brand, // product_information.brand is the real brand
      buybox_winner: { price: { value: parsePrice(priceRaw) } },
      rating: data.average_rating,
      ratings_total: data.product_information?.customer_reviews?.ratings_count ?? data.total_reviews,
      main_image: data.images?.[0] ? { link: data.images[0]! } : undefined,
      bestsellers_rank: bsr,
      also_bought,
      keywords: data.product_category,
    };
  }


  async search(keywords: string): Promise<AmazonSearchResult[]> {
    const data = await this.get<SAPISearchResponse>("search", {
      query: keywords,
      // num_results: "15",
      s: "exact-aware-popularity-rank", // Amazon's popularity/bestseller sort
    });
    const items = data.results ?? data.organic_results ?? [];

    return items
      .filter((i) => i.asin)
      .map((i) => ({
        asin: i.asin!,
        title: i.name,
        ratings_total: typeof i.total_reviews === "string"
          ? parseInt(i.total_reviews.replace(/,/g, "")) || 0
          : i.total_reviews ?? 0,
      }));
  }
}
