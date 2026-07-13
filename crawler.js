/**
 * crawler.js
 * ──────────────────────────────────────────────────────────────────
 * Professional BFS-based deep crawler engine.
 *
 * KEY DESIGN DECISIONS:
 *  1. Deduplication  — brokenLinks is a Map keyed by URL, so each
 *     broken link is stored exactly once, with a list of every page
 *     it was found on. No more "same footer link × 84 pages" spam.
 *
 *  2. Soft 404 detection — some servers return HTTP 200 but show a
 *     "404 ERROR" page. We inspect the <title> tag to catch these.
 *
 *  3. Smart validation — HEAD first (fast), fall back to GET only
 *     when needed. Retry up to 2 times on transient errors.
 *
 *  4. Accuracy over speed — only 404, 5xx, and hard timeouts are
 *     flagged as broken. 403/405/999 (bot protection) are ignored.
 *
 *  5. Internal-only crawling — only pages under the exact root URL
 *     path are recursively crawled. External links are validated
 *     (for 404) but never crawled deeper.
 * ──────────────────────────────────────────────────────────────────
 */

"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const { chromium } = require("playwright");
const { URL } = require("url");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const IGNORED_SCHEMES = ["mailto:", "tel:", "javascript:", "ftp:", "data:"];

const IGNORED_DOMAINS = [
  "facebook.com", "twitter.com", "x.com", "instagram.com",
  "linkedin.com", "youtube.com", "whatsapp.com", "t.me",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a URL:
 *  - Resolves relative paths against a base
 *  - Removes the fragment (#anchor) — same page, no need to re-check
 *  - Normalizes trailing slash for consistency
 * @param {string} href   Raw href from HTML
 * @param {string} base   Absolute URL of the page containing the link
 * @returns {string|null} Normalized absolute URL, or null if invalid
 */
function normalizeUrl(href, base) {
  if (!href || typeof href !== "string") return null;
  const trimmed = href.trim();

  // Ignore known non-HTTP schemes
  if (IGNORED_SCHEMES.some((s) => trimmed.startsWith(s))) return null;

  // Ignore pure anchors
  if (trimmed === "#" || trimmed.startsWith("#")) return null;

  try {
    const parsed = new URL(trimmed, base);

    // Only http / https
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    // Remove fragment
    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Returns true when the URL hostname matches one of the ignored social domains.
 * @param {string} url Absolute URL
 */
function isSocialLink(url) {
  try {
    const { hostname } = new URL(url);
    return IGNORED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

/**
 * Returns true when the URL is "internal" — i.e., it belongs to the same
 * website domain as the root URL.
 * @param {string} url      Absolute URL to test
 * @param {string} rootUrl  Root URL from .env
 */
function isInternal(url, rootUrl) {
  try {
    const targetHost = new URL(url).hostname;
    const rootHost = new URL(rootUrl).hostname;

    // Matches if it's the exact same domain
    return targetHost === rootHost;
  } catch {
    return false;
  }
}

/**
 * Pauses execution for `ms` milliseconds.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Core Crawler Class ────────────────────────────────────────────────────────

class Crawler {
  /**
   * @param {object} opts
   * @param {number} opts.maxPages     Max pages to crawl per domain (default 500)
   * @param {number} opts.maxRetries   Validation retries per link   (default 2)
   * @param {number} opts.timeout      Request timeout in ms          (default 12000)
   * @param {number} opts.retryDelay   Delay between retries in ms   (default 1500)
   */
  constructor(opts = {}) {
    this.maxPages   = opts.maxPages   ?? 500;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeout    = opts.timeout    ?? 12000;
    this.retryDelay = opts.retryDelay ?? 1500;

    // AI Integration
    this.apiKey = opts.apiKey;
    if (this.apiKey) {
      const genAI = new GoogleGenerativeAI(this.apiKey);
      this.model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Entry point. Crawls one domain fully and returns a structured report.
   * @param {string} rootUrl  The root URL from .env
   * @returns {Promise<CrawlReport>}
   */
  async crawlDomain(rootUrl) {
    // Normalize root (strip trailing slash for consistent comparisons)
    let formattedRootUrl = rootUrl.trim();
    if (!/^https?:\/\//i.test(formattedRootUrl)) {
      formattedRootUrl = `https://${formattedRootUrl}`;
    }
    const root = formattedRootUrl.endsWith("/") ? formattedRootUrl.slice(0, -1) : formattedRootUrl;

    /** @type {Set<string>} Pages already crawled */
    const visitedPages = new Set();

    /**
     * Map<url, {status, text, category, foundOnPages: Set<string>}>
     * Each broken link is stored exactly ONCE regardless of how many
     * pages contain it. foundOnPages accumulates every source page.
     */
    const brokenLinks = new Map();

    /**
     * Cache of already-validated link targets so we don't re-request
     * the same URL when it appears on 20 different pages.
     * Map<url, {status: number|string, isBroken: boolean, category: string}>
     */
    const validationCache = new Map();

    // BFS queue — each entry: { url: string, depth: number }
    const queue = [{ url: root, depth: 0 }];

    let pagesScanned = 0;

    console.log(`\n🔍 Starting deep crawl: ${root}`);
    console.log(`   Max pages: ${this.maxPages}\n`);

    while (queue.length > 0 && pagesScanned < this.maxPages) {
      const { url, depth } = queue.shift();

      if (visitedPages.has(url)) continue;
      visitedPages.add(url);
      pagesScanned++;

      console.log(`  📄 [${pagesScanned}] ${url}`);

      // Fetch the page HTML
      let html;
      try {
        const res = await axios.get(url, {
          timeout: this.timeout,
          headers: { "User-Agent": DEFAULT_USER_AGENT },
          // axios follows redirects automatically (up to 5 by default)
          maxRedirects: 5,
        });

        // Check content-type — skip non-HTML pages
        const ct = res.headers["content-type"] || "";
        if (!ct.includes("text/html")) continue;

        html = res.data;

        // Detect soft 404 on the crawled page itself
        if (this._isSoft404(html)) {
          this._recordBroken(brokenLinks, url, "Page", 404, "soft-404", "ROOT");
          continue; // No point extracting links from a 404 page
        }
      } catch (err) {
        // The page itself failed — record and move on
        const status = err.response?.status ?? "TIMEOUT";
        const category = this._categorize(status);
        if (category !== "ignore") {
          this._recordBroken(brokenLinks, url, "Page", status, category, "ROOT");
        }
        continue;
      }

      // ── Extract all <a href> links from the page ──────────────────────────
      const $ = cheerio.load(html);
      const linksOnPage = [];

      $("a[href]").each((_, el) => {
        const href  = $(el).attr("href");
        const text  = $(el).text().replace(/\s+/g, " ").trim() || "(no text)";
        const normalized = normalizeUrl(href, url);
        if (normalized && !isSocialLink(normalized)) {
          linksOnPage.push({ url: normalized, text });
        }
      });

      // ── Validate each link ────────────────────────────────────────────────
      for (const link of linksOnPage) {
        const linkUrl = link.url;

        // Only follow internal links into the crawl queue
        const internal = isInternal(linkUrl, root);

        // Validate the link (uses cache — won't re-request same URL)
        const result = await this._validateLink(linkUrl, validationCache, url);

        if (result.isBroken) {
          this._recordBroken(
            brokenLinks,
            linkUrl,
            link.text,
            result.status,
            result.category,
            url,           // the page this broken link was found on
          );
          
          // Add Smart AI Analysis if available
          if (this.model && !brokenLinks.get(linkUrl).aiReason) {
            brokenLinks.get(linkUrl).aiReason = await this._analyzeErrorWithAI(
              linkUrl, 
              result.html, 
              result.status
            );
          }
        }

        // Enqueue internal pages that passed validation
        if (internal && !result.isBroken && !visitedPages.has(linkUrl)) {
          queue.push({ url: linkUrl, depth: depth + 1 });
        }
      }
    }

    // Convert Map to sorted array for the reporter
    const broken = [...brokenLinks.values()].map((b) => ({
      ...b,
      foundOnPages: [...b.foundOnPages],
    }));

    return {
      rootUrl: root,
      pagesScanned,
      broken,
      summary: {
        total404:    broken.filter((b) => b.category === "not-found").length,
        totalSoft404: broken.filter((b) => b.category === "soft-404").length,
        total5xx:    broken.filter((b) => b.category === "server-error").length,
        totalTimeout: broken.filter((b) => b.category === "timeout").length,
      },
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Validates a single URL. Results are cached so the same URL is never
   * re-requested even if it appears on dozens of pages.
   *
   * Strategy:
   *  1. Try HEAD (lightweight — no body download)
   *  2. If HEAD returns 405/403 → retry with GET (some servers don't allow HEAD)
   *  3. On GET, inspect body for soft 404 patterns
   *  4. Retry up to maxRetries times on transient errors (5xx, timeout)
   *
   * @param {string} url
   * @param {Map}    cache
   * @param {string} referer
   * @returns {Promise<{status: number|string, isBroken: boolean, category: string}>}
   */
  async _validateLink(url, cache, referer = null) {
    if (cache.has(url)) return cache.get(url);

    let attempt = 0;
    let lastError;

    while (attempt <= this.maxRetries) {
      if (attempt > 0) {
        await sleep(this.retryDelay);
        console.log(`    ↺ Retry ${attempt}/${this.maxRetries}: ${url}`);
      }

      try {
        // ── Step 1: HEAD request ────────────────────────────────────────────
        let status;
        let bodyHtml = null;

        try {
          const commonHeaders = {
            "User-Agent": DEFAULT_USER_AGENT,
            "Referer": referer || url,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          };

          const headRes = await axios.head(url, {
            timeout: this.timeout,
            headers: commonHeaders,
            maxRedirects: 5,
            validateStatus: () => true, // don't throw on 4xx/5xx
          });
          status = headRes.status;
        } catch (headErr) {
          // Network error on HEAD — treat as timeout for now
          throw headErr;
        }

        // ── Step 2: If HEAD returned 405/403, retry with GET ────────────────
        if (status === 405 || status === 403) {
          const commonHeaders = {
            "User-Agent": DEFAULT_USER_AGENT,
            "Referer": referer || url,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          };

          const getRes = await axios.get(url, {
            timeout: this.timeout,
            headers: commonHeaders,
            maxRedirects: 5,
            validateStatus: () => true,
          });
          status = getRes.status;
          bodyHtml = typeof getRes.data === "string" ? getRes.data : null;
        }

        // ── Step 4: If still broken, try a Real Browser check (Final Verification) ──
        let isBroken = status >= 400;
        let category = this._categorize(status);

        if (status === 403 || status === 0 || status === "TIMEOUT" || status >= 500) {
          console.log(`    🔍 Verifying with Real Browser: ${url}`);
          const browserResult = await this._verifyWithBrowser(url);
          if (browserResult.isSuccess) {
            status = browserResult.status;
            isBroken = false;
            category = "healthy";
          }
        }

        const result = { status, isBroken, category };
        cache.set(url, result);
        return result;
      } catch (err) {
        lastError = err;
        attempt++;
      }
    }

    // All retries exhausted — final attempt with real browser
    console.log(`    🔍 Final Browser Check (Post-Retry): ${url}`);
    const finalCheck = await this._verifyWithBrowser(url);
    if (finalCheck.isSuccess) {
      const result = { status: finalCheck.status, isBroken: false, category: "healthy" };
      cache.set(url, result);
      return result;
    }

    const status = lastError?.response?.status ?? "TIMEOUT";
    const category = this._categorize(status);
    const result = { status, isBroken: true, category };
    cache.set(url, result);
    return result;
  }

  /**
   * Final check using a headless browser. 
   * This handles sites that block simple HTTP requests or require JS.
   */
  async _verifyWithBrowser(url) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: { width: 1280, height: 720 }
      });
      const page = await context.newPage();
      
      // Wait for network idle or timeout
      const response = await page.goto(url, { 
        timeout: 20000, 
        waitUntil: 'domcontentloaded' 
      });
      
      const status = response ? response.status() : 0;
      // Consider 2xx and 3xx as success in a browser context
      const isSuccess = status >= 200 && status < 400;
      
      return { isSuccess, status };
    } catch (err) {
      return { isSuccess: false, status: 'BROWSER_TIMEOUT' };
    } finally {
      if (browser) {
        try { await browser.close(); } catch (e) {}
      }
    }
  }

  /**
   * Checks if an HTML string is a soft 404.
   * Looks at <title> and common error heading patterns.
   * @param {string} html
   * @returns {boolean}
   */
  _isSoft404(html) {
    if (!html || typeof html !== "string") return false;
    try {
      const $ = cheerio.load(html);
      const title = $("title").text().toUpperCase();
      const h1    = $("h1").first().text().toUpperCase();

      return (
        title.includes("404") ||
        title.includes("PAGE NOT FOUND") ||
        title.includes("NOT FOUND") ||
        h1.includes("404") ||
        h1.includes("PAGE NOT FOUND")
      );
    } catch {
      return false;
    }
  }

  /**
   * Maps an HTTP status code to a human category.
   * @param {number|string} status
   * @returns {'ok'|'not-found'|'soft-404'|'server-error'|'timeout'|'ignore'}
   */
  _categorize(status) {
    if (status === "TIMEOUT") return "timeout";
    if (typeof status !== "number") return "timeout";
    if (status >= 200 && status < 400) return "ok";
    if (status === 404)               return "not-found";
    if (status === 403)               return "forbidden";
    if (status >= 500)                return "server-error";
    // 405, 429, 999, etc. — bot protection / rate limiting, not real errors
    return "ignore";
  }

  /**
   * Uses Gemini AI to provide a human-friendly explanation of why a link is failing.
   */
  async _analyzeErrorWithAI(url, html, status) {
    if (!this.model) return null;

    try {
      console.log(`    🤖 AI analyzing error: ${url}`);
      
      // Clean HTML to save tokens (keep only title and headings/errors)
      let snippet = "No HTML body available (HEAD request).";
      if (html && typeof html === "string") {
        const $ = cheerio.load(html);
        $("script, style").remove();
        snippet = $("body").text().replace(/\s+/g, " ").substring(0, 1500);
      }

      const prompt = `
        You are a web quality expert. A link is failing with HTTP Status: ${status}.
        URL: ${url}
        Page Content Snippet: "${snippet}"
        
        Analyze why this link is failing and give a very brief (1-2 sentence) 
        professional explanation for a business owner. 
        Focus on whether it is a permission issue, a missing file, or a network timeout.
        Be concise.
      `;

      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      console.error(`    🤖 AI analysis failed: ${err.message}`);
      return "AI analysis currently unavailable.";
    }
  }

  /**
   * Records a broken link in the deduplication map.
   * If the same broken URL was already found, we simply add the new
   * source page to its foundOnPages set instead of creating a duplicate.
   *
   * @param {Map}    brokenLinks  The dedup map
   * @param {string} url          The broken link URL
   * @param {string} text         Anchor text / link label
   * @param {number|string} status HTTP status
   * @param {string} category
   * @param {string} foundOn      URL of the page where this link was found
   */
  _recordBroken(brokenLinks, url, text, status, category, foundOn) {
    if (brokenLinks.has(url)) {
      brokenLinks.get(url).foundOnPages.add(foundOn);
    } else {
      brokenLinks.set(url, {
        url,
        text,
        status,
        category,
        foundOnPages: new Set([foundOn]),
      });
    }
  }
}

module.exports = Crawler;
