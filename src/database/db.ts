import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";
import { config } from "../config.js";

const sqlite = new Database(config.DB_PATH, { create: true });

sqlite.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=OFF;
  PRAGMA synchronous=NORMAL;
`);

export const db = drizzle(sqlite, { schema });

export function initDb(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      target_asin TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovering',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT REFERENCES runs(id),
      asin TEXT NOT NULL,
      title TEXT,
      brand TEXT,
      price REAL,
      bsr INTEGER,
      bsr_category TEXT,
      rating_avg REAL,
      rating_count INTEGER,
      is_target INTEGER DEFAULT 0,
      image_url TEXT,
      url TEXT,
      scraped_at TEXT
    );

    CREATE INDEX IF NOT EXISTS listings_run_idx ON listings(run_id);
    CREATE INDEX IF NOT EXISTS listings_asin_idx ON listings(asin);

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      review_id TEXT,
      title TEXT,
      body TEXT,
      rating REAL,
      verified INTEGER,
      date TEXT,
      helpful_votes INTEGER,
      UNIQUE(listing_id, review_id)
    );

    CREATE INDEX IF NOT EXISTS reviews_listing_idx ON reviews(listing_id);
    CREATE INDEX IF NOT EXISTS reviews_date_idx ON reviews(date);

    CREATE TABLE IF NOT EXISTS purchase_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      criterion TEXT NOT NULL,
      frequency INTEGER NOT NULL,
      sentiment_avg REAL,
      top_complaints TEXT,
      top_positives TEXT
    );

    CREATE INDEX IF NOT EXISTS criteria_listing_idx ON purchase_criteria(listing_id);

    CREATE TABLE IF NOT EXISTS revenue_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL UNIQUE REFERENCES listings(id),
      bsr INTEGER,
      category_const REAL,
      sales_per_month REAL,
      price REAL,
      revenue_per_month REAL,
      estimated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS analysis_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      batch_index INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(listing_id, batch_index)
    );

    CREATE INDEX IF NOT EXISTS batch_listing_idx ON analysis_batches(listing_id);
  `);
}

export function generateRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function getLatestRunId(): string | null {
  const row = sqlite
    .query("SELECT id FROM runs ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | null;
  return row?.id ?? null;
}
