/**
 * deep-scan.js
 * ──────────────────────────────────────────────────────────────────
 * Entry point for the deep crawler. Runs completely independently
 * from index.js (the uptime monitor). Both run simultaneously
 * under PM2 as separate processes.
 *
 * Configuration (via .env):
 *   CRAWL_URLS      — comma-separated root URLs to crawl
 *                     Falls back to URLS if not set
 *   CRAWL_SCHEDULE  — cron expression (default: daily 9am)
 *   CRAWL_MAX_PAGES — max pages per domain (default: 500)
 *
 * Run manually : node deep-scan.js
 * Run via PM2  : pm2 start deep-scan.js --name "deep-crawler"
 * ──────────────────────────────────────────────────────────────────
 */

"use strict";

require("dotenv").config();

const cron                      = require("node-cron");
const Crawler                   = require("./crawler");
const { sendBatchReport }       = require("./reporter");

// ── Configuration ─────────────────────────────────────────────────────────────

const RAW_URLS  = process.env.CRAWL_URLS || process.env.URLS || "";
const URLS      = RAW_URLS.split(/[,\r\n]+/).map((u) => u.trim()).filter(Boolean);
const SCHEDULE  = process.env.CRAWL_SCHEDULE  || "0 9 * * *";
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "500", 10);

// ── Validate ─────────────────────────────────────────────────────────────────

if (URLS.length === 0) {
  console.error(
    "❌ No URLs configured.\n" +
    "   Add CRAWL_URLS=https://yoursite.com to your .env file."
  );
  process.exit(1);
}

console.log("🕷️  Deep Crawler starting up...");
console.log(`   Sites to scan  : ${URLS.length}`);
URLS.forEach((u) => console.log(`     • ${u}`));
console.log(`   Schedule       : ${SCHEDULE}`);
console.log(`   Max pages/site : ${MAX_PAGES}`);
console.log("");

// ── Crawler instance ──────────────────────────────────────────────────────────

const crawler = new Crawler({
  maxPages:   MAX_PAGES,
  maxRetries: 2,
  timeout:    12000,
  retryDelay: 1500,
});

// ── Main scan function ────────────────────────────────────────────────────────

async function runDeepScan() {
  const startTime = Date.now();
  const startStr  = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  console.log(`\n🚀 Scan Started — ${startStr}`);
  console.log("─".repeat(54) + "\n");

  // Crawl all sites in parallel, capturing response time per site
  const reports = await Promise.all(
    URLS.map(async (url) => {
      try {
        const t0     = Date.now();
        const report = await crawler.crawlDomain(url);
        report.responseTimeMs = Date.now() - t0;
        return report;
      } catch (err) {
        console.error(`❌ Fatal error crawling ${url}: ${err.message}`);
        // Return a stub report so the email still covers this site
        return {
          rootUrl:        url,
          pagesScanned:   0,
          broken:         [],
          responseTimeMs: null,
          summary:        { total404: 0, totalSoft404: 0, total5xx: 0, totalTimeout: 0 },
          error:          err.message,
        };
      }
    })
  );

  // Send ONE combined professional email for all sites
  await sendBatchReport(reports);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`🏁 All scans finished in ${elapsed} minutes.\n`);
}

// ── Schedule ──────────────────────────────────────────────────────────────────

cron.schedule(SCHEDULE, () => {
  runDeepScan().catch((err) => console.error("❌ Scheduled scan failed:", err.message));
});

// Run immediately on startup
runDeepScan().catch((err) => console.error("❌ Initial scan failed:", err.message));
