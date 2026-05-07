# Review Analytics Engine

Automated Amazon product review analytics — discovers competitors, scrapes reviews, runs AI analysis, and presents results via a web dashboard and email report.

## Screenshots

<img width="1697" height="920" alt="Screenshot 2026-05-07 at 1 12 24 PM" src="https://github.com/user-attachments/assets/0db0f555-8697-4533-955c-397ff7e22357" />

<img width="1710" height="948" alt="Screenshot 2026-05-07 at 1 11 51 PM" src="https://github.com/user-attachments/assets/62a84fb0-7f80-44d4-829c-8d19a90b0aa9" />

<img width="1679" height="815" alt="Screenshot 2026-05-07 at 1 13 14 PM" src="https://github.com/user-attachments/assets/48aa4a06-7d13-41d7-8726-5f96914eb44f" />

<img width="1683" height="983" alt="Screenshot 2026-05-07 at 1 13 42 PM" src="https://github.com/user-attachments/assets/f83927ed-70c7-49d2-9d67-ee0e1e18f553" />

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Web UI (Hono)                        │
│          Home → Progress (SSE) → Dashboard → Report        │
└────────────────────────┬────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Pipeline Runner   │
              │  (job-runner.ts)    │
              └──────────┬──────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐ ┌───────▼──────┐ ┌──────▼───────┐
│  ScraperAPI  │ │  Amazon.in   │ │  Claude API  │
│  (discovery) │ │  AJAX Reviews│ │  (analysis)  │
└───────┬──────┘ └───────┬──────┘ └──────┬───────┘
        │                │                │
        └────────────────▼────────────────┘
                  ┌──────────────┐
                  │  SQLite DB   │
                  │  (Drizzle)   │
                  └──────┬───────┘
                         │
              ┌──────────▼──────────┐
              │   Azure Blob Store  │
              │  Reports + Backups  │
              └─────────────────────┘
```

### Data Flow

1. **Discover** — ScraperAPI fetches target listing + finds 9 competitors via `also_bought` variants and keyword search
2. **Scrape** — Amazon.in AJAX review endpoint (`/portal/customer-reviews/ajax/reviews/get/`) fetches up to 1000 reviews per listing using authenticated session cookies
3. **Analyze** — Claude (`claude-sonnet-4-6`) processes reviews in batches of 10, extracting purchase criteria, sentiment scores, complaints and positives
4. **Aggregate** — Batch results merged into ranked criteria per listing
5. **Report** — Markdown report generated via Eta template, uploaded to Azure Blob, emailed via Resend

### Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Web framework | Hono |
| Database | SQLite via Drizzle ORM |
| Scraping (products) | ScraperAPI structured Amazon endpoints |
| Scraping (reviews) | Amazon.in AJAX + Playwright session login |
| AI analysis | Anthropic Claude API (claude-sonnet-4-6) |
| Storage | Azure Blob Storage |
| Email | Resend |
| Deployment | Docker → Render |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Playwright](https://playwright.dev) (local only, for Amazon login)
- API keys — see Environment Variables below

### Install

```bash
bun install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `SCRAPER_API_KEY` | ScraperAPI key — [scraperapi.com](https://scraperapi.com) |
| `ANTHROPIC_API_KEY` | Claude API key — [console.anthropic.com](https://console.anthropic.com) |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Portal → Storage Account → Access Keys |
| `AZURE_STORAGE_CONTAINER` | Blob container name (default: `review-analytics`) |
| `RESEND_API_KEY` | Resend API key — [resend.com](https://resend.com) |
| `REPORT_EMAIL_FROM` | Sender address (default: `onboarding@resend.dev`) |
| `TARGET_ASIN` | Amazon ASIN of your product |
| `AMAZON_CATEGORY` | Category for BSR constant (e.g. `electronics`) |
| `AMAZON_DOMAIN` | Amazon domain (e.g. `amazon.in`) |
| `DB_PATH` | SQLite database path (default: `./data/reviews.db`) |
| `MAX_REVIEWS_PER_LISTING` | Max reviews to scrape per product (default: `1000`) |

### Amazon Session Login (local only)

Review scraping requires an authenticated Amazon session:

```bash
bun run src/main.ts login
```

This opens a browser — log in to Amazon, then close the browser. Cookies are saved to `data/amazon-amazon-in-cookies.json`.

---

## CLI Usage

```bash
# Discover target + 9 competitors
bun run src/main.ts discover --asin B0XXXXXXXX --category electronics

# Scrape reviews (uses run ID from discover output)
bun run src/main.ts scrape --run <runId> --concurrency 2

# Run Claude analysis + revenue estimates
bun run src/main.ts analyze --run <runId>

# Start web dashboard
bun run src/main.ts serve --port 4000

# Generate and email report
bun run src/main.ts report --run <runId>
```

Or use the **web UI** at `http://localhost:4000` to run the full pipeline with real-time progress.

---

## Deployment (Render + Azure)

### Build and push Docker image

```bash
docker buildx build --platform linux/amd64 -t <dockerhub-username>/review-analytics:latest --push .
```

### Render setup

1. New → Web Service → Deploy from existing image
2. Image: `docker.io/<dockerhub-username>/review-analytics:latest`
3. Add **Persistent Disk** → mount path `/app/data`
4. Add all environment variables from `.env`
5. Set `DB_PATH=/app/data/reviews.db`

### Upload Amazon cookies to server

Upload locally to Azure Blob:
```bash
bun -e "import { uploadToBlob } from './infra/azure-blob.js'; import fs from 'fs'; const d = fs.readFileSync('./data/amazon-amazon-in-cookies.json'); await uploadToBlob('cookies/amazon-amazon-in-cookies.json', d, 'application/json'); console.log('done');"
```

Download in Render shell:
```bash
bun -e "import { downloadFromBlob } from './infra/azure-blob.js'; import fs from 'fs'; const d = await downloadFromBlob('cookies/amazon-amazon-in-cookies.json'); fs.writeFileSync('/app/data/amazon-amazon-in-cookies.json', d); console.log('done');"
```

---

## Revenue Estimation

Monthly revenue is estimated using the BSR-to-sales formula from Jungle Scout research:

```
sales_per_month = C / (BSR ^ 0.53)
revenue_per_month = sales_per_month × price
```

`C` is a category-specific constant (e.g. `160,000` for Electronics). Accuracy is ±30–50%.

---

## Project Structure

```
src/
├── main.ts                    # CLI entry point (Commander)
├── config.ts                  # Zod-validated env vars + BSR constants
├── scraper/
│   ├── types.ts               # Generic Amazon interfaces
│   ├── scraper-api-client.ts  # ScraperAPI product + search
│   ├── amazon-client.ts       # Amazon.in AJAX review scraper
│   ├── competitor-discovery.ts
│   ├── review-fetcher.ts
│   └── playwright-client.ts   # Local login only
├── database/
│   ├── schema.ts              # Drizzle schema (5 tables)
│   ├── db.ts                  # SQLite connection + WAL mode
│   └── repository.ts          # Typed CRUD functions
├── analysis/
│   ├── review-analyzer.ts     # Claude batched analysis
│   ├── criteria-aggregator.ts
│   └── revenue-estimator.ts
├── web/
│   ├── app.ts                 # Hono routes + SSE
│   ├── job-runner.ts          # Pipeline orchestrator
│   └── templates/             # home, progress, dashboard HTML
└── reports/
    ├── report-generator.ts
    └── templates/report.md.eta
infra/
├── azure-blob.ts              # Azure Blob Storage client
└── resend.ts                  # Email client
```
