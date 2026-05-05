import { config } from "../config.js";

const BASE_URL = "https://api.rainforestapi.com/request";

// Rainforest API response shapes (partial — only fields we use)
export interface RainforestProduct {
  asin: string;
  title?: string;
  brand?: string;
  buybox_winner?: { price?: { value?: number }; currency?: string };
  rating?: number;
  ratings_total?: number;
  reviews_total?: number;
  main_image?: { link?: string };
  link?: string;
  bestsellers_rank?: { rank?: number; category?: string; link?: string }[];
  also_bought?: { asin: string; title?: string }[];
  keywords?: string;
}

export interface RainforestBestseller {
  rank?: number;
  asin: string;
  title?: string;
  brand?: string;
  rating?: number;
  ratings_total?: number;
  price?: { value?: number };
}

export interface BestsellersResponse {
  bestsellers?: RainforestBestseller[];
}

export interface RainforestReview {
  id?: string;
  title?: string;
  body?: string;
  rating?: number;
  verified_purchase?: boolean;
  date?: { raw?: string; utc?: string };
  helpful_votes?: number;
}

export interface RainforestSearchResult {
  asin: string;
  title?: string;
  ratings_total?: number;
}

export interface ProductResponse {
  product: RainforestProduct;
}

export interface ReviewsResponse {
  reviews: RainforestReview[];
  pagination?: { total_pages?: number };
}

export interface SearchResponse {
  search_results?: RainforestSearchResult[];
  organic_results?: RainforestSearchResult[];
}

// Simple token-bucket rate limiter
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillRate: number // tokens per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
      await Bun.sleep(Math.ceil(waitMs));
    }
  }
}

export class RainforestClient {
  private bucket: TokenBucket;

  constructor(private apiKey: string = config.RAINFOREST_API_KEY) {
    this.bucket = new TokenBucket(config.RAINFOREST_RATE_LIMIT, config.RAINFOREST_RATE_LIMIT);
  }

  async getProduct(asin: string): Promise<RainforestProduct> {
    const data = await this.request<ProductResponse>({ type: "product", asin });
    return data.product;
  }

  async getBestsellers(categoryUrl: string): Promise<RainforestBestseller[]> {
    const data = await this.request<BestsellersResponse>({
      type: "bestsellers",
      url: categoryUrl,
    });
    return data.bestsellers ?? [];
  }

  async getReviews(asin: string, page: number): Promise<ReviewsResponse> {
    return this.request<ReviewsResponse>({ type: "reviews", asin, page: String(page) });
  }

  async search(keywords: string, page = 1): Promise<RainforestSearchResult[]> {
    const data = await this.request<SearchResponse>({
      type: "search",
      search_term: keywords,
      page: String(page),
    });
    return data.search_results ?? data.organic_results ?? [];
  }

  private async request<T>(params: Record<string, string>): Promise<T> {
    await this.bucket.acquire();

    const url = new URL(BASE_URL);
    url.searchParams.set("api_key", this.apiKey);
    // Skip amazon_domain when url param is present — the url itself defines the domain
    if (!params["url"]) {
      url.searchParams.set("amazon_domain", config.AMAZON_DOMAIN);
    }
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url.toString());

      if (res.ok) {
        return res.json() as Promise<T>;
      }

      const body = await res.text();

      if (res.status === 429 || res.status === 503) {
        const backoff = 2000 * attempt;
        const reason = res.status === 429 ? "Rate limited" : "Service unavailable";
        console.warn(`  ⏳ ${reason}, waiting ${backoff / 1000}s (attempt ${attempt}/3)`);
        await Bun.sleep(backoff);
        continue;
      }

      throw new Error(`Rainforest API ${res.status}: ${body}`);
    }

    throw new Error("Max retries exceeded — Rainforest API may be temporarily down, try again later");
  }
}
