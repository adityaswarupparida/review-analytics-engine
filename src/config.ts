import { z } from "zod";

const AMAZON_CATEGORIES = [
  "electronics",
  "home_kitchen",
  "sports_outdoors",
  "tools_home_improvement",
  "toys_games",
  "beauty_personal_care",
  "health_household",
  "clothing_shoes",
  "office_products",
  "pet_supplies",
] as const;

export type AmazonCategory = (typeof AMAZON_CATEGORIES)[number];

const envSchema = z.object({
  SCRAPER_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().default("review-analytics"),
  RESEND_API_KEY: z.string().optional(),
  REPORT_EMAIL_FROM: z.string().email().optional(),
  TARGET_ASIN: z.string().min(10).max(10),
  AMAZON_CATEGORY: z.enum(AMAZON_CATEGORIES).default("electronics"),
  AMAZON_DOMAIN: z.string().default("amazon.in"),
  BSR_CONSTANT_OVERRIDE: z.coerce.number().positive().optional(),
  DB_PATH: z.string().default("./data/reviews.db"),
  MAX_REVIEWS_PER_LISTING: z.coerce.number().default(1000),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

// BSR → monthly sales: sales = C / (BSR ^ 0.53)
// C values from Jungle Scout published research (~2022-2024)
export const BSR_CATEGORY_CONSTANTS: Record<AmazonCategory, number> = {
  electronics: 160_000,
  home_kitchen: 220_000,
  sports_outdoors: 180_000,
  tools_home_improvement: 140_000,
  toys_games: 200_000,
  beauty_personal_care: 190_000,
  health_household: 195_000,
  clothing_shoes: 300_000,
  office_products: 130_000,
  pet_supplies: 170_000,
};

export function getBsrConstant(category: AmazonCategory): number {
  return config.BSR_CONSTANT_OVERRIDE ?? BSR_CATEGORY_CONSTANTS[category];
}
