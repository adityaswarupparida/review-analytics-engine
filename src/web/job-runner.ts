import { CompetitorDiscovery } from "../scraper/competitor-discovery.js";
import { ReviewFetcher } from "../scraper/review-fetcher.js";
import { RevenueEstimator } from "../analysis/revenue-estimator.js";
import { ReviewAnalyzer } from "../analysis/review-analyzer.js";
import { CriteriaAggregator } from "../analysis/criteria-aggregator.js";
import { getLatestRunId } from "../database/db.js";
import { config, type AmazonCategory } from "../config.js";

export type StepStatus = "pending" | "running" | "done" | "error";

export interface ProgressEvent {
  step: string;
  label: string;
  status: StepStatus;
  message?: string;
  runId?: string;
}

const STEPS = [
  { step: "discover",   label: "Fetching Category & Discovering Competitors" },
  { step: "scrape",     label: "Scraping Reviews" },
  { step: "analyze",    label: "Analysing Reviews" },
  { step: "aggregate",  label: "Aggregating Criteria" },
  { step: "complete",   label: "Preparing Analytics" },
];

// In-memory store of active SSE streams per runId
const streams = new Map<string, Set<(e: ProgressEvent) => void>>();

export function subscribeToJob(runId: string, cb: (e: ProgressEvent) => void): () => void {
  if (!streams.has(runId)) streams.set(runId, new Set());
  streams.get(runId)!.add(cb);
  return () => streams.get(runId)?.delete(cb);
}

function emit(runId: string, event: ProgressEvent) {
  streams.get(runId)?.forEach((cb) => cb(event));
}

// Track completed jobs so late SSE subscribers can get the final state
const completedJobs = new Map<string, ProgressEvent[]>();

export function getJobHistory(runId: string): ProgressEvent[] {
  return completedJobs.get(runId) ?? [];
}

export async function runPipeline(asin: string, category: AmazonCategory, jobId: string): Promise<string> {
  const tempId = jobId;
  const history: ProgressEvent[] = [];

  function send(step: string, label: string, status: StepStatus, message?: string, runId?: string) {
    const event: ProgressEvent = { step, label, status, message, runId };
    history.push(event);
    emit(tempId, event);
    if (runId) emit(runId, event);
  }

  // Emit initial pending state for all steps
  STEPS.forEach(s => send(s.step, s.label, "pending"));

  let realRunId = tempId;

  try {
    // Step 1: Discover
    send("discover", STEPS[0]!.label, "running", `Finding competitors for ${asin}...`);
    const discovery = new CompetitorDiscovery();
    realRunId = await discovery.run(asin, category);
    completedJobs.set(realRunId, history);
    send("discover", STEPS[0]!.label, "done", `Found competitors | Run: ${realRunId}`, realRunId);

    // Step 2: Scrape
    send("scrape", STEPS[1]!.label, "running", "Scraping reviews...", realRunId);
    const fetcher = new ReviewFetcher();
    await fetcher.scrapeAll(realRunId);
    send("scrape", STEPS[1]!.label, "done", "Reviews scraped", realRunId);

    // Step 3: Analyze
    send("analyze", STEPS[2]!.label, "running", "Sending reviews to Claude...", realRunId);
    await new RevenueEstimator().estimateAll(realRunId);
    await new ReviewAnalyzer().analyzeAll(realRunId);
    send("analyze", STEPS[2]!.label, "done", "Analysis complete", realRunId);

    // Step 4: Aggregate
    send("aggregate", STEPS[3]!.label, "running", "Aggregating purchase criteria...", realRunId);
    await new CriteriaAggregator().aggregateAll(realRunId);
    send("aggregate", STEPS[3]!.label, "done", "Criteria aggregated", realRunId);

    // Step 5: Complete
    send("complete", STEPS[4]!.label, "done", "Ready!", realRunId);

  } catch (err) {
    const msg = (err as Error).message;
    const failedStep = [...history].reverse().find((e: ProgressEvent) => e.status === "running")?.step ?? "unknown";
    const failedLabel = STEPS.find(s => s.step === failedStep)?.label ?? failedStep;
    send(failedStep, failedLabel, "error", msg, realRunId === tempId ? undefined : realRunId);
  }

  completedJobs.set(realRunId, history);
  return realRunId;
}
