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

const app = new Hono();

// Helper: resolve run from query param or latest
async function getRunId(query: string | undefined): Promise<string> {
  return resolveRunId(query ?? undefined);
}

app.get("/api/runs", async (c) => {
  const allRuns = await getAllRuns();
  return c.json({ runs: allRuns });
});

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

app.get("/", async (c) => {
  const html = await Bun.file(
    new URL("./templates/dashboard.html", import.meta.url).pathname
  ).text();
  return c.html(html);
});

export function startServer(port: number): void {
  console.log(`\n🚀 Dashboard running at http://localhost:${port}`);
  console.log(`   Add ?run=<run-id> to any API call to view a specific run`);
  Bun.serve({ fetch: app.fetch, port });
}
