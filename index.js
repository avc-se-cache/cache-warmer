import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

const DOMAINS_MAP = {
  en: "https://www.addingvalue.nu",
  se: "https://www.addingvalue.se",
  no: "https://www.addingvalue.no",
  dk: "https://www.addingvalue.dk",
  de: "https://www.adding-value.de",
  es: "https://www.adding-value.es",
  nl: "https://www.addingvalue.nl",
  fr: "https://www.addingvalue.fr",
};

const PROXIES = {
  en: process.env.BRD_PROXY_NU,
  se: process.env.BRD_PROXY_SE,
  no: process.env.BRD_PROXY_NO,
  dk: process.env.BRD_PROXY_DK,
  de: process.env.BRD_PROXY_DE,
  es: process.env.BRD_PROXY_ES,
  nl: process.env.BRD_PROXY_NL,
  fr: process.env.BRD_PROXY_FR,
};

const USER_AGENTS = {
  en: "AddingValue-NU-CacheWarmer/1.0",
  se: "AddingValue-SE-CacheWarmer/1.0",
  no: "AddingValue-NO-CacheWarmer/1.0",
  dk: "AddingValue-DK-CacheWarmer/1.0",
  de: "AddingValue-DE-CacheWarmer/1.0",
  es: "AddingValue-ES-CacheWarmer/1.0",
  nl: "AddingValue-NL-CacheWarmer/1.0",
  fr: "AddingValue-FR-CacheWarmer/1.0",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithProxy(url, country) {
  const proxy = PROXIES[country];
  const agent = new HttpsProxyAgent(proxy);
  const res = await axios.get(url, {
    httpsAgent: agent,
    headers: { "User-Agent": USER_AGENTS[country] },
    timeout: 15000,
  });
  return res.data;
}

async function fetchIndexSitemaps(domain, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, country);
    const result = await parseStringPromise(xml);
    return result?.sitemapindex?.sitemap?.map((entry) => entry.loc[0]) ?? [];
  } catch {
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country);
    const result = await parseStringPromise(xml);
    return result?.urlset?.url?.map((entry) => entry.loc[0]) ?? [];
  } catch {
    return [];
  }
}

async function retryableGet(url, config, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      lastError = err;
      const code = err.code || "";
      const isRetryable =
        axios.isAxiosError(err) &&
        ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(code);
      if (!isRetryable) break;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function warmUrls(urls, country, batchSize = 1, delay = 10000) {
  const proxy = PROXIES[country];
  const agent = new HttpsProxyAgent(proxy);

  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  await batches.reduce(async (previous, batch) => {
    await previous;

    await Promise.all(
      batch.map(async (url) => {
        try {
          const res = await retryableGet(url, {
            httpsAgent: agent,
            headers: { "User-Agent": USER_AGENTS[country] },
            timeout: 30000,
          });

          console.log(
            `[${country}] [${res.status}] ${
              res.headers["cf-cache-status"] || "N/A"
            } - ${url}`
          );
          console.log(
            `[${country}] ➤ Edge: ${res.headers["cf-ray"] || "unknown"}`
          );
        } catch {
          console.warn(`[${country}] ❌ Failed to warm ${url}`);
        }
      })
    );

    await sleep(delay);
  }, Promise.resolve());
}

// 🚀 Main function
(async () => {
  console.log(`[CacheWarmer] Started at ${new Date().toISOString()}`);

  await Promise.all(
    Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
      const sitemapList = await fetchIndexSitemaps(domain, country);

      const urlArrays = await Promise.all(
        sitemapList.map((sitemapUrl) =>
          fetchUrlsFromSitemap(sitemapUrl, country)
        )
      );

      const urls = urlArrays.flat();
      console.log(`[${country}] 🔗 Found ${urls.length} URLs`);

      await warmUrls(urls, country);
    })
  );

  console.log(`[CacheWarmer] Finished at ${new Date().toISOString()}`);
})();
