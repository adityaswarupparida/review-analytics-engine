import fs from "fs";
import { config } from "../config.js";

const DELAY_MS = 1500;

// Marketplace IDs per Amazon domain
const MARKETPLACE_IDS: Record<string, string> = {
  "amazon.in":     "A21TJRUUN4KGV",
  "amazon.com":    "ATVPDKIKX0DER",
  "amazon.co.uk":  "A1F83G8C2ARO7P",
  "amazon.de":     "A1PA6795UKMFR9",
  "amazon.co.jp":  "A1VC38T7YXB528",
  "amazon.com.au": "A39IBJ37TRP1C6",
  "amazon.ca":     "A2EUQ1WTGCTBG2",
};

// Accept-Language header per domain
const ACCEPT_LANGUAGE: Record<string, string> = {
  "amazon.in":  "en-IN,en;q=0.9",
  "amazon.com": "en-US,en;q=0.9",
  "amazon.co.uk": "en-GB,en;q=0.9",
  "amazon.de":  "de-DE,de;q=0.9",
};

function getDomain(): string {
  return `www.${config.AMAZON_DOMAIN}`;
}

function getMarketplaceId(): string {
  return MARKETPLACE_IDS[config.AMAZON_DOMAIN] ?? "ATVPDKIKX0DER";
}

function getCookiesPath(): string {
  const domainSlug = config.AMAZON_DOMAIN.replace(/\./g, "-");
  return `./data/amazon-${domainSlug}-cookies.json`;
}

function getAcceptLanguage(): string {
  return ACCEPT_LANGUAGE[config.AMAZON_DOMAIN] ?? "en-US,en;q=0.9";
}

export interface AmazonInReview {
  reviewId: string | null;
  title: string | null;
  body: string | null;
  rating: number | null;
  date: string | null;
  verified: boolean | null;
  helpfulVotes: number | null;
}

interface ParsedPage {
  reviews: AmazonInReview[];
  nextToken: string | null;
  nextPage: string | null;
}

export class AmazonInClient {
  private cookieHeader: string;
  private csrfCache = new Map<string, string>(); // asin → csrf

  constructor() {
    this.cookieHeader = this.loadCookies();
  }

  private loadCookies(): string {
    const cookiesPath = getCookiesPath();
    if (!fs.existsSync(cookiesPath)) {
      throw new Error(
        `No cookies found at ${cookiesPath}. Run: bun run test/login-amazon-in.ts`
      );
    }
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8")) as {
      name: string;
      value: string;
    }[];
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private pageHeaders(): Record<string, string> {
    return {
      Cookie: this.cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": getAcceptLanguage(),
      Connection: "keep-alive",
    };
  }

