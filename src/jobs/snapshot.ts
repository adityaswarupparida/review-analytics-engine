import fs from "fs";
import { config } from "../config.js";
import { uploadToBlob } from "../../infra/azure-blob.js";

let lastDailySnapshot = "";

export async function takeSnapshot(): Promise<void> {
  const dbPath = config.DB_PATH;
  if (!fs.existsSync(dbPath)) {
    console.warn(`  ⚠ Snapshot skipped: ${dbPath} not found`);
    return;
  }

  const data = fs.readFileSync(dbPath);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Always overwrite latest
  await uploadToBlob("db-backups/latest.db", data, "application/octet-stream");

  // Upload daily snapshot once per day
  if (dateStr !== lastDailySnapshot) {
    await uploadToBlob(`db-backups/daily/reviews-${dateStr}.db`, data, "application/octet-stream");
    lastDailySnapshot = dateStr;
    console.log(`  ✓ [${timestamp}] Snapshot → latest.db + daily/reviews-${dateStr}.db`);
  } else {
    console.log(`  ✓ [${timestamp}] Snapshot → latest.db`);
  }
}

export function startSnapshotWatcher(intervalMinutes: number): void {
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`\n⏱  Snapshot watcher started — every ${intervalMinutes} min`);
  console.log("   Press Ctrl+C to stop.\n");

  // Run immediately on start, then on interval
  takeSnapshot().catch((err) => console.error("Snapshot error:", err));
  setInterval(() => {
    takeSnapshot().catch((err) => console.error("Snapshot error:", err));
  }, intervalMs);
}
