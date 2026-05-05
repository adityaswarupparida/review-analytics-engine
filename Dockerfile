FROM oven/bun:1.3.3-slim

WORKDIR /app

# Install system deps needed by pdfkit (fontconfig) and playwright (skipped in prod)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy dependency files first for layer caching
COPY package.json bun.lock ./

# Install dependencies — skip Playwright browser download (login runs locally only)
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install --frozen-lockfile

# Copy source
COPY . .

# Create data and output directories
RUN mkdir -p data output

# Expose port
EXPOSE 4000

# Start the web server
CMD ["bun", "run", "src/main.ts", "serve", "--port", "4000"]