  private ajaxHeaders(csrf: string, referer: string): Record<string, string> {
    return {
      Cookie: this.cookieHeader,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html, */*",
      "Accept-Language": getAcceptLanguage(),
      "Content-Type": "application/x-www-form-urlencoded",
      "anti-csrftoken-a2z": csrf,
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
      Connection: "keep-alive",
    };
  }

  async getCsrf(asin: string): Promise<string | null> {
    if (this.csrfCache.has(asin)) return this.csrfCache.get(asin)!;

    const url = `https://${getDomain()}/product-reviews/${asin}?reviewerType=all_reviews&sortBy=recent`;
    const res = await fetch(url, { headers: this.pageHeaders() });
    const html = await res.text();

    if (res.url.includes("/ap/signin")) {
      throw new Error("Session expired — run: bun run test/login-amazon-in.ts");
    }

    const match = html.match(/"reviewsCsrfToken"\s*:\s*"([^"]+)"/);
    if (!match) return null;

    const csrf = decodeURIComponent(match[1]!);
    this.csrfCache.set(asin, csrf);
    return csrf;
  }

  private parseStreamingResponse(raw: string): ParsedPage {
    const chunks = raw.split("&&&").map((c) => c.trim()).filter(Boolean);
    let reviewHtml = "";
    let paginationHtml = "";

    for (const chunk of chunks) {
      try {
        const parsed = JSON.parse(chunk) as [string, string, string?];
        if (parsed.length < 3 || !parsed[2]) continue;
        const [action, selector, content] = parsed;

        if (action === "append" && selector === "#cm_cr-review_list") {
          reviewHtml += content;
        }
        if (
          action === "update" &&
          selector === "#cm_cr-pagination_bar" &&
          content!.length > 0
        ) {
          paginationHtml = content!;
        }
      } catch {}
    }

    // Extract reviews from decoded HTML
    const reviews: AmazonInReview[] = [];
    const reviewBlocks = reviewHtml.match(
      /<li[^>]+data-hook="review"[\s\S]*?<\/li>/g
    ) ?? [];

    for (const block of reviewBlocks) {
      const idMatch = block.match(/id="(R[A-Z0-9]+)"\s+data-hook="review"/);
      const titleMatch = block.match(
        /data-hook="review-title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/
      );
      const bodyMatch = block.match(
        /data-hook="review-body"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/
      );
      const ratingMatch = block.match(/a-star-(\d)\s/);
      const dateMatch = block.match(/data-hook="review-date"[^>]*>([\s\S]*?)<\/span>/);
      const verifiedMatch = block.includes('data-hook="avp-badge"');
      const helpfulMatch = block.match(/(\d+) (?:people|person) found/);

      reviews.push({
        reviewId: idMatch?.[1] ?? null,
        title: titleMatch?.[1]?.trim().replace(/<[^>]+>/g, "") ?? null,
        body: bodyMatch?.[1]?.trim().replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "") ?? null,
        rating: ratingMatch ? parseInt(ratingMatch[1]!) : null,
        date: dateMatch?.[1]?.trim() ?? null,
        verified: verifiedMatch,
        helpfulVotes: helpfulMatch ? parseInt(helpfulMatch[1]!) : null,
      });
    }

    // Extract nextPageToken from pagination HTML
    let nextToken: string | null = null;
    let nextPage: string | null = null;

    const paramMatch = paginationHtml.match(/data-reviews-state-param="([^"]+)"/);
    if (paramMatch) {
      try {
        const decoded = paramMatch[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        const params = JSON.parse(decoded) as {
          nextPageToken?: string;
          pageNumber?: string;
        };
        nextToken = params.nextPageToken ?? null;
        nextPage = params.pageNumber ?? null;
      } catch {}
    }

    return { reviews, nextToken, nextPage };
  }

  private async ajaxPost(
    asin: string,
    csrf: string,
    pageNumber: string,
    nextPageToken?: string
  ): Promise<string> {
    const referer = `https://${getDomain()}/product-reviews/${asin}?reviewerType=all_reviews`;
    const body = new URLSearchParams({
      asin,
      pageNumber,
      sortBy: "recent",
      reviewerType: "all_reviews",
      pageType: "CustomerReviews",
      deviceType: "desktop",
      canShowIntHeader: "true",
      marketplaceId: getMarketplaceId(),
      ...(nextPageToken ? { nextPageToken, shouldAppend: "true" } : {}),
    });

    const res = await fetch(
      `https://${getDomain()}/portal/customer-reviews/ajax/reviews/get/`,
      {
        method: "POST",
        headers: this.ajaxHeaders(csrf, referer),
        body: body.toString(),
      }
    );

    return res.text();
  }

  async scrapeReviews(asin: string, maxReviews: number): Promise<AmazonInReview[]> {
    const csrf = await this.getCsrf(asin);
    if (!csrf) {
      console.warn(`  ⚠ No CSRF for ${asin} on amazon.in — product may not be listed there`);
      return [];
    }

    const allReviews: AmazonInReview[] = [];
    let pageNumber = "1";
    let nextPageToken: string | undefined = undefined;
    let page = 0;

    while (allReviews.length < maxReviews) {
      page++;
      const raw = await this.ajaxPost(asin, csrf, pageNumber, nextPageToken);
      const { reviews, nextToken, nextPage } = this.parseStreamingResponse(raw);

      allReviews.push(...reviews);
      console.log(
        `    📄 Page ${page}: +${reviews.length} reviews (total: ${allReviews.length}) | next token: ${nextToken ? "✓" : "none"}`
      );

      if (reviews.length === 0 || !nextToken) break;

      nextPageToken = nextToken;
      pageNumber = nextPage ?? String(parseInt(pageNumber) + 1);

      await Bun.sleep(DELAY_MS);
    }

    return allReviews.slice(0, maxReviews);
  }
}

export function normalizeAmazonInReview(
  raw: AmazonInReview,
  listingId: number
) {
  return {
    listingId,
    reviewId: raw.reviewId,
    title: raw.title,
    body: raw.body,
    rating: raw.rating,
    verified: raw.verified,
    date: raw.date,
    helpfulVotes: raw.helpfulVotes,
  };
}
