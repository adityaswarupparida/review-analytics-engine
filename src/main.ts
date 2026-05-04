import { Command } from "commander";
import { initDb } from "./database/db.js";

const program = new Command("review-analytics");
program
  .version("1.0.0")
  .description("Amazon review analytics engine");

program
  .command("discover")
  .description("Fetch target listing + discover 9 competitors, creates a new run")
  .option("--asin <asin>", "Target ASIN (overrides TARGET_ASIN env var)")
  .option("--category <category>", "Amazon category (overrides AMAZON_CATEGORY env var)")
  .action(async (opts) => {
    initDb();
    const { config } = await import("./config.js");
    const { CompetitorDiscovery } = await import("./scraper/competitor-discovery.js");
    const asin = opts.asin ?? config.TARGET_ASIN;
    const category = opts.category ?? config.AMAZON_CATEGORY;
    const runId = await new CompetitorDiscovery().run(asin, category);
    console.log(`\n💡 Use --run ${runId} with scrape/analyze/report to target this run.`);
  });

program
  .command("scrape")
  .description("Fetch reviews for all listings in a run")
  .option("--run <id>", "Run ID (defaults to latest run)")
  .option("--concurrency <n>", "Parallel listings", "3")
  .action(async (opts) => {
    initDb();
    const { ReviewFetcher } = await import("./scraper/review-fetcher.js");
    await new ReviewFetcher().scrapeAll(opts.run, parseInt(opts.concurrency, 10));
  });

program
  .command("analyze")
  .description("Run Claude NLP analysis + estimate revenue for a run")
  .option("--run <id>", "Run ID (defaults to latest run)")
  .option("--batch-size <n>", "Reviews per Claude batch", "20")
  .action(async (opts) => {
    initDb();
    const { RevenueEstimator } = await import("./analysis/revenue-estimator.js");
    const { ReviewAnalyzer } = await import("./analysis/review-analyzer.js");
    const { CriteriaAggregator } = await import("./analysis/criteria-aggregator.js");

    await new RevenueEstimator().estimateAll(opts.run);
    await new ReviewAnalyzer().analyzeAll(opts.run, parseInt(opts.batchSize, 10));
    await new CriteriaAggregator().aggregateAll(opts.run);
  });

program
  .command("serve")
  .description("Start web dashboard")
  .option("--port <n>", "Port", "5000")
  .action(async (opts) => {
    initDb();
    const { startServer } = await import("./web/app.js");
    startServer(parseInt(opts.port, 10));
  });

program
  .command("report")
  .description("Generate Markdown report + upload to Azure + email")
  .option("--run <id>", "Run ID (defaults to latest run)")
  .action(async (opts) => {
    initDb();
    const { generateReport } = await import("./reports/report-generator.js");
    await generateReport(opts.run);
  });

program
  .command("watch")
  .description("Long-running snapshot watcher — uploads DB to Azure Blob on interval")
  .option("--interval <minutes>", "Snapshot interval in minutes", "60")
  .action(async (opts) => {
    initDb();
    const { startSnapshotWatcher } = await import("./jobs/snapshot.js");
    startSnapshotWatcher(parseInt(opts.interval, 10));
    await new Promise(() => {});
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
