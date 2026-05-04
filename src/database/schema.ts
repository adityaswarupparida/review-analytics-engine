import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),           // e.g. "2026-05-04T12-30-00"
  targetAsin: text("target_asin").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull().default("discovering"), // discovering | scraping | analyzing | complete
  createdAt: text("created_at").notNull(),
});

export const listings = sqliteTable(
  "listings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").references(() => runs.id),
    asin: text("asin").notNull(),
    title: text("title"),
    brand: text("brand"),
    price: real("price"),
    bsr: integer("bsr"),
    bsrCategory: text("bsr_category"),
    ratingAvg: real("rating_avg"),
    ratingCount: integer("rating_count"),
    isTarget: integer("is_target", { mode: "boolean" }).default(false),
    imageUrl: text("image_url"),
    url: text("url"),
    scrapedAt: text("scraped_at"),
  },
  (t) => [
    index("listings_run_idx").on(t.runId),
    index("listings_asin_idx").on(t.asin),
  ]
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id),
    reviewId: text("review_id"),
    title: text("title"),
    body: text("body"),
    rating: real("rating"),
    verified: integer("verified", { mode: "boolean" }),
    date: text("date"),
    helpfulVotes: integer("helpful_votes"),
  },
  (t) => [
    index("reviews_listing_idx").on(t.listingId),
    index("reviews_date_idx").on(t.date),
    uniqueIndex("reviews_listing_review_idx").on(t.listingId, t.reviewId),
  ]
);

export const purchaseCriteria = sqliteTable(
  "purchase_criteria",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id),
    criterion: text("criterion").notNull(),
    frequency: integer("frequency").notNull(),
    sentimentAvg: real("sentiment_avg"),
    topComplaints: text("top_complaints"),
    topPositives: text("top_positives"),
  },
  (t) => [index("criteria_listing_idx").on(t.listingId)]
);

export const revenueEstimates = sqliteTable("revenue_estimates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listingId: integer("listing_id")
    .notNull()
    .references(() => listings.id)
    .unique(),
  bsr: integer("bsr"),
  categoryConst: real("category_const"),
  salesPerMonth: real("sales_per_month"),
  price: real("price"),
  revenuePerMonth: real("revenue_per_month"),
  estimatedAt: text("estimated_at"),
});

export const analysisBatches = sqliteTable(
  "analysis_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id),
    batchIndex: integer("batch_index").notNull(),
    resultJson: text("result_json").notNull(),
    processedAt: text("processed_at"),
  },
  (t) => [
    index("batch_listing_idx").on(t.listingId),
    uniqueIndex("unique_batch").on(t.listingId, t.batchIndex),
  ]
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type PurchaseCriterion = typeof purchaseCriteria.$inferSelect;
export type NewPurchaseCriterion = typeof purchaseCriteria.$inferInsert;
export type RevenueEstimate = typeof revenueEstimates.$inferSelect;
export type NewRevenueEstimate = typeof revenueEstimates.$inferInsert;
export type AnalysisBatch = typeof analysisBatches.$inferSelect;
export type NewAnalysisBatch = typeof analysisBatches.$inferInsert;
