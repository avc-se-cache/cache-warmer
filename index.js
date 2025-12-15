import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= ENV ================= */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ================= DOMAIN / PROXY / UA ================= */
const DOMAINS_MAP = {
  se: "https://www.addingvalue.se",
};

const PROXIES = {
  se: process.env.BRD_PROXY_SE,
};

const USER_AGENTS = {
  se: "AddingValue-SE-CacheWarmer/1.0",
};

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000); // WITA
  return (
    `${local.getUTCFullYear()}-` +
    `${pad(local.getUTCMonth() + 1)}-` +
    `${pad(local.getUTCDate())}_` +
    `${pad(local.getUTCHours())}-` +
    `${pad(local.getUTCMinutes())}-` +
    `${pad(local.getUTCSeconds())}_WITA`
  );
}

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop();
  }
  return "N/A";
}

/* ================= LOGGER → GSHEETS ================= */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    vercelCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country,
      url,
      status,
      cfCache,
      vercelCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => {
      r[2] = this.finishedAt;
      return r;
    });
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;

    console.log(`📝 Logging ${this.rows.length} rows to GSheets`);

    const res = await axios.post(
      APPS_SCRIPT_URL,
      { sheetName: this.sheetName, rows: this.rows },
      { timeout: 20000, headers: { "Content-Type": "application/json" } }
    );

    console.log("Apps Script response:", res.status, res.data);
    this.rows = [];
  }
}

/* ================= HTTP ================= */
async function fetchWithProxy(url, country) {
  const agent = new HttpsProxyAgent(PROXIES[country]);
  const res = await axios.get(url, {
    httpsAgent: agent,
    headers: { "User-Agent": USER_AGENTS[country] },
    timeout: 15000,
  });
  return res.data;
}

/* ================= SITEMAP ================= */
async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, country);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const list = parsed?.sitemapindex?.sitemap;
    if (!list) return [];
    return (Array.isArray(list) ? list : [list]).map((e) => e.loc);
  } catch {
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urls = parsed?.urlset?.url;
    if (!urls) return [];
    return (Array.isArray(urls) ? urls : [urls]).map((u) => u.loc);
  } catch {
    return [];
  }
}

/* ================= CLOUDFLARE ================= */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    { files: [url] },
    {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* ================= WARMER ================= */
async function retryableGet(url, cfg, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (e) {
      last = e;
      if (!["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(e.code)) break;
      await sleep(2000);
    }
  }
  throw last;
}

async function warmUrls(urls, country, logger, batchSize = 3, delay = 7000) {
  const agent = new HttpsProxyAgent(PROXIES[country]);

  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await retryableGet(
            url,
            {
              httpsAgent: agent,
              headers: { "User-Agent": USER_AGENTS[country] },
              timeout: 30000,
            },
            3
          );

          const dt = Date.now() - t0;
          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const vercelCache = res.headers["x-vercel-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";

          const edge = extractCfEdge(cfRay);
          const countryTag = edge !== "N/A" ? edge : country;

          console.log(
            `[${countryTag}] ${res.status} cf=${cfCache} vercel=${vercelCache} - ${url}`
          );

          logger.log({
            country: countryTag,
            url,
            status: res.status,
            cfCache,
            vercelCache,
            cfRay,
            responseMs: dt,
            error: 0,
          });

          if (
            ["MISS", "REVALIDATED", "PRERENDER", "STALE"].includes(vercelCache)
          ) {
            await purgeCloudflareCache(url);
          }
        } catch (e) {
          logger.log({
            country,
            url,
            error: 1,
            message: e?.message || "request failed",
          });
        }
      })
    );

    await sleep(delay);
  }
}

/* ================= MAIN ================= */
(async () => {
  console.log(`[CacheWarmer] Started ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
      const sitemaps = await fetchIndexSitemaps(domain, country);
      const urls = (
        await Promise.all(sitemaps.map((s) => fetchUrlsFromSitemap(s, country)))
      ).flat();

      console.log(`[${country}] Found ${urls.length} URLs`);
      await warmUrls(urls, country, logger);
    }
  } finally {
    logger.setFinished();
    await logger.flush();
    console.log(`[CacheWarmer] Finished`);
  }
})();
