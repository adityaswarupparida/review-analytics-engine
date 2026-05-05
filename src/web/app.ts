import { Hono } from "hono";
import {
  getListingsByRun,
  getRevenueEstimatesForRun,
  getCriteriaByListing,
  getTopCriteriaForRun,
  getReviewTimelineByListing,
  getSentimentHeatmapForRun,
  resolveRunId,
  getAllRuns,
} from "../database/repository.js";
import {
  runPipeline,
  subscribeToJob,
  getJobHistory,
  type ProgressEvent,
} from "./job-runner.js";
import { config, type AmazonCategory } from "../config.js";

const AMAZON_CATEGORIES = [
  "electronics","home_kitchen","sports_outdoors","tools_home_improvement",
  "toys_games","beauty_personal_care","health_household","clothing_shoes",
  "office_products","pet_supplies",
] as const;

const app = new Hono();

// ── Page routes ──────────────────────────────────────────────────────────────

app.get("/", async (c) => {
  const html = await Bun.file(
    new URL("./templates/home.html", import.meta.url).pathname
  ).text();
  return c.html(html);
});

app.get("/progress", async (c) => {
  const html = await Bun.file(
    new URL("./templates/progress.html", import.meta.url).pathname
  ).text();
  return c.html(html);
});

app.get("/dashboard", async (c) => {
  const html = await Bun.file(
    new URL("./templates/dashboard.html", import.meta.url).pathname
  ).text();
  return c.html(html);
});

// ── Job API ───────────────────────────────────────────────────────────────────

// POST /api/run — start a new pipeline job
app.post("/api/run", async (c) => {
  let body: { asin?: string; category?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const asin = (body.asin ?? "").trim().toUpperCase();
  const category = (body.category ?? config.AMAZON_CATEGORY) as AmazonCategory;

  if (!asin || asin.length !== 10) {
    return c.json({ error: "ASIN must be exactly 10 characters" }, 400);
  }

  if (!AMAZON_CATEGORIES.includes(category as AmazonCategory)) {
    return c.json({ error: "Invalid category" }, 400);
  }

  // Generate a jobId to track this run before the pipeline creates the real runId
  const jobId = `job-${Date.now()}`;

  // Start pipeline in background (don't await)
  runPipeline(asin, category, jobId).catch((err) =>
    console.error("Pipeline error:", err)
  );

  return c.json({ jobId });
});

// GET /api/job/:jobId/stream — SSE progress stream
app.get("/api/job/:jobId/stream", (c) => {
  const jobId = c.req.param("jobId");

  return new Response(
    new ReadableStream({
      start(controller) {
        const encode = (event: ProgressEvent) => {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
        };

        // Replay history for late subscribers
        getJobHistory(jobId).forEach(encode);

        // Subscribe to future events
        const unsub = subscribeToJob(jobId, encode);

        // Clean up on disconnect
        c.req.raw.signal.addEventListener("abort", unsub);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
});

// GET /api/runs — list all past runs
app.get("/api/runs", async (c) => {
  const runs = await getAllRuns();
  return c.json({ runs });
});

// ── Data API ──────────────────────────────────────────────────────────────────

app.get("/api/listings", async (c) => {
  const runId = await getRunId(c.req.query("run"));
  const [listingsData, revenueData] = await Promise.all([
    getListingsByRun(runId),
    getRevenueEstimatesForRun(runId),
  ]);
  return c.json({ runId, listings: listingsData, revenueEstimates: revenueData });
});

app.get("/api/criteria/all", async (c) => {
  const runId = await getRunId(c.req.query("run"));
  const criteria = await getTopCriteriaForRun(runId, 10);
  return c.json({ runId, criteria });
});

app.get("/api/criteria/:listingId", async (c) => {
  const listingId = parseInt(c.req.param("listingId"), 10);
  if (isNaN(listingId)) return c.json({ error: "Invalid listing ID" }, 400);
  const criteria = await getCriteriaByListing(listingId);
  return c.json({ criteria });
});

app.get("/api/reviews/timeline/:listingId", async (c) => {
  const listingId = parseInt(c.req.param("listingId"), 10);
  if (isNaN(listingId)) return c.json({ error: "Invalid listing ID" }, 400);
  const timeline = await getReviewTimelineByListing(listingId);
  return c.json({ timeline });
});

app.get("/api/sentiment/heatmap", async (c) => {
  const runId = await getRunId(c.req.query("run"));
  const data = await getSentimentHeatmapForRun(runId);
  return c.json({ runId, data });
});

async function getRunId(query: string | undefined): Promise<string> {
  return resolveRunId(query ?? undefined);
}

export function startServer(port: number): void {
  console.log(`\n🚀 Dashboard running at http://localhost:${port}`);
  Bun.serve({
    fetch: app.fetch,
    port,
    idleTimeout: 0, // disable timeout — needed for long-running SSE streams
  });
}
