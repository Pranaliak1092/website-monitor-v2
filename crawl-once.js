"use strict";

require("dotenv").config();
const Crawler = require("./crawler");
const { sendBatchReport } = require("./reporter");

const RAW_URLS = process.env.CRAWL_URLS || process.env.URLS || "";
const URLS = RAW_URLS.split(/[,\r\n]+/).map((u) => u.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "500", 10);

if (URLS.length === 0) {
  console.error("❌ No URLs configured.");
  process.exit(1);
}

const crawler = new Crawler({
  maxPages: MAX_PAGES,
  maxRetries: 2,
  timeout: 15000,
  retryDelay: 2000,
  apiKey: process.env.GEMINI_API_KEY,
});

async function runOnce() {
  console.log("🕷️ Starting Single Deep Scan...");
  
  const reports = await Promise.all(
    URLS.map(async (url) => {
      try {
        const t0 = Date.now();
        const report = await crawler.crawlDomain(url);
        report.responseTimeMs = Date.now() - t0;
        return report;
      } catch (err) {
        console.error(`❌ Fatal error crawling ${url}: ${err.message}`);
        return {
          rootUrl: url,
          pagesScanned: 0,
          broken: [],
          responseTimeMs: null,
          summary: { total404: 0, totalSoft404: 0, total5xx: 0, totalTimeout: 0 },
          error: err.message,
        };
      }
    })
  );

  await sendBatchReport(reports);
  console.log("🏁 Deep Scan complete.");
}

runOnce().catch((err) => {
  console.error("❌ Scan failed:", err.message);
  process.exit(1);
});
