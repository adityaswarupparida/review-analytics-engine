import { Eta } from "eta";
import { marked } from "marked";
import path from "path";
import fs from "fs";
import {
  getListingsByRun,
  getRevenueEstimatesForRun,
  getCriteriaByListing,
  getTopCriteriaForRun,
  countReviews,
  resolveRunId,
} from "../database/repository.js";
import { config } from "../config.js";
import { uploadToBlob } from "../../infra/azure-blob.js";
import { sendReportEmail } from "../../infra/resend.js";
import type { Listing, RevenueEstimate, PurchaseCriterion } from "../database/schema.js";

const eta = new Eta({
  views: path.join(import.meta.dir, "templates"),
  defaultExtension: ".eta",
  autoTrim: false,
  cache: false,
});

interface ReportData {
  generatedAt: string;
  category: string;
  target: Listing;
  listings: Listing[];
  totalReviews: number;
  revenueEstimates: (RevenueEstimate & { listing: Listing })[];
  targetRevenue: number | null;
  leader: Listing | null;
  leaderRevenue: number | null;
  topCriteria: { criterion: string; totalFrequency: number; avgSentiment: number }[];
  listingBreakdowns: { listing: Listing; criteria: PurchaseCriterion[] }[];
}

async function gatherData(runId: string): Promise<ReportData> {
  const [allListings, revenueEstimates, topCriteria] = await Promise.all([
    getListingsByRun(runId),
    getRevenueEstimatesForRun(runId),
    getTopCriteriaForRun(runId, 10),
  ]);

  const target = allListings.find((l) => l.isTarget) ?? allListings[0];
  if (!target) throw new Error("No listings found in database");

  let totalReviews = 0;
  for (const l of allListings) {
    totalReviews += await countReviews(l.id);
  }

  const targetEst = revenueEstimates.find((e) => e.listing.isTarget);
  const sorted = [...revenueEstimates].sort(
    (a, b) => (b.revenuePerMonth ?? 0) - (a.revenuePerMonth ?? 0)
  );
  const leaderEst = sorted[0];

  const listingBreakdowns = await Promise.all(
    allListings.map(async (l) => ({
      listing: l,
      criteria: await getCriteriaByListing(l.id),
    }))
  );

  return {
    generatedAt: new Date().toLocaleString(),
    category: config.AMAZON_CATEGORY,
    target,
    listings: allListings,
    totalReviews,
    revenueEstimates,
    targetRevenue: targetEst?.revenuePerMonth ?? null,
    leader: leaderEst?.listing ?? null,
    leaderRevenue: leaderEst?.revenuePerMonth ?? null,
    topCriteria,
    listingBreakdowns,
  };
}

export async function generateReport(runId?: string, includePdf = false, emailTo?: string): Promise<void> {
  const outputDir = "./output";
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const mdPath = path.join(outputDir, `report-${dateStr}.md`);

  const resolvedRunId = await resolveRunId(runId);
  console.log("\n📝 Gathering data for report...");
  const data = await gatherData(resolvedRunId);

  console.log("  Rendering Markdown...");
  const markdown = await eta.renderAsync("report.md.eta", data);
  if (!markdown) throw new Error("Template rendering returned empty");
  fs.writeFileSync(mdPath, markdown, "utf8");
  console.log(`  ✓ Markdown saved: ${mdPath}`);

  // Upload DB backup + report to Azure Blob
  console.log("  Uploading to Azure Blob...");
  const dbPath = config.DB_PATH;
  if (fs.existsSync(dbPath)) {
    await uploadToBlob(
      `db-backups/reviews-${dateStr}.db`,
      fs.readFileSync(dbPath),
      "application/octet-stream"
    );
    console.log("  ✓ DB backup uploaded");
  }

  await uploadToBlob(
    `reports/${dateStr}/report-${dateStr}.md`,
    Buffer.from(markdown),
    "text/markdown"
  );
  console.log("  ✓ Report uploaded to Azure Blob");

  // Send email only if address provided via UI
  if (config.RESEND_API_KEY && emailTo) {
    console.log("  Sending email...");
    await sendReportEmail(markdown, mdPath, dateStr, emailTo);
    console.log(`  ✓ Report emailed to ${emailTo}`);
  }

  console.log(`\n✅ Report complete: ${mdPath}`);
}
