// webclone.js
//
// A lean, async, and robust website and video archiver.
//
// This script crawls a website starting from a given URL, saves all pages
// and assets (CSS, JS, images, etc.), and rewrites all links to relative
// paths, creating a fully self-contained offline archive. It can also
// intelligently detect and download videos from popular streaming sites.
//
// --- Prerequisites ---
// 1. Node.js (v18 or higher recommended).
// 2. Install dependencies:
//    npm install
// 3. For video downloading (optional):
//    - yt-dlp: Must be installed and in your system's PATH.
//    - ffmpeg: Required by yt-dlp for merging high-quality video and audio streams.
//
// --- Usage ---
//
// node webclone.js [options] <start_url_1> [start_url_2] ...
//
// For a full list of options, run: node webclone.js --help
//
// --- Examples ---
//
// 1. Basic Archive:
//    Archive a single public website.
//
//    node webclone.js https://www.example.com/
//
// 2. Archive a Private Site (requires login):
//    First, generate a 'cookies.json' file. Then, use the --cookies flag
//    to run the crawl with your authenticated session.
//
//    node webclone.js --cookies ./cookies.json https://private.example.com/dashboard
//
// 3. Download a Video:
//    The script will automatically detect the YouTube URL and use yt-dlp
//    to download the video.
//
//    node webclone.js https://www.youtube.com/watch?v=...
//
// 4. Archive a Page and its Embedded Videos:
//    Crawl a blog post and automatically find and download any embedded
//    YouTube or Vimeo videos, rewriting the links to point to the local files.
//
//    node webclone.js https://my-blog.com/interesting-article
//
// 5. Download a Video at a Specific Resolution:
//    Download a video, ensuring the final file is 720p or lower.
//
//    node webclone.js --video-resolution 720 https://www.dailymotion.com/video/...
//
// --- How Cookie-Based Archiving Works ---
//
// To archive content behind a login (e.g., private forums, subscription sites,
// or age-restricted videos), you must provide a valid session cookie.
// The easiest method is to use the built-in interactive login feature.
//
// 1. Run the script with `--interactive-login` and specify a file with `--save-cookies`.
//    A browser will open, allowing you to log in manually.
//
//    node webclone.js --interactive-login --save-cookies ./my-session.json https://private.example.com/dashboard
//
// 2. After you log in and the script finishes, the `my-session.json` file can be
//    reused in future runs with the `--cookies` flag to skip the interactive login.
//
//    node webclone.js --cookies ./my-session.json https://private.example.com/dashboard
//

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { setTimeout: sleep } = require("timers/promises");
const { pipeline } = require("stream/promises");
const readline = require("readline");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const pino = require("pino");
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options] <start_url_1> [start_url_2] ...')
  .demandCommand(1, 'You must provide at least one starting URL.')
  .option('cookies', {
    alias: 'c',
    type: 'string',
    description: 'Path to a JSON file containing browser cookies.',
    normalize: true, // a.k.a. path.resolve()
  })
  .coerce('cookies', (path) => {
    if (path && !fs.existsSync(path)) {
      throw new Error(`Cookie file not found at: ${path}`);
    }
    return path;
  })
  .option('interactive-login', {
    type: 'boolean',
    description: 'If true, opens a browser for you to log in manually before starting the crawl.',
    default: false,
  })
  .option('save-cookies', {
    type: 'string',
    description: 'Path to save session cookies in JSON format after a successful interactive login. This file can be reused with the --cookies flag.',
    normalize: true,
  })
  .option('out-dir', {
    alias: 'o',
    type: 'string',
    description: 'The root directory where the archive will be saved.',
    default: path.resolve(__dirname, 'archive'),
    normalize: true,
  })
  .option('max-depth', {
    alias: 'd',
    type: 'number',
    description: 'Maximum crawl depth. 0 means only the start URLs.',
    default: 5,
  })
  .option('max-pages', {
    alias: 'p',
    type: 'number',
    description: 'Maximum number of pages to crawl.',
    default: 600,
  })
  .option('concurrency', {
    alias: 'n',
    type: 'number',
    description: 'Number of concurrent workers (browser pages) to use.',
    default: 3,
  })
  .option('max-consecutive-failures', {
    type: 'number',
    description: 'Maximum number of consecutive different pages that can fail before the crawl is stopped.',
    default: 10,
  })
  .option('user-agent', {
    type: 'string',
    description: 'User-Agent string to use for requests.',
    default: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  })
  .option('save-failed-responses', {
    type: 'boolean',
    description: 'If true, saves responses that failed (e.g., 404, 500).',
    default: false,
  })
  .option('rewrite-css', {
    type: 'boolean',
    description: 'Enable/disable rewriting of all CSS `url()` paths (external, embedded, and inline).',
    default: true,
  })
  .option('follow-iframes', {
    type: 'boolean',
    description: 'Whether to crawl content inside iframes.',
    default: true,
  })
  .option('protocol-timeout', {
    type: 'number',
    description: 'Puppeteer protocol timeout in milliseconds.',
    default: 90000,
  })
  .option('videos', {
    type: 'string',
    description: 'Video download mode: "auto", "all", or "none".',
    default: 'auto',
    choices: ['auto', 'all', 'none'],
  })
  .option('video-resolution', {
    type: 'number',
    description: 'Maximum desired video height (e.g., 1080, 720).',
  })
  .option('yt-dlp-path', {
    type: 'string',
    description: 'Path to the yt-dlp executable.',
    normalize: true,
  })
  .option('crawl-scope', {
    type: 'string',
    description: 'Defines the scope of the crawl.',
    choices: ['same-domain', 'subdomains', 'cross-domains'],
    default: 'cross-domains',
  })
  .option('global-timeout', {
    type: 'number',
    description: 'Maximum total crawl time in minutes. 0 for no limit.',
    default: 0, // 0 = disabled
  })
  .option('stall-timeout', {
    type: 'number',
    description: 'Minutes without a successful page crawl before stopping. 0 for no limit.',
    default: 5,
  })
  .option('asset-timeout', {
    type: 'number',
    description: 'Seconds to wait for an asset to buffer before timing out.',
    default: 30,
  })
  .option('show-browser', {
    type: 'boolean',
    description: 'Run the browser in a visible window for debugging.',
    default: false,
  })
  .option('log-level', {
    type: 'string',
    description: 'Set the logging level.',
    choices: ['debug', 'info', 'warn', 'error', 'fatal'],
    default: 'info',
  })
  .check((argv) => {
    const numericChecks = {
      'max-depth': 0,
      'max-pages': 1,
      'concurrency': 1,
      'max-consecutive-failures': 1,
      'protocol-timeout': 1000,
      'global-timeout': 0,
      'stall-timeout': 0,
      'asset-timeout': 1,
    };
    for (const [key, min] of Object.entries(numericChecks)) {
      if (argv[key] < min) {
        throw new Error(`The value for --${key} must be at least ${min}.`);
      }
    }
    return true;
  })
  .help()
  .alias('help', 'h')
  .argv;

const CONFIG = Object.freeze({
  // The initial URL(s) to start crawling from, taken from positional arguments.
  startUrls: argv._,
  // Optional path to a cookies.json file for session sharing.
  cookiePath: argv.cookies || null,
  // If true, opens a browser for manual login before the crawl begins.
  interactiveLogin: argv.interactiveLogin,
  // Optional path to save session cookies after a successful interactive login.
  saveCookiesPath: argv.saveCookies || null,
  // The root directory where the archive will be saved.
  outDir: argv.outDir,
  // A consistent User-Agent to prevent detection and ensure consistent rendering.
  userAgent: argv.userAgent,
  // --- Crawl Scope ---
  // Whether to crawl content inside iframes.
  followIframes: argv.followIframes,
  // The maximum number of pages to crawl. The crawl stops when this limit is reached.
  maxPages: argv.maxPages,
  // The maximum crawl depth. 0 means only the start URLs, 1 means their links, etc.
  maxDepth: argv.maxDepth,
  // The scope of the crawl, controlling how domains are handled.
  crawlScope: argv.crawlScope,
  // --- Concurrency & Retries ---
  // The number of concurrent workers (i.e., browser pages) to use for crawling.
  concurrency: argv.concurrency,
  // The maximum number of consecutive different pages that can fail before the crawl is stopped.
  maxConsecutiveFailures: argv.maxConsecutiveFailures,
  // --- Video Settings ---
  videos: argv.videos,
  videoResolution: argv.videoResolution || null,
  ytDlpPath: argv.ytDlpPath || 'yt-dlp',
  // --- Delays & Timeouts ---
  // Puppeteer's internal DevTools Protocol timeout.
  protocolTimeout: argv.protocolTimeout,
  // --- Asset & Rewriting ---
  // If true, saves responses that failed (e.g., 404, 500). The content will be the status code.
  saveFailedResponses: argv.saveFailedResponses,
  // If true, rewrites `url()` paths in all CSS contexts (external, embedded, inline).
  rewriteCss: argv.rewriteCss,
  // --- Failsafes ---
  globalTimeoutMs: argv.globalTimeout * 60 * 1000,
  stallTimeoutMs: argv.stallTimeout * 60 * 1000,
  assetTimeoutMs: argv.assetTimeout * 1000,
});

const INTERNAL_CONSTANTS = Object.freeze({
  // The maximum number of times to retry a single failed page crawl.
  maxRetries: 3,
  // The maximum number of times to retry a single failed video download.
  videoMaxRetries: 2,
  // A random delay between page visits to avoid overwhelming the server. [min, max] in milliseconds.
  randomDelayMs: [200, 1800],
  // Puppeteer's page navigation event to wait for. 'networkidle2' is good for dynamic sites.
  waitUntil: "domcontentloaded", //"networkidle2",
  // Maximum time to wait for page navigation before timing out.
  navTimeoutMs: 60000,
  // Timeout for video downloads.
  videoDownloadTimeoutMs: 300000, // 5 minutes
  // Default backoff delay if no 'Retry-After' header is found. [min, max] in ms.
  defaultBackoffMs: [5000, 10000],
  // Failsafe timeout for the auto-scroll routine.
  scrollTimeoutMs: 15000,
  // Number of stable scroll height checks before considering lazy-loading complete.
  scrollStabilityChecks: 3,
  // Interval between scroll height checks.
  scrollCheckIntervalMs: 250,
  // Maximum file path length. If a generated path exceeds this, it will be hashed.
  maxPathLength: 255,
  // Maximum length for a single sanitized path segment (e.g., a directory or file name).
  maxSegmentLength: 100,
  // Status codes that indicate a temporary server issue, warranting a cool-down and retry.
  RETRYABLE_STATUS_CODES: new Set([429, 500, 502, 503, 504]),
  // Status codes that indicate a permanent client-side error, which should not be retried.
  PERMANENT_ERROR_STATUS_CODES: new Set([401, 403, 404]),
});
/* ------------------------------------------------ */

/* -------------------- CRAWL STATE -------------------- */
// This object holds the mutable state of the crawl, shared across all workers.
const CRAWL_STATE = {
  // The queue of pages to be crawled.
  queue: [],
  // A set of all URLs that have ever been added to the queue, to prevent duplicates.
  enqueued: new Set(),
  // A set of all URLs that have been successfully crawled.
  visited: new Set(),
  // A map to store metadata about every URL encountered (original URL -> {filePath, contentType, status, etc.}).
  records: new Map(),
  // A global timestamp until which all workers should pause due to rate-limiting.
  coolDownUntil: 0,
  // Statistics for the crawl, to be displayed at the end.
  stats: {
    pagesCrawled: 0,
    assetsSaved: 0,
    totalBytes: 0,
    failedResources: 0,
    startTime: 0,
    lastProgressTime: 0,
    consecutiveFailures: 0,
    activeWorkers: 0,
  },
  // Global flag to ensure shutdown logic runs only once.
  shuttingDown: false,
  // Global reference to the Puppeteer browser instance.
  browserInstance: null,
  // --- Scope Control ---
  initialHosts: new Set(),
  initialBaseDomains: new Set(),
  // --- Video State ---
  processedVideos: new Set(),
  videoUrlMap: new Map(),
  activeVideoDownloads: 0,
  activeDownloadProcesses: new Set(),
  ytDlpNeeded: false,
};
/* ---------------------------------------------------- */

// A list of all tags and attributes that can contain URLs for the rewriter.
const URL_ATTRS = [
  ["a", "href"],
  ["link", "href"],
  ["script", "src"],
  ["img", "src"],
  ["image", "xlink:href"],
  ["image", "href"],
  ["source", "src"],
  ["video", "src"],
  ["audio", "src"],
  ["track", "src"],
  ["iframe", "src"],
  ["form", "action"],
  ["embed", "src"],
  ["object", "data"],
  ["use", "href"],
  ["meta", "content"],
  ["video", "poster"],
  ["img", "srcset"],
  ["source", "srcset"],
  ["html", "manifest"],
];

const EXT_MAP = new Map([
  ["text/html", ".html"],
  ["text/plain", ".txt"],
  ["text/css", ".css"],
  ["text/javascript", ".js"],
  ["application/javascript", ".js"],
  ["application/x-javascript", ".js"],
  ["application/json", ".json"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["image/x-icon", ".ico"],
  ["image/avif", ".avif"],
  ["image/jp2", ".jp2"],
  ["image/jxr", ".jxr"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["font/ttf", ".ttf"],
  ["font/otf", ".otf"],
  ["font/woff", ".woff"],
  ["font/woff2", ".woff2"],
  ["application/manifest+json", ".webmanifest"],
  ["application/wasm", ".wasm"],
  ["application/xml", ".xml"],
  ["application/xhtml+xml", ".xhtml"],
  ["application/ld+json", ".jsonld"],
  ["application/graphql", ".graphql"],
  ["application/rss+xml", ".rss"],
  ["application/atom+xml", ".atom"],
  ["text/markdown", ".md"],
  ["application/x-yaml", ".yaml"],
  ["text/yaml", ".yaml"],
  ["text/xml", ".xml"],
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["video/mp4", ".mp4"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["video/webm", ".webm"],
  ["audio/webm", ".webm"],
  ["video/ogg", ".ogg"],
  ["audio/ogg", ".ogg"],
  ["application/ogg", ".ogg"],
  ["application/zip", ".zip"],
  ["application/gzip", ".gz"],
  ["application/x-tar", ".tar"],
  ["application/x-7z-compressed", ".7z"],
  ["application/x-rar-compressed", ".rar"],
  ["application/octet-stream", ""],
  ["application/x-shockwave-flash", ".swf"],
  ["text/x-python", ".py"],
  ["text/x-java-source", ".java"],
  ["text/x-c++src", ".cpp"],
  ["application/x-sh", ".sh"],
  ["text/x-ini", ".ini"],
]);

const HTML_LIKE_EXTENSIONS = new Set([".html", ".htm", ".php", ".asp", ".aspx", ".jsp", ".cfm", ".xhtml"]);

/* ---------- PRE-COMPILED CSS REGEX ---------- */
const CSS_URL_REGEX = [
  /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi,
  // @import is handled separately due to its unique syntax (string literal support)
  /src:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
  /--[\w-]+:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
];

const IMPORT_REGEX = /@import\s+(?:url\(\s*(['"]?)([^'"]+?)\1\s*\)|(['"])([^'"]+?)\3)/gi;

const DIRECT_VIDEO_URL_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
  /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/vimeo\.com\/\d+/,
  /^https?:\/\/(www\.)?dailymotion\.com\/video\//,
  /^https?:\/\/(www\.)?tiktok\.com\/.*\/video\//,
  /^https?:\/\/(www\.)?facebook\.com\/(watch|stories|reel)\//,
  /^https?:\/\/(www\.)?bilibili\.com\/video\/(av|BV)/,
  /^https?:\/\/(www\.)?bilibili\.tv\/[a-z]{2}\/(play|video)\/\d+/,
];

const logger = pino({ level: argv.logLevel });

// --- Graceful Shutdown Handlers ---
const sigintHandler = async () => {
  logger.info("SIGINT received, shutting down gracefully...");
  await performShutdown("SIGINT", 1);
};

const sigtermHandler = async () => {
  logger.info("SIGTERM received, shutting down gracefully...");
  await performShutdown("SIGTERM", 1);
};

process.on("SIGINT", sigintHandler);
process.on("SIGTERM", sigtermHandler);

process.on('unhandledRejection', async (reason, promise) => {
  logger.fatal({ err: reason }, 'Unhandled Rejection at:', promise, '... shutting down');
  // It's crucial to exit, as the application is in an unknown state.
  await performShutdown('Unhandled Rejection', 1);
});

/* ---------------- MAIN CRAWL LOOP ---------------- */
async function main() {
  // Failsafe: Ensure the browser process is killed when the Node process exits.
  process.on('exit', () => {
    if (CRAWL_STATE.browserInstance) {
      CRAWL_STATE.browserInstance.process()?.kill();
    }
  });

  CRAWL_STATE.stats.startTime = Date.now();
  CRAWL_STATE.stats.lastProgressTime = Date.now();
  logger.info("Starting web-archiver...");
  logger.info({ config: CONFIG }, "Using configuration");

  // --- Populate Initial Scope ---
  for (const startUrl of CONFIG.startUrls) {
    try {
      const host = new URL(startUrl).hostname;
      CRAWL_STATE.initialHosts.add(host);
      CRAWL_STATE.initialBaseDomains.add(getBaseDomain(host));
    } catch (e) {
      logger.warn({ url: startUrl, err: e.message }, "Could not parse start URL for scope control.");
    }
  }
  logger.info({
    scope: CONFIG.crawlScope,
    hosts: [...CRAWL_STATE.initialHosts],
    baseDomains: [...CRAWL_STATE.initialBaseDomains]
  }, "Crawl scope initialized.");
  // --- End Scope ---

  let cookies = [];

  // --- Interactive Login Flow ---
  if (CONFIG.interactiveLogin) {
    let loginBrowser = null;
    try {
      logger.info("Starting interactive login session...");
      loginBrowser = await puppeteer.launch({
        headless: false, // Always show browser for login
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await loginBrowser.newPage();
      await page.goto(CONFIG.startUrls[0], { waitUntil: 'domcontentloaded' });

      logger.info("Please log in to the website in the browser window.");
      logger.info("After you have successfully logged in, press [Enter] in this terminal to continue...");

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => rl.on('line', resolve));
      rl.close();

      logger.info("Capturing session cookies...");
      cookies = await page.cookies();

      if (CONFIG.saveCookiesPath) {
        try {
          await fs.promises.writeFile(CONFIG.saveCookiesPath, JSON.stringify(cookies, null, 2));
          logger.info(`Cookies saved successfully to: ${CONFIG.saveCookiesPath}`);
        } catch (err) {
          logger.error({ err, path: CONFIG.saveCookiesPath }, "Failed to save cookies to file.");
        }
      }
    } catch (err) {
      logger.fatal({ err }, "Interactive login failed.");
      if (loginBrowser) await loginBrowser.close();
      process.exit(1);
    } finally {
      if (loginBrowser) await loginBrowser.close();
    }
  }
  // --- End Interactive Login Flow ---

  // If cookies weren't captured interactively, try loading from file.
  if (cookies.length === 0 && CONFIG.cookiePath) {
    try {
      const cookiesJSON = await fs.promises.readFile(CONFIG.cookiePath, 'utf8');
      cookies = JSON.parse(cookiesJSON);
      logger.info({ path: CONFIG.cookiePath }, "Successfully loaded cookies for session sharing.");
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.fatal({ path: CONFIG.cookiePath }, "Cookie file specified with --cookies was not found.");
      } else {
        logger.fatal({ err, path: CONFIG.cookiePath }, "Failed to read or parse cookie file.");
      }
      process.exit(1); // Exit because the user explicitly requested this file.
    }
  } else if (cookies.length > 0) {
    logger.info("Proceeding with the captured session from the interactive login.");
  } else {
    logger.info("Proceeding without a pre-loaded session (no --interactive-login or --cookies provided).");
  }

  const initialVideoPromises = [];
  if (CONFIG.videos === 'all') {
    CRAWL_STATE.ytDlpNeeded = true;
  }
  for (const startUrl of CONFIG.startUrls) {
    const shouldDownloadVideo = (CONFIG.videos === 'all') || (CONFIG.videos === 'auto' && isDirectVideoUrl(startUrl));

    if (shouldDownloadVideo) {
      CRAWL_STATE.ytDlpNeeded = true;
      if (!CRAWL_STATE.processedVideos.has(startUrl)) {
        CRAWL_STATE.processedVideos.add(startUrl);
        CRAWL_STATE.activeVideoDownloads++;
        const videoPromise = downloadVideo(startUrl, startUrl, cookies)
          .then(localPath => {
            CRAWL_STATE.videoUrlMap.set(startUrl, localPath);
          })
          .catch(err => {
            logger.error({ err, url: startUrl }, 'Initial video download failed.');
          })
          .finally(() => {
            CRAWL_STATE.activeVideoDownloads--;
          });
        initialVideoPromises.push(videoPromise);
      }
    } else {
      // Start URLs get the highest possible priority.
      enqueue(startUrl, 0, Infinity);
    }
  }

  // --- Execution Path Decision ---

  if (CRAWL_STATE.ytDlpNeeded) {
    // Sanity check for yt-dlp only if it's potentially needed.
    try {
      await new Promise((resolve, reject) => {
        const check = spawn(CONFIG.ytDlpPath, ['--version']);
        check.on('error', reject);
        check.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp version check failed with code ${code}`)));
      });
    } catch (e) {
      logger.fatal(`Failed to execute '${CONFIG.ytDlpPath}'. Please ensure yt-dlp is installed and accessible in your PATH, or specify its location with --yt-dlp-path.`);
      process.exit(1);
    }
  }
  // If there are no pages to crawl (only initial videos), we can use a simpler, faster path.
  if (CRAWL_STATE.queue.length === 0) {
    logger.info("No pages to crawl. Running in video-only download mode.");
    try {
      await Promise.all(initialVideoPromises);
    } finally {
      await performShutdown("Video downloads complete", 0);
    }
    return; // End execution here for video-only mode.
  }

  // --- Full Crawl Path ---
  logger.info("Pages detected in queue. Starting full crawl mode.");
  await ensureDir(path.join(CONFIG.outDir, "_")); // Ensure base archive dir exists.

  const browser = await puppeteer.launch({
    headless: argv.showBrowser ? false : "new",
    protocolTimeout: CONFIG.protocolTimeout,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security"
    ],
  });
  CRAWL_STATE.browserInstance = browser;
  logger.info("Browser launched successfully.");

  const workers = Array.from({ length: CONFIG.concurrency }, (_, i) =>
    worker(browser, i + 1, cookies)
  );

  const monitorIntervalId = setInterval(async () => {
    const now = Date.now();
    if (CRAWL_STATE.shuttingDown) {
      clearInterval(monitorIntervalId);
      return;
    }

    // Global Timeout Check: A failsafe to ensure the crawl does not run indefinitely.
    if (CONFIG.globalTimeoutMs > 0 && now - CRAWL_STATE.stats.startTime > CONFIG.globalTimeoutMs) {
      logger.warn("Global timeout reached. Forcing shutdown...");
      // This is a hard exit; it will not wait for active workers to finish.
      clearInterval(monitorIntervalId);
      await performShutdown("Global Timeout", 1);
    }
    // Stall Timeout Check: Detects if the crawl has become stuck (no workers active, but queue is not empty).
    else if (CONFIG.stallTimeoutMs > 0 && now - CRAWL_STATE.stats.lastProgressTime > CONFIG.stallTimeoutMs && CRAWL_STATE.stats.activeWorkers === 0 && CRAWL_STATE.queue.length > 0) {
      logger.warn("Stall timeout reached. No progress has been made. Forcing shutdown...");
      // This is a hard exit, as the crawler is considered deadlocked.
      clearInterval(monitorIntervalId);
      await performShutdown("Stall Timeout", 1);
    }
    // Completion Check: The normal exit condition for a successful crawl.
    else if (CRAWL_STATE.queue.length === 0 && CRAWL_STATE.stats.activeWorkers === 0 && CRAWL_STATE.activeVideoDownloads === 0) {
      logger.info("Queue is empty and all workers are idle. Crawl is complete.");
      // The worker loops will exit, Promise.allSettled will resolve,
      // and the main `finally` block will handle the graceful shutdown.
      clearInterval(monitorIntervalId);
      await performShutdown("Crawl Complete", 0);
      return;
    }
  }, 5000); // Check every 5 seconds

  try {
    await Promise.allSettled([...workers]);
  } finally {
    clearInterval(monitorIntervalId); // Ensure interval is always cleared.
    await performShutdown("Crawl Complete", 0);
  }
}

/**
 * The worker function that pulls jobs from the queue and calls crawlPage.
 * @param {puppeteer.Browser} browser - The Puppeteer browser instance.
 * @param {number} workerId - The ID of this worker.
 * @param {Array} cookies - An array of cookie objects to set for the session.
 */
async function worker(browser, workerId, cookies) {
  logger.info(`[Worker ${workerId}] Started.`);
  // The worker loop now continues as long as the shutdown process has not been initiated.
  while (!CRAWL_STATE.shuttingDown) {
    // Check for other global stop conditions first.
    if (CRAWL_STATE.visited.size >= CONFIG.maxPages) {
      break;
    }

    const crawlJob = CRAWL_STATE.queue.pop();

    if (crawlJob) {
      const { url, depth, retries, crawlId } = crawlJob;

      if (depth > CONFIG.maxDepth) {
        logger.debug({ url, depth, crawlId }, "Skipping page: max depth exceeded");
        continue;
      }
      if (CRAWL_STATE.visited.has(url)) {
        continue;
      }

      logger.info({ crawlId, url }, `[Worker ${workerId}] Starting job.`);
      CRAWL_STATE.stats.activeWorkers++;
      try {
        await sleep(randInt(...INTERNAL_CONSTANTS.randomDelayMs));
        await crawlPage(browser, url, depth, cookies, crawlId);
        CRAWL_STATE.visited.add(url);
        CRAWL_STATE.stats.pagesCrawled++;
        CRAWL_STATE.stats.lastProgressTime = Date.now(); // Update progress time
        CRAWL_STATE.stats.consecutiveFailures = 0; // Reset on success
        logger.info({ crawlId, url }, `[Worker ${workerId}] Job finished successfully.`);
      } catch (err) {
        CRAWL_STATE.stats.consecutiveFailures++; // Increment on failure

        if (err.message.includes('Target closed') || err.message.includes('Session closed')) {
          logger.fatal({ workerId, url, crawlId, err: err.message }, "Browser connection lost. Shutting down.");
          return; // Exit the worker, finally block will still run.
        }

        if (err.name === 'TimeoutError' || /timeout/i.test(err.message)) {
          logger.warn({ url, crawlId }, "Navigation timeout. Activating cool-down as a precaution.");
          activateRateLimitCoolDown({}, url);
        }

        const statusMatch = err.message.match(/status (\d{3})/);
        if (statusMatch) {
          const statusCode = parseInt(statusMatch[1], 10);
          if (INTERNAL_CONSTANTS.PERMANENT_ERROR_STATUS_CODES.has(statusCode)) {
            logger.error({ url, crawlId, status: statusCode }, "Permanent error, giving up on this URL.");
            continue; // Give up, finally block will still run.
          }
        }

        logger.warn({ workerId, url, crawlId, err: err.message }, "Crawl failed for page");

        if (CRAWL_STATE.stats.consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
          logger.fatal({ count: CRAWL_STATE.stats.consecutiveFailures }, "Max consecutive failures reached. Shutting down.");
          return; // Exit the worker, finally block will still run.
        }

        if (retries < INTERNAL_CONSTANTS.maxRetries) {
          logger.info(`[Worker ${workerId}] Re-queueing URL for later (attempt ${retries + 1}/${INTERNAL_CONSTANTS.maxRetries}): ${url}`);
          CRAWL_STATE.queue.push({ url, depth, retries: retries + 1, crawlId });
        } else {
          logger.error({ url, crawlId }, "Max retries reached for URL, giving up.");
        }
      } finally {
        CRAWL_STATE.stats.activeWorkers--;
      }
    } else {
      // The queue is empty, wait for more work or for the shutdown signal.
      await sleep(250);
    }
  }
  logger.info(`[Worker ${workerId}] Finished.`);
}

/**
 * The main crawling function for a single page.
 * @param {puppeteer.Browser} browser - The Puppeteer browser instance.
 * @param {string} url - The URL to crawl.
 * @param {number} depth - The current crawl depth.
 * @param {Array} cookies - An array of cookie objects to set for the session.
 * @param {string} crawlId - The unique ID for this crawl job.
 */
async function crawlPage(browser, url, depth, cookies, crawlId) {
  logger.info({ url, depth, crawlId }, "Crawling page");
  const page = await browser.newPage();
  let responseHandler; // To hold the listener function
  let pageCrawlError = null; // To capture async errors from listeners

  try {
    await page.setCacheEnabled(false);
    await page.setUserAgent(CONFIG.userAgent);

    // Load cookies before navigating to the page.
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    const responsePromises = new Map();
    const recursivelyDiscoveredUrls = [];
    const setError = (err) => { if (!pageCrawlError) pageCrawlError = err; };
    const responseHandler = await setupResponseListener(page, responsePromises, depth, setError, recursivelyDiscoveredUrls, cookies);

    page.setDefaultNavigationTimeout(INTERNAL_CONSTANTS.navTimeoutMs);
    const mainResponse = await page.goto(url, { waitUntil: INTERNAL_CONSTANTS.waitUntil });

    // Check main page response immediately.
    if (!mainResponse) {
      throw new Error("Main page navigation failed: No response received.");
    }
    if (!mainResponse.ok()) {
      const status = mainResponse.status();
      if (INTERNAL_CONSTANTS.RETRYABLE_STATUS_CODES.has(status)) {
        activateRateLimitCoolDown(mainResponse.headers(), url);
      }
      // This will be caught by the worker and trigger a retry for the whole page.
      throw new Error(`Main page navigation failed with status ${status}`);
    }

    await autoScroll(page);

    // Check if any async asset request has already set an error.
    if (pageCrawlError) throw pageCrawlError;

    logger.debug({ crawlId }, "Discovering links and assets...");
    const discoveredUrls = await discoverLinksAndAssets(page);

    // discoveredUrls is now an array of objects: [{url, context}]
    // Handle URLs found recursively inside CSS files (they have no special context)
    for (const recursiveUrl of recursivelyDiscoveredUrls) {
      discoveredUrls.push({ url: recursiveUrl, context: 'body' });
    }

    // De-duplicate URLs, keeping the one with the highest-priority context
    const uniqueLinks = new Map();
    const contextPriority = { nav: 3, header: 2, body: 1, footer: 0 };
    for (const link of discoveredUrls) {
        const existing = uniqueLinks.get(link.url);
        if (!existing || (contextPriority[link.context] > contextPriority[existing.context || 'footer'])) {
            uniqueLinks.set(link.url, link);
        }
    }
    logger.debug({ crawlId, count: uniqueLinks.size }, "Discovery complete.");

    // Predict records for all discovered URLs *before* rewriting.
    // This ensures the rewriter knows where to point links.
    for (const link of uniqueLinks.values()) {
      const isNavigable = looksNavigable(link.url);
      const isVideo = isDirectVideoUrl(link.url);

      if (CONFIG.videos !== 'none' && isVideo && !CRAWL_STATE.processedVideos.has(link.url)) {
        CRAWL_STATE.processedVideos.add(link.url);
        
        // Use an IIFE to handle the async video processing without blocking the main loop.
        (async () => {
          try {
            CRAWL_STATE.activeVideoDownloads++;
            // First, quickly get the final path. This is a fast operation.
            const localPath = await getVideoFilePath(link.url, url, cookies);
            // With the path known, register it for link rewriting immediately.
            CRAWL_STATE.videoUrlMap.set(link.url, localPath);

            // Now, start the actual download as a background task.
            // We don't await this, allowing the crawl to continue.
            downloadVideo(link.url, url, cookies)
              .catch(err => {
                logger.error({ err, url: link.url }, 'Video download failed permanently in background.');
                // If the download fails, remove it from the map so links don't point to a missing file.
                CRAWL_STATE.videoUrlMap.delete(link.url);
              })
              .finally(() => {
                CRAWL_STATE.activeVideoDownloads--;
              });
          } catch (err) {
            logger.error({ err, url: link.url }, 'Failed to get video file path.');
            CRAWL_STATE.activeVideoDownloads--;
          }
        })();
      } else if (isNavigable && !isVideo) {
        const score = getLinkScore(link); // Pass the whole link object
        enqueue(link.url, depth + 1, score);
      }
      predictRecord(link.url, isNavigable, url);
    }

    // Check again before fetching more assets.
    if (pageCrawlError) throw pageCrawlError;

    // Re-construct the flat list of URL strings for the asset fetcher.
    const allDiscoveredUrlStrings = Array.from(uniqueLinks.keys());
    await fetchDiscoveredAssets(page, allDiscoveredUrlStrings, responsePromises);

    const capturedResponses = await resolveAssetResponses(responsePromises);

    // Final check before writing to disk.
    if (pageCrawlError) throw pageCrawlError;

    logger.debug({ crawlId, assets: capturedResponses.size }, "Archiving page and assets...");
    await archivePageAndAssets(page, url, capturedResponses);
    logger.info({ url, assets: capturedResponses.size, crawlId }, "Page processing complete");

  } finally {
    if (responseHandler) {
      page.off('response', responseHandler); // Explicitly remove the listener
    }
    await page.close();
  }
}


/**
 * Coordinates the in-memory rewriting and saving of the page and all its assets.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string} pageUrl - The URL of the main page.
 * @param {Map<string, object>} capturedResponses - A map of all captured assets for the page.
 */
async function archivePageAndAssets(page, pageUrl, capturedResponses) {
  const html = await page.content();
  const pageRecord = CRAWL_STATE.records.get(pageUrl) || predictRecord(pageUrl, true);
  const pageFile = pageRecord.filePath;

  const contentToSave = new Map();

  // Step 1: Process all captured assets. Rewrite CSS in memory.
  const processedCss = new Set();
  for (const [assetUrl, { buffer, contentType, status }] of capturedResponses.entries()) {
    if (assetUrl === pageUrl && isLikelyHtml(contentType)) continue; // Handle main page HTML last.

    const assetRecord = CRAWL_STATE.records.get(assetUrl) || predictRecord(assetUrl, false, pageUrl);
    const assetFile = assetRecord.filePath;
    let finalBuffer = buffer;

    if (CONFIG.rewriteCss && (contentType?.includes("text/css") || assetUrl.endsWith('.css')) && !processedCss.has(assetUrl)) {
      try {
        processedCss.add(assetUrl);
        const css = buffer.toString('utf8');
        const absolutize = makeAbsolutizer(assetUrl);
        const toRel = createRelativizer(assetFile);
        const newCss = rewriteCssUrls(css, absolutize, toRel);
        finalBuffer = Buffer.from(newCss);
      } catch (e) {
        logger.warn({ cssFile: assetFile, err: e.message }, "In-memory CSS rewrite failed");
      }
    }

    // --- MANIFEST REWRITING ---
    if (contentType?.includes("application/manifest+json") || assetUrl.endsWith('.webmanifest') || assetUrl.endsWith('manifest.json')) {
      try {
        const manifest = JSON.parse(buffer.toString('utf8'));
        const absolutize = makeAbsolutizer(assetUrl);
        const toRel = createRelativizer(assetFile);

        const rewriteUrl = (url) => {
          if (!url) return url;
          const abs = absolutize(url);
          return abs ? toRel(abs) : url;
        };

        if (manifest.icons && Array.isArray(manifest.icons)) {
          manifest.icons.forEach(icon => {
            if (icon.src) icon.src = rewriteUrl(icon.src);
          });
        }
        if (manifest.screenshots && Array.isArray(manifest.screenshots)) {
          manifest.screenshots.forEach(shot => {
            if (shot.src) shot.src = rewriteUrl(shot.src);
          });
        }
        if (manifest.start_url) manifest.start_url = rewriteUrl(manifest.start_url);

        finalBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
      } catch (e) {
        logger.warn({ manifestFile: assetFile, err: e.message }, "Manifest JSON rewrite failed");
      }
    }
    // --- END ---

    contentToSave.set(assetFile, { url: assetUrl, buffer: finalBuffer, contentType, status, isPage: false });
  }

  // Step 2: Rewrite the main HTML with the complete asset map and add it to the save queue.
  const rewrittenHtml = rewriteHtml(html, pageUrl, pageFile);
  contentToSave.set(pageFile, { url: pageUrl, buffer: Buffer.from(rewrittenHtml), contentType: "text/html", status: 200, isPage: true });

  // Step 3: Save all processed content to disk in parallel.
  const savePromises = Array.from(contentToSave.entries()).map(
    async ([filePath, { url, buffer, contentType, status, isPage }]) => {
      try {
        await ensureDir(filePath);
        await fs.promises.writeFile(filePath, buffer, { flag: "wx" });
        finalizeRecord(url, filePath, contentType, status, isPage, pageUrl);
        CRAWL_STATE.stats.assetsSaved++;
        CRAWL_STATE.stats.totalBytes += buffer.length;
      } catch (e) {
        if (e.code === 'EEXIST') {
          // If file exists, it was likely saved by another concurrent page crawl.
          // We still need to ensure its record is finalized for this context.
          finalizeRecord(url, filePath, contentType, status, isPage, pageUrl);
        } else {
          logger.error({ url: url, path: filePath, err: e.message }, "Failed to save file");
        }
      }
    }
  );

  await Promise.all(savePromises);
}

/**
 * Rewrites all links in an HTML document to point to their local, archived versions.
 * @param {string} html - The HTML content.
 * @param {string} baseUrl - The original URL of the page.
 * @param {string} sourcePath - The local file path where this HTML will be saved.
 * @returns {string} The rewritten HTML.
 */
function rewriteHtml(html, baseUrl, sourcePath) {
  const $ = cheerio.load(html);

  // Handle the <base> tag, which changes the context for all relative URLs.
  const baseElement = $("base[href]").first();
  const baseHref = baseElement.attr("href");
  const effectiveBase = baseHref
    ? new URL(baseHref, baseUrl).toString()
    : baseUrl;

  if (baseElement.length) {
    baseElement.remove(); // Remove the base tag as all links will be relative.
  }

  const absolutize = makeAbsolutizer(effectiveBase);
  const toRelative = createRelativizer(sourcePath);

  for (const [tag, attr] of URL_ATTRS) {
    for (const element of $(tag)) {
      const $element = $(element);
      const value = ($element.attr(attr) || "").trim();
      if (!value || value.startsWith("data:")) continue;

      if (attr === "srcset") {
        const newSrcset = processSrcset(value, absolutize, toRelative);
        $element.attr(attr, newSrcset);
      } else {
        const absoluteUrl = absolutize(value);
        if (!absoluteUrl) continue;
        $element.attr(attr, safeAttrUrl(toRelative(absoluteUrl)));
      }
    }
  }

  // Rewrite URLs inside inline style attributes and <style> tags.
  if (CONFIG.rewriteCss) {
    for (const element of $("*[style]")) {
      const $element = $(element);
      const style = $element.attr("style");
      if (!style) continue;
      const newStyle = rewriteCssUrls(style, absolutize, toRelative);
      $element.attr("style", newStyle);
    }

    for (const element of $("style")) {
      const $element = $(element);
      const styleText = $element.text();
      if (!styleText) continue;
      const newStyleText = rewriteCssUrls(styleText, absolutize, toRelative);
      $element.text(newStyleText);
    }
  }

  // Rewrite meta refresh tags.
  for (const element of $('meta[http-equiv="refresh"][content]')) {
    const $element = $(element);
    const content = $element.attr("content") || "";
    const match = content.match(/^\s*\d+\s*;\s*url=(.+)$/i);
    if (match) {
      const absoluteUrl = absolutize(match[1].trim());
      if (absoluteUrl) {
        $element.attr("content", `0; url=${toRelative(absoluteUrl)}`);
      }
    }
  }

  return $.html();
}

/**
 * Rewrites `url()` and `@import` paths in CSS text to be relative.
 * @param {string} cssText - The CSS content.
 * @param {function} absolutize - The absolutizer function for the context.
 * @param {function} toRelative - The relativizer function for the context.
 * @returns {string} The rewritten CSS text.
 */
function rewriteCssUrls(cssText, absolutize, toRelative) {
  let out = cssText;
  for (const regex of CSS_URL_REGEX) {
    // Reset state for global regex
    regex.lastIndex = 0;
    out = out.replace(regex, (match, quote, url) => {
      if (!url || url.startsWith("data:")) return match;
      const abs = absolutize(url);
      if (!abs) return match;
      const rel = toRelative(abs);
      // Use replace on the original match to preserve structure (e.g. @import)
      return match.replace(url, safeAttrUrl(rel));
    });
  }

  // --- @import Rewriting ---
  // Handle @import separately because it can accept a string literal directly,
  // unlike other CSS properties that require the url() function.
  IMPORT_REGEX.lastIndex = 0; // Reset state for global regex
  out = out.replace(IMPORT_REGEX, (match, urlQuote, urlPath, strQuote, strPath) => {
    const url = urlPath || strPath;
    if (!url || url.startsWith("data:")) return match;

    const abs = absolutize(url);
    if (!abs) return match;

    const rel = toRelative(abs);
    // Rebuild the match with the new relative path, preserving structure.
    return match.replace(url, safeAttrUrl(rel));
  });

  return out;
}

/**
 * Parses and rewrites all URLs within an image `srcset` attribute.
 * @param {string} srcsetValue - The srcset attribute value.
 * @param {function} absolutize - The absolutizer function.
 * @param {function} toRelative - The relativizer function.
 * @returns {string} The rewritten srcset value.
 */
function processSrcset(srcsetValue, absolutize, toRelative) {
  const newParts = [];
  // Regex to parse "url descriptor, url descriptor, ..."
  const srcsetRegex = /\s*([^\s,]+)(?:\s+((?:\d+(?:\.\d+)?[wx])|(?:\d+(?:\.\d+)?dpi)|(?:\d+(?:\.\d+)?x)))?\s*(?:,|$)/g;
  let match;

  while ((match = srcsetRegex.exec(srcsetValue)) !== null) {
    const url = match[1];
    const descriptor = match[2] || "";

    if (!url || url.startsWith("data:")) {
      newParts.push(match[0].trim());
      continue;
    }

    const abs = absolutize(url);
    if (abs) {
      const rel = toRelative(abs);
      newParts.push(`${safeAttrUrl(rel)}${descriptor ? " " + descriptor : ""}`);
    } else {
      newParts.push(match[0].trim());
    }
  }

  return newParts.length > 0 ? newParts.join(", ") : srcsetValue;
}

/**
 * Converts a URL into a local file path for the archive.
 * @param {string} rootDir - The archive root directory.
 * @param {string} url - The URL to convert.
 * @param {string} contentType - The content type of the resource.
 * @param {boolean} isPageHtml - Whether this resource is a primary HTML page.
 * @param {string} [forceExt=""] - An extension to force, if known.
 * @returns {string} The absolute local file path.
 */
function urlToFilePath(rootDir, url, contentType, isPageHtml, forceExt = "") {
  const urlObj = new URL(url);
  const hostDir = path.join(rootDir, urlObj.host);

  let segments = urlObj.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => sanitizeSegment(decodeURIComponentSafe(s)));

  const pathHasExt = path.extname(segments.at(-1) || "") !== "";
  let ext = forceExt || inferExtension(url, contentType);

  if (isPageHtml) {
    // If it's a page, ensure it has a .html extension.
    if (!pathHasExt) {
      segments.push("index.html");
    } else {
      segments[segments.length - 1] =
        path.basename(segments.at(-1), path.extname(segments.at(-1))) + ".html";
    }
    ext = ".html"; // Ensure ext is set for pages for the fallback logic
  } else {
    // For assets, add an extension if missing.
    if (!pathHasExt && !ext) {
      const base = segments.at(-1) || "asset";
      const h = hash(urlObj.search || urlObj.pathname).slice(0, 8);
      segments[segments.length - 1] = base + "-" + h;
    }
    if (ext && (!pathHasExt || ext !== path.extname(segments.at(-1)))) {
      if (!segments.length) segments.push("asset");
      segments[segments.length - 1] += ext;
    }
  }

  // Append a hash of the query string to the filename to differentiate assets.
  const queryKey = urlObj.search ? hash(urlObj.search).slice(0, 6) : "";
  if (queryKey) {
    const last = segments.at(-1) || "index";
    const base = path.basename(last, path.extname(last));
    const fileExt = path.extname(last);
    segments[segments.length - 1] = `${base}~${queryKey}${fileExt}`;
  }

  let finalPath = path.join(hostDir, ...segments);

  // --- Path Length Check & Fallback ---
  // If the generated path is too long, fall back to a hashed path to prevent file system errors.
  if (finalPath.length > INTERNAL_CONSTANTS.maxPathLength) {
    logger.warn({ url, path: finalPath, length: finalPath.length }, "Generated path exceeds max length, falling back to hashed path.");
    const originalPath = urlObj.pathname + urlObj.search;
    const pathHash = hash(originalPath);
    finalPath = path.join(hostDir, pathHash + ext);
  }

  return finalPath;
}

/**
 * Sets up a listener to capture all network responses for a page.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {Map<string, Promise>} responsePromises - A map to store promises for asset buffers.
 * @param {number} depth - The current crawl depth.
 * @param {Function} setError - A callback to signal an error to the parent crawlPage function.
 * @param {string[]} recursivelyDiscoveredUrls - An array to push URLs found in CSS into.
 * @param {Array} cookies - An array of cookie objects to set for the session.
 * @returns {Function} The event handler function that was attached.
 */
async function setupResponseListener(page, responsePromises, depth, setError, recursivelyDiscoveredUrls, cookies) {
  const responseHandler = (response) => {
    const responseUrl = normalizeUrl(response.url());
    if (!responseUrl || responsePromises.has(responseUrl) || CRAWL_STATE.shuttingDown) {
      return;
    }

    const status = response.status();
    const ok = status >= 200 && status < 300;

    // --- RATE LIMITING & RETRYABLE ERROR CHECK ---
    if (INTERNAL_CONSTANTS.RETRYABLE_STATUS_CODES.has(status)) {
      activateRateLimitCoolDown(response.headers(), responseUrl);
      // Signal the main crawlPage function to fail and trigger a retry for the whole page.
      setError(new Error(`Asset at ${responseUrl} was rate-limited with status ${status}.`));
      // Don't process this response further.
      responsePromises.set(responseUrl, Promise.resolve(null));
      return;
    }
    // --- END ---

    if (ok && response.request().resourceType() === "document" && CONFIG.followIframes) {
      enqueue(responseUrl, depth + 1);
    }

    if (!ok && !CONFIG.saveFailedResponses) {
      CRAWL_STATE.stats.failedResources++;
      return;
    }

    const promise = (async () => {
      try {
        const headers = response.headers();
        const contentType = headers["content-type"] || "";
        let buffer = null;
        if (ok) {
          try {
            const bufferPromise = response.buffer();
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Asset buffering timed out after ${CONFIG.assetTimeoutMs}ms`)), CONFIG.assetTimeoutMs)
            );
            buffer = await Promise.race([bufferPromise, timeoutPromise]);
          } catch (bufferErr) {
            if (bufferErr.message.includes('evicted from inspector cache')) {
              return await handleEvictedAsset(responseUrl, contentType, cookies, page.url());
            } else {
              throw bufferErr; // Re-throw other buffer errors
            }
          }

          // --- RECURSIVE CSS DISCOVERY ---
          if (contentType.includes("text/css") || responseUrl.endsWith(".css")) {
            const cssText = buffer.toString("utf8");
            const foundUrls = parseCssForUrls(cssText, responseUrl);
            for (const url of foundUrls) {
              recursivelyDiscoveredUrls.push(url);
            }
          }
          // --- END ---

        } else {
          buffer = Buffer.from(String(status));
        }
        return { buffer, contentType, status };
      } catch (err) {
        if (!CRAWL_STATE.shuttingDown && !err.message.includes("Target closed") && !err.message.includes("No data found for resource")) {
          logger.warn({ url: responseUrl, err: err.message }, "Could not buffer response");
        }
        return null;
      }
    })();
    responsePromises.set(responseUrl, promise);
  };
  page.on("response", responseHandler);
  return responseHandler;
}

/**
 * Discovers all links and assets on the page by evaluating DOM in the browser context.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @returns {Promise<string[]>} A promise that resolves to an array of discovered absolute URLs.
 */
async function discoverLinksAndAssets(page) {
  return page.evaluate(() => {
    const links = new Map(); // Use a Map to store unique URLs with their best-found context

    const addLink = (url, context = 'body') => {
      let resolvedUrl;
      try {
        if (!url || /^(javascript:|data:|mailto:|tel:)/i.test(url)) return;
        resolvedUrl = new URL(url, location.href).toString().split("#")[0];
      } catch {
        return; // Skip invalid URLs
      }

      // Use a priority system for context. If we find a link in the 'body' first,
      // and then later find the *same link* in the 'nav', we should update its context to 'nav'.
      const priority = { nav: 3, header: 2, body: 1, footer: 0 };
      const existing = links.get(resolvedUrl);

      if (!existing || (priority[context] > priority[existing.context || 'footer'])) {
        links.set(resolvedUrl, { context });
      }
    };

    // 1. Discover from <a> tags and determine context
    for (const el of document.querySelectorAll('a[href]')) {
      let context = 'body';
      if (el.closest('nav')) {
        context = 'nav';
      } else if (el.closest('header')) {
        context = 'header';
      } else if (el.closest('footer')) {
        context = 'footer';
      }
      addLink(el.getAttribute('href'), context);
    }
    
    // 2. Discover from other standard attributes (these get default 'body' context)
    const otherElements = document.querySelectorAll(
        '[src], [action], object[data], html[manifest], [poster]'
    );
    for (const el of otherElements) {
        addLink(el.getAttribute('src'));
        addLink(el.getAttribute('action'));
        addLink(el.getAttribute('data'));
        addLink(el.getAttribute('manifest'));
        addLink(el.getAttribute('poster'));
    }
    
    // 3. Discover from srcset (default 'body' context)
    for (const el of document.querySelectorAll('[srcset]')) {
        const srcset = el.getAttribute('srcset');
        if (srcset) {
            for (const part of srcset.split(',')) {
                const url = part.trim().split(/\s+/)[0];
                if (url) addLink(url);
            }
        }
    }

    // 4. Discover from CSS in <style> tags (default 'body' context)
    const parseCssText = (cssText) => {
        const urlRegex = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
        let match;
        while ((match = urlRegex.exec(cssText)) !== null) {
            if (match[2]) addLink(match[2]);
        }
    };
    document.querySelectorAll('[style]').forEach(el => parseCssText(el.getAttribute('style')));
    document.querySelectorAll('style').forEach(style => parseCssText(style.innerHTML));

    // Convert Map to the desired array format: [{ url, context }]
    return Array.from(links, ([url, { context }]) => ({ url, context }));
  });
}

/**
 * Scrolls the page to the bottom to trigger lazy-loaded content.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 */
async function autoScroll(page) {
  try {
    const needsScroll = await page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight);
    if (!needsScroll) return;

    await page.evaluate(async ({ scrollTimeoutMs, scrollStabilityChecks, scrollCheckIntervalMs }) => {
      await new Promise((resolve) => {
        const scrollTimeout = scrollTimeoutMs; // 15-second failsafe timeout.
        const stabilityChecks = scrollStabilityChecks;   // Require 3 stable checks before stopping.
        let lastHeight = -1;
        let stableCount = 0;

        const timer = setInterval(() => {
          const currentHeight = document.body.scrollHeight;
          if (currentHeight === lastHeight) {
            stableCount++;
          } else {
            stableCount = 0; // Reset if height changes.
            lastHeight = currentHeight;
          }

          if (stableCount >= stabilityChecks) {
            clearInterval(timer);
            resolve();
          } else {
            window.scrollTo(0, currentHeight);
          }
        }, scrollCheckIntervalMs); // Check every 250ms.

        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, scrollTimeout);
      });
    }, {
      scrollTimeoutMs: INTERNAL_CONSTANTS.scrollTimeoutMs,
      scrollStabilityChecks: INTERNAL_CONSTANTS.scrollStabilityChecks,
      scrollCheckIntervalMs: INTERNAL_CONSTANTS.scrollCheckIntervalMs,
    });
  } catch (err) {
    logger.warn({ url: page.url(), err: err.message }, "autoScroll failed, page might have navigated away.");
  }
}

/**
 * Waits for all asset promises to resolve and returns a map of captured assets.
 * @param {Map<string, Promise>} responsePromises - The map of asset promises.
 * @returns {Promise<Map<string, object>>} A map of URL -> {buffer, contentType, status}.
 */
async function resolveAssetResponses(responsePromises) {
  const allUrls = Array.from(responsePromises.keys());
  const allPromises = Array.from(responsePromises.values());
  const results = await Promise.all(allPromises);

  const captured = new Map();
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    // Ignore nulls and assets that were already saved directly to disk by the streaming fallback.
    if (result && !result.savedViaStream) {
      const url = allUrls[i];
      captured.set(url, result);
    }
  }
  return captured;
}

/**
 * A robust fetch wrapper that adds a timeout to the request.
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options.
 * @param {number} timeout - Timeout in milliseconds.
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeout}ms`));
    }, timeout)
  );

  const fetchPromise = fetch(url, { ...options, signal });

  return Promise.race([fetchPromise, timeoutPromise]);
}

/**
 * Triggers fetches for discovered assets that Puppeteer might have missed.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {string[]} discoveredUrls - Array of URLs discovered on the page.
 * @param {Map<string, Promise>} responsePromises - The map of asset promises.
 */
async function fetchDiscoveredAssets(page, discoveredUrls, responsePromises) {
  const discoveredAssets = discoveredUrls
    .map(u => normalizeUrl(u))
    .filter(u => u && !looksNavigable(u) && !responsePromises.has(u));

  if (discoveredAssets.length > 0) {
    logger.info({ count: discoveredAssets.length, url: page.url() }, "Fetching additional discovered assets...");
    await page.evaluate(urls => {
      const fetchWithTimeout = (url, timeout = 30000) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Request timed out')), timeout);
          fetch(url)
            .then(response => resolve(response))
            .catch(err => reject(err))
            .finally(() => clearTimeout(timer));
        });
      };
      return Promise.all(urls.map(url => fetchWithTimeout(url).catch(e => null)));
    }, discoveredAssets);
  }
}

/**
 * Sets up a listener to capture all network responses for a page.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 * @param {Map<string, Promise>} responsePromises - A map to store promises for asset buffers.
 * @param {number} depth - The current crawl depth.
 * @param {Function} setError - A callback to signal an error to the parent crawlPage function.
 * @returns {Function} The event handler function that was attached.
 */
async function handleEvictedAsset(responseUrl, contentType, cookies, pageUrl) {
  logger.warn({ url: responseUrl }, "Content evicted from cache, attempting robust fallback...");
  const isTextAsset = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json');
  const cookieString = (cookies || []).map(c => `${c.name}=${c.value}`).join('; ');

  try {
    const fetchResponse = await fetchWithTimeout(responseUrl, {
      headers: { 'User-Agent': CONFIG.userAgent, ...(cookieString && { 'Cookie': cookieString }) }
    }, CONFIG.navTimeoutMs); // Reuse nav timeout for assets
    if (!fetchResponse.ok) throw new Error(`Fallback fetch failed with status ${fetchResponse.status}`);

    if (isTextAsset) {
      logger.info({ url: responseUrl }, "Evicted text asset successfully buffered via fallback.");
      const bufferPromise = fetchResponse.arrayBuffer();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Fallback asset buffering timed out after ${CONFIG.assetTimeoutMs}ms`)), CONFIG.assetTimeoutMs)
      );
      const buffer = Buffer.from(await Promise.race([bufferPromise, timeoutPromise]));
      return { buffer, contentType, status: fetchResponse.status };
    } else {
      const record = predictRecord(responseUrl, false, pageUrl);
      if (!record || !record.filePath) throw new Error("Could not predict file path for evicted asset stream.");
      const filePath = record.filePath;

      await ensureDir(filePath);
      const fileStream = fs.createWriteStream(filePath, { flags: 'wx' });
      await pipeline(fetchResponse.body, fileStream);

      logger.info({ url: responseUrl, path: filePath }, "Fallback stream to disk successful.");
      finalizeRecord(responseUrl, filePath, contentType, fetchResponse.status, false, pageUrl);
      const stats = await fs.promises.stat(filePath);
      CRAWL_STATE.stats.assetsSaved++;
      CRAWL_STATE.stats.totalBytes += stats.size;
      return { buffer: null, contentType, status: fetchResponse.status, savedViaStream: true };
    }
  } catch (fallbackErr) {
    if (fallbackErr.code === 'EEXIST') {
      logger.info({ url: responseUrl }, "Asset already existed from another concurrent fallback stream.");
      return { buffer: null, contentType, status: 200, savedViaStream: true };
    }
    logger.error({ url: responseUrl, err: fallbackErr.message }, "Universal fallback failed.");
    return null;
  }
}

/**
 * Determines the final local path for a video without downloading it, using yt-dlp.
 * It includes fallback logic to handle filenames that are too long.
 * @param {string} videoUrl - The URL of the video.
 * @param {string|null} refererUrl - The referer URL.
 * @param {Array} cookies - An array of cookie objects.
 * @returns {Promise<string>} A promise that resolves with the predicted local file path.
 */
async function getVideoFilePath(videoUrl, refererUrl = null, cookies = []) {
  const videoHost = new URL(videoUrl).hostname.replace('www.', '');
  const outDir = path.join(CONFIG.outDir, videoHost);

  const runGetFilename = (outputTemplate) => {
    return new Promise(async (resolve, reject) => {
      let tempCookiePath = null;
      const args = [
        videoUrl,
        '--no-playlist',
        '--get-filename',
        '-o', outputTemplate,
      ];
      try {
        if (CONFIG.cookiePath) {
          args.push('--cookies', CONFIG.cookiePath);
        } else if (cookies && cookies.length > 0) {
          const netscapeCookies = cookies.map(c => {
            const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
            const httpOnly = c.httpOnly ? 'TRUE' : 'FALSE';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            return [domain, httpOnly, c.path, secure, c.expires || 0, c.name, c.value].join('\t');
          }).join('\n');
          tempCookiePath = path.join(os.tmpdir(), `webclone-cookies-${Date.now()}.txt`);
          await fs.promises.writeFile(tempCookiePath, netscapeCookies);
          args.push('--cookies', tempCookiePath);
        }
        
        const ytDlp = spawn(CONFIG.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdoutData = '', stderrData = '';
        ytDlp.stdout.on('data', (data) => { stdoutData += data.toString(); });
        ytDlp.stderr.on('data', (data) => { stderrData += data.toString(); });

        ytDlp.on('close', async (code) => {
          if (tempCookiePath) {
            await fs.promises.unlink(tempCookiePath).catch(() => {});
          }
          if (code === 0) {
            resolve(stdoutData.trim());
          } else {
            if (stderrData.includes('File name too long')) {
              return reject(new Error('FILE_NAME_TOO_LONG'));
            }
            reject(new Error(`yt-dlp --get-filename failed: ${stderrData}`));
          }
        });
        ytDlp.on('error', (err) => reject(err));
      } catch (err) {
        if (tempCookiePath) {
          await fs.promises.unlink(tempCookiePath).catch(() => {});
        }
        reject(err);
      }
    });
  };

  try {
    return await runGetFilename(path.join(outDir, '%(title)s.%(ext)s'));
  } catch (err) {
    if (err.message === 'FILE_NAME_TOO_LONG') {
      logger.warn({ url: videoUrl }, "Filename from title was too long, getting path with video ID.");
      return await runGetFilename(path.join(outDir, '%(id)s.%(ext)s'));
    }
    throw err;
  }
}

/**
 * Downloads a video from a given URL using yt-dlp, with a retry mechanism.
 * Automatically attempts to transform Facebook Watch URLs to Reel URLs for better compatibility.
 * @param {string} videoUrl - The URL of the video to download.
 * @returns {Promise<string>} A promise that resolves with the local file path of the downloaded video.
 */
async function downloadVideo(videoUrl, refererUrl = null, cookies = []) {
  let downloadUrl = videoUrl;
  try {
    const urlObj = new URL(videoUrl);
    if (urlObj.hostname.includes('facebook.com') && urlObj.pathname.includes('/watch/')) {
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        downloadUrl = `https://www.facebook.com/reel/${videoId}`;
        logger.info({ originalUrl: videoUrl, newUrl: downloadUrl }, "Attempting to transform Facebook Watch URL to Reel URL for compatibility.");
      }
    }
  } catch (e) {
    logger.warn({ err: e.message, url: videoUrl }, "Could not parse URL for potential transformation.");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= INTERNAL_CONSTANTS.videoMaxRetries; attempt++) {
    try {
      logger.info({ url: downloadUrl, attempt }, "Attempting to download video...");
      const filePath = await attemptSingleDownload(downloadUrl, refererUrl, cookies);
      return filePath; // Success
    } catch (err) {
      lastError = err;
      logger.warn({ url: downloadUrl, attempt, max: INTERNAL_CONSTANTS.videoMaxRetries, err: err.message }, "Video download attempt failed.");
      if (attempt < INTERNAL_CONSTANTS.videoMaxRetries) {
        const delay = randInt(...INTERNAL_CONSTANTS.randomDelayMs);
        logger.info(`Waiting ${delay}ms before next attempt...`);
        await sleep(delay);
      }
    }
  }
  logger.error({ url: downloadUrl, retries: INTERNAL_CONSTANTS.videoMaxRetries }, "All video download attempts failed.");
  throw lastError;
}

/**
 * Attempts a single video download using yt-dlp, with a filename fallback mechanism.
 * It first tries to save the video using its title. If the filename is too long, it retries
 * once using the video's unique ID. This function handles its own temporary cookie file
 * conversion and cleanup. It is called by `downloadVideo`, which manages broader download retries.
 * @param {string} videoUrl - The URL of the video to download.
 * @param {string|null} refererUrl - The referer URL.
 * @param {Array} cookies - An array of cookie objects to use for the download.
 * @returns {Promise<string>} A promise that resolves with the local file path.
 */
async function attemptSingleDownload(videoUrl, refererUrl = null, cookies = []) {
  const videoHost = new URL(videoUrl).hostname.replace('www.', '');
  const outDir = path.join(CONFIG.outDir, videoHost);
  let useIdAsFilename = false; // Flag to control filename strategy

  for (let i = 0; i < 2; i++) { // Max two attempts: one with title, one with ID (if title fails)
    let outputPathTemplate;
    if (useIdAsFilename) {
      outputPathTemplate = path.join(outDir, '%(id)s.%(ext)s');
      logger.info({ url: videoUrl }, "Retrying download with video ID as filename.");
    } else {
      outputPathTemplate = path.join(outDir, '%(title)s.%(ext)s');
    }
    
    let tempCookiePath = null;

    const args = [
      videoUrl,
      '--no-playlist',
      '-o', outputPathTemplate,
      '--clean-info-json',
    ];

    try {
      if (CONFIG.cookiePath) {
        args.push('--cookies', CONFIG.cookiePath);
      } else if (cookies && cookies.length > 0) {
        // Convert Puppeteer's JSON cookie format to the Netscape format required by yt-dlp.
        const netscapeCookies = cookies.map(c => {
          const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
          const httpOnly = c.httpOnly ? 'TRUE' : 'FALSE';
          const secure = c.secure ? 'TRUE' : 'FALSE';
          // Columns: domain, httpOnly, path, secure, expires, name, value
          return [domain, httpOnly, c.path, secure, c.expires || 0, c.name, c.value].join('\t');
        }).join('\n');

        tempCookiePath = path.join(os.tmpdir(), `webclone-cookies-${Date.now()}.txt`);
        await fs.promises.writeFile(tempCookiePath, netscapeCookies);
        args.push('--cookies', tempCookiePath);
      }

      const referer = refererUrl || new URL(videoUrl).origin;
      args.push('--referer', referer);
      args.push('--user-agent', CONFIG.userAgent);

      let formatString;
      if (CONFIG.videoResolution) {
        const H = CONFIG.videoResolution;
        const p1 = `best[height<=${H}][ext=mp4]`; // Priority 1: Ideal pre-merged MP4.
        const p2 = `best[height<=${H}]`; // Priority 2: Any pre-merged format at target res.
        const p3 = `worstvideo[height>${H}]+bestaudio`; // Priority 3: Next-highest resolution, merged.
        const p4 = `bestvideo+bestaudio/best`; // Priority 4: Absolute best, merged.
        formatString = `${p1}/${p2}/${p3}/${p4}`;
      } else {
        // Default if no resolution is specified: try pre-merged mp4, then any pre-merged, then merge the best.
        formatString = 'best[ext=mp4]/best/bestvideo+bestaudio';
      }
      args.push('-f', formatString);

      logger.info({ url: videoUrl, args }, 'Spawning yt-dlp process...');

      const ytDlp = spawn(CONFIG.ytDlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      CRAWL_STATE.activeDownloadProcesses.add(ytDlp);
      let stdoutData = '';
      let stderrData = '';

      ytDlp.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      ytDlp.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      const cleanup = async () => {
        CRAWL_STATE.activeDownloadProcesses.delete(ytDlp);
        if (tempCookiePath) {
          await fs.promises.unlink(tempCookiePath).catch(err => {
            logger.warn({ err, path: tempCookiePath }, "Could not delete temporary cookie file.");
          });
        }
      };

      const downloadPromise = new Promise((resolveInner, rejectInner) => {
        ytDlp.on('close', async (code) => {
          cleanup();
          if (code === 0) {
            let finalPath = null;
            let match = stdoutData.match(/\[download\] Destination: (.*)/) || stdoutData.match(/\[download\] (.*) has already been downloaded/);
            if (match && match[1]) {
              finalPath = match[1].trim();
            }

            if (finalPath) {
              logger.info({ url: videoUrl, path: finalPath }, 'Video download complete.');
              try {
                const stats = await fs.promises.stat(finalPath);
                CRAWL_STATE.stats.totalBytes += stats.size;
              } catch (err) {
                logger.warn({ err, path: finalPath }, "Could not get file stats for downloaded video.");
              }
              resolveInner(finalPath);
            } else {
              const videoTitleRegex = /\[info\] (?:(?:NA|Downloading)\s+page|Extracting\s+data|Resolving\s+extractor|Downloading\s+m3u8)\s+for\s+"([^"]+)"/;
              const titleMatch = stdoutData.match(videoTitleRegex);
              const videoTitle = titleMatch ? titleMatch[1] : null;

              if (videoTitle) {
                try {
                  const files = await fs.promises.readdir(outDir);
                  const foundFile = files.find(f => f.includes(videoTitle));
                  if (foundFile) {
                    finalPath = path.join(outDir, foundFile);
                    logger.info({ url: videoUrl, path: finalPath }, 'Located pre-existing video download.');
                    try {
                      const stats = await fs.promises.stat(finalPath);
                      CRAWL_STATE.stats.totalBytes += stats.size;
                    } catch (err) {
                      logger.warn({ err, path: finalPath }, "Could not get file stats for pre-existing video.");
                    }
                    resolveInner(finalPath);
                  } else {
                    rejectInner(new Error(`yt-dlp succeeded, but failed to parse final file path or find existing file. Stdout: ${stdoutData}`));
                  }
                } catch (err) {
                  rejectInner(new Error(`yt-dlp succeeded, but could not read output directory to find existing file. Stderr: ${stderrData}`));
                }
              } else {
                rejectInner(new Error(`yt-dlp succeeded, but failed to parse final file path. Stdout: ${stdoutData}`));
              }
            }
          } else {
            let errorMsg = `yt-dlp process exited with code ${code}. Stderr: ${stderrData}`;
            if (stderrData.includes('Cannot parse data') || stderrData.includes('please report this issue')) {
              errorMsg += "\nHint: This often means your yt-dlp is outdated. Please try updating it with 'yt-dlp -U'";
            }
            if (stderrData.includes('File name too long')) {
              return rejectInner(new Error('FILE_NAME_TOO_LONG'));
            }
            rejectInner(new Error(errorMsg));
          }
        });

        ytDlp.on('error', (err) => {
          cleanup();
          rejectInner(new Error(`Failed to start yt-dlp process: ${err.message}`));
        });
      });
      return await downloadPromise;
    } catch (err) {
      if (tempCookiePath) {
        await fs.promises.unlink(tempCookiePath).catch(unlinkErr => {
          logger.warn({ err: unlinkErr, path: tempCookiePath }, "Could not delete temporary cookie file during error handling.");
        });
      }
      // If the error is 'FILE_NAME_TOO_LONG', and we haven't tried with ID yet, set flag and continue loop.
      if (err.message === 'FILE_NAME_TOO_LONG' && !useIdAsFilename) {
        useIdAsFilename = true; // Try with ID in the next loop iteration
      } else {
        throw err; // Re-throw other errors or if already tried with ID
      }
    }
  }
  // If we exit the loop, it means both attempts failed.
  throw new Error("Video download failed after attempting both title and ID filenames.");
}

/**
 * Calculates a priority score for a URL based on heuristics.
 * @param {string} url - The URL to score.
 * @returns {number} A numerical score (higher is higher priority).
 */
function getLinkScore(link) { // link is an object: { url, context }
  // 1. Context Scoring
  if (link.context === 'nav' || link.context === 'header') return 10;
  if (link.context === 'footer') return 1;

  try {
    const urlObj = new URL(link.url);
    const path = urlObj.pathname.toLowerCase();
    const pathDepth = path.split('/').filter(Boolean).length;

    // 2. URL Pattern Scoring
    if (path.includes('/archive') || path.includes('/tags/') || path.includes('/category/') || urlObj.search.includes('page=')) {
      return 2; // Low priority
    }

    // 3. Path Depth-based scoring
    if (pathDepth <= 1) return 8; // High priority for top-level pages
    if (pathDepth > 4) return 3; // Lower priority for very deep pages
    
    // 4. Default score for 'body' context
    return 5;
  } catch {
    return 5; // Default score on URL parsing error
  }
}

/* ---------- CRAWL QUEUE ---------- */
/**
 * Adds a URL to the crawl queue if it's valid and hasn't been seen before.
 * @param {string} url - The URL to enqueue.
 * @param {number} depth - The current crawl depth.
 */
/**
 * Finds the correct index to insert a new job into the sorted queue
 * using binary search to maintain priority order.
 * @param {object} job - The crawl job to be inserted.
 * @returns {number} The index at which to insert the job.
 */
function getInsertIndex(job) {
    let low = 0;
    let high = CRAWL_STATE.queue.length;

    // The comparator function defines the sort order.
    // The goal is to have the highest score at the END of the array for efficient pop().
    // So, we sort by: 1. ascending score, 2. descending depth (so lower depth is at the end).
    const compare = (a, b) => {
        if (a.score !== b.score) {
            return a.score - b.score;
        }
        return b.depth - a.depth;
    };

    while (low < high) {
        const mid = (low + high) >>> 1; // Integer division
        if (compare(job, CRAWL_STATE.queue[mid]) >= 0) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function enqueue(url, depth, score = 5) {
  const norm = normalizeUrl(url);
  if (!norm || CRAWL_STATE.enqueued.has(norm) || CRAWL_STATE.visited.has(norm)) return;

  // --- Crawl Scope Enforcement ---
  if (CONFIG.crawlScope !== 'cross-domains') {
    try {
      const urlHost = new URL(norm).hostname;
      if (CONFIG.crawlScope === 'same-domain') {
        if (!CRAWL_STATE.initialHosts.has(urlHost)) {
          logger.debug({ url: norm, scope: 'same-domain' }, "Skipping URL: outside of initial hosts.");
          return;
        }
      } else if (CONFIG.crawlScope === 'subdomains') {
        const urlBaseDomain = getBaseDomain(urlHost);
        if (!CRAWL_STATE.initialBaseDomains.has(urlBaseDomain)) {
          logger.debug({ url: norm, scope: 'subdomains' }, "Skipping URL: outside of initial base domains.");
          return;
        }
      }
    } catch (e) {
      logger.warn({ url: norm, err: e.message }, "Could not parse URL for scope check.");
      return; // Don't enqueue if URL is malformed.
    }
  }
  // --- End Enforcement ---

  const crawlId = hash(norm).slice(0, 8);
  CRAWL_STATE.enqueued.add(norm);

  const job = { url: norm, depth, retries: 0, crawlId, score };

  // Find the correct insertion point in the sorted queue and insert.
  const index = getInsertIndex(job);
  CRAWL_STATE.queue.splice(index, 0, job);

  predictRecord(norm, true);
}

/* ---------- PREDICTION / FINALISATION ---------- */
/**
 * Predicts the file path and metadata for a URL before it's downloaded.
 * This is crucial for the rewriter to know the future location of a link.
 * @param {string} url - The URL to predict.
 * @param {boolean} [guessIsPage=false] - Whether to guess this URL is a page.
 * @param {string|null} [foundOnUrl=null] - The URL of the page where this link was found.
 * @returns {object|undefined} The predicted record object, or undefined if URL is invalid.
 */
function predictRecord(url, guessIsPage = false, foundOnUrl = null) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;

  const existingRecord = CRAWL_STATE.records.get(normalizedUrl);
  // If a record is already finalized (i.e., saved), it must not be overwritten by a new prediction.
  if (existingRecord && existingRecord.predicted === false) {
    return existingRecord;
  }

  const extension = path.extname(new URL(normalizedUrl).pathname).toLowerCase();
  const looksPage =
    guessIsPage ||
    HTML_LIKE_EXTENSIONS.has(extension) ||
    !extension;

  const filePath = urlToFilePath(
    CONFIG.outDir,
    normalizedUrl,
    looksPage ? "text/html" : "",
    looksPage
  );
  const rec = {
    filePath,
    contentType: looksPage ? "text/html" : "",
    status: 0,
    isPage: !!looksPage,
    predicted: true,
    originalUrl: foundOnUrl || normalizedUrl
  };
  CRAWL_STATE.records.set(normalizedUrl, rec);
  return rec;
}

/**
 * Finalizes the metadata record for a URL after it has been downloaded.
 * @param {string} url - The original URL.
 * @param {string} filePath - The final local file path.
 * @param {string} contentType - The final content type.
 * @param {number} status - The HTTP status code.
 * @param {boolean} isPage - Whether this was a primary HTML page.
 * @param {string|null} [foundOnUrl=null] - The URL of the page where this link was found.
 */
function finalizeRecord(url, filePath, contentType, status, isPage, foundOnUrl = null) {
  const existing = CRAWL_STATE.records.get(url);

  // If the record has already been finalized by another worker, do not touch it.
  // This is the core guard that prevents the read-modify-write race condition.
  if (existing && existing.predicted === false) {
    return;
  }

  CRAWL_STATE.records.set(url, {
    filePath,
    contentType,
    status,
    isPage: !!isPage,
    predicted: false, // Mark as finalized
    originalUrl: foundOnUrl || existing?.originalUrl || url
  });
}

/* ---------- HELPERS ---------- */
/**
 * Extracts the base domain from a hostname.
 * e.g., 'sub.example.co.uk' -> 'example.co.uk'
 * @param {string} hostname - The hostname to parse.
 * @returns {string} The base domain.
 */
function getBaseDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) {
    return hostname;
  }
  // Handles cases like .co.uk, .com.au, etc. by taking the last two parts.
  return parts.slice(-2).join('.');
}

/**
 * Normalizes a URL string for consistent processing.
 * Removes fragments, decodes pathname, and trims whitespace.
 * @param {string} urlString - The URL string to normalize.
 * @returns {string} The normalized URL, or an empty string if invalid.
 */
function normalizeUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return '';
  let urlStr = urlString.trim().replace(/\s+/g, ' ');   // also collapse inner spaces
  try {
    const url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) return '';
    url.hash = ''; // remove fragments
    url.pathname = decodeURIComponent(url.pathname); // %20 -> ' ' then re-encoded by URL

    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // Remove zero-width spaces and other invisible characters
    return url.toString().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  } catch {
    // Fallback for invalid URLs or mailto: links
    return urlStr.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  }
}

/**
 * Checks if a content type string is likely to be HTML.
 * @param {string} contentType - The content-type string.
 * @returns {boolean}
 */
function isLikelyHtml(contentType) {
  return String(contentType || "").toLowerCase().includes("text/html");
}

/**
 * Ensures that the directory for a given file path exists.
 * @param {string} filePath - The full file path.
 */
async function ensureDir(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Creates an MD5 hash of a string.
 * @param {string} str - The string to hash.
 * @returns {string} A hex-encoded hash.
 */
function hash(str) {
  return crypto.createHash("md5").update(String(str)).digest("hex");
}

/**
 * Sanitizes a string to be used as a valid file or directory name segment.
 * @param {string} str - The string to sanitize.
 * @returns {string} The sanitized string.
 */
function sanitizeSegment(str) {
  return str
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_") // Replace invalid file characters
    .replace(/\s+/g, " ") // Collapse whitespace
    .slice(0, INTERNAL_CONSTANTS.maxSegmentLength); // Truncate long segments
}

/**
 * Safely decodes a URI component, returning the original string on error.
 * @param {string} str - The string to decode.
 * @returns {string}
 */
function decodeURIComponentSafe(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Generates a random integer within a given range (inclusive).
 * @param {number} min - The minimum value.
 * @param {number} max - The maximum value.
 * @returns {number}
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Parses rate limit headers and activates a global cool-down period for all workers.
 * @param {object} headers - The response headers object.
 * @param {string} url - The URL that was rate-limited.
 */
function activateRateLimitCoolDown(headers, url) {
  // Default backoff of 5-10 seconds if no Retry-After header is found.
  let coolDownMs = randInt(...INTERNAL_CONSTANTS.defaultBackoffMs);
  const retryAfter = headers['retry-after'];

  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      coolDownMs = seconds * 1000;
      logger.warn({ url, after: `${seconds}s` }, "Server requested a cool-down (Retry-After header). Pausing all crawling.");
    } else {
      // It might be a date string like "Mon, 13 Oct 2025 23:59:59 GMT"
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        coolDownMs = date.getTime() - Date.now();
        logger.warn({ url, after: retryAfter }, "Server requested a cool-down (Retry-After header). Pausing all crawling.");
      }
    }
  } else {
    logger.warn({ url }, "Rate limit detected without Retry-After header. Applying default backoff.");
  }

  // Set the global cool-down timestamp. Ensure it's not negative.
  const newCoolDownUntil = Date.now() + Math.max(0, coolDownMs);
  // Only extend the cool-down, don't shorten it if another request has a shorter time.
  if (newCoolDownUntil > CRAWL_STATE.coolDownUntil) {
    CRAWL_STATE.coolDownUntil = newCoolDownUntil;
  }
}

/**
 * Infers a file extension from a URL and/or content type.
 * @param {string} urlString - The URL.
 * @param {string} [contentType=""] - The content type.
 * @returns {string} The inferred extension (e.g., '.html'), or an empty string.
 */
function inferExtension(urlString, contentType = "") {
  contentType = (contentType || "").split(";")[0].trim().toLowerCase();
  if (EXT_MAP.has(contentType)) return EXT_MAP.get(contentType);

  try {
    const url = new URL(urlString);
    const ext = path.extname(url.pathname);
    // Add a length check to avoid misinterpreting long path segments as extensions.
    if (ext && ext.length <= 10) return ext;

    // Look for hints in query parameters (e.g., ?format=jpg)
    const hints = ["format", "ext", "type"];
    for (const hint of hints) {
      const val = (url.searchParams.get(hint) || "").toLowerCase();
      if (val && val.length <= 6 && /^[a-z0-9]+$/.test(val)) return "." + val;
    }
  } catch {}
  return "";
}

/**
 * Parses CSS text to find all linked URLs (e.g., in @import, url()).
 * @param {string} cssText - The CSS content to parse.
 * @param {string} baseUrl - The base URL to resolve relative paths against.
 * @param {Array<{source: string, flags: string}>} cssRegexes - Serialized regexes.
 * @returns {Set<string>} A set of all absolute URLs found in the CSS.
 */
function parseCssForUrls(cssText, baseUrl) {
  const urls = new Set();
  const absolutize = makeAbsolutizer(baseUrl);
  const urlRegexes = [...CSS_URL_REGEX, IMPORT_REGEX];

  for (const regex of urlRegexes) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(cssText)) !== null) {
      // The URL is in one of the capture groups. Find the first one that's not undefined.
      const url = match[2] || match[4];
      if (url) {
        const absoluteUrl = absolutize(url);
        if (absoluteUrl) urls.add(absoluteUrl);
      }
    }
  }
  return urls;
}

/**
 * Encodes a URL for safe use in an HTML attribute, escaping quotes.
 * @param {string} url - The URL to process.
 * @returns {string} The safe URL.
 */
function safeAttrUrl(url) {
  if (!url) return url;
  if (url.startsWith("data:")) return url;
  // encodeURI handles spaces and unsafe characters, while preserving URL structure.
  return encodeURI(url).replace(/'/g, "%27").replace(/"/g, "%22");
}

/**
 * Determines if a URL is likely to be a navigable HTML page.
 * @param {string} url - The URL.
 * @returns {boolean}
 */
function looksNavigable(url) {
  try {
    const urlObj = new URL(url);
    const ext = path.extname(urlObj.pathname).toLowerCase();
    // True if it has no extension or a common HTML-like extension.
    return !ext || HTML_LIKE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/* ---------- REWRITING ---------- */
/**
 * Creates a function that resolves a URL relative to a base URL.
 * @param {string} baseUrl - The base URL for resolving relative paths.
 * @returns {function(string): (string|null)} A function that takes a URL and returns its absolute version.
 */
function makeAbsolutizer(baseUrl) {
  return (relativeUrl) => {
    if (!relativeUrl || /^(javascript:|data:|mailto:|tel:)/i.test(relativeUrl))
      return null;
    try {
      // Create a new URL, resolving the link against the page's base URL.
      // Also, remove the hash fragment.
      return new URL(relativeUrl, baseUrl).toString().split("#")[0];
    } catch {
      return null;
    }
  };
}

/**
 * Creates a function that calculates a relative path from a source file to a target URL's local path.
 * @param {string} sourcePath - The absolute path of the file containing the link.
 * @returns {function(string): string} A function that takes an absolute URL and returns a relative path.
 */
function createRelativizer(sourcePath) {
  return (targetUrl) => {
    if (targetUrl.startsWith("data:")) return targetUrl;
    const normalizedUrl = normalizeUrl(targetUrl);
    if (!normalizedUrl) return targetUrl;

    // --- Video Link Rewriting ---
    if (CRAWL_STATE.videoUrlMap.has(normalizedUrl)) {
      const videoPath = CRAWL_STATE.videoUrlMap.get(normalizedUrl);
      const fromDir = path.dirname(path.resolve(sourcePath));
      let relativePath = path.relative(fromDir, videoPath).replace(/\\/g, "/");
      if (!relativePath.startsWith("./") && !relativePath.startsWith("../")) {
        relativePath = "./" + relativePath;
      }
      return relativePath;
    }
    // --- End Video Link Rewriting ---

    const record = CRAWL_STATE.records.get(normalizedUrl);
    if (!record || !record.filePath) return targetUrl; // Return original if we don't have a record for it.

    try {
      const fromDir = path.dirname(path.resolve(sourcePath));
      const toFile = path.resolve(record.filePath);

      // Calculate the relative path and normalize separators for web use.
      let relativePath = path.relative(fromDir, toFile).replace(/\\/g, "/");

      // Ensure it's a valid relative link.
      if (!relativePath) return "./";
      if (!relativePath.startsWith("./") && !relativePath.startsWith("../")) {
        relativePath = "./" + relativePath;
      }

      return relativePath;
    } catch (e) {
      logger.warn({ from: sourcePath, to: targetUrl, err: e.message }, "Relativizer path calculation error");
      return targetUrl;
    }
  };
}

/**
 * Checks if a URL is a direct link to a video watch page.
 * @param {string} urlString The URL to check.
 * @returns {boolean}
 */
function isDirectVideoUrl(urlString) {
  try {
    const url = new URL(urlString);
    return DIRECT_VIDEO_URL_PATTERNS.some(pattern => pattern.test(url.href));
  } catch {
    return false;
  }
}

async function delayUntil(condition, { interval = 200, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (condition()) {
        resolve(true);
      } else if (Date.now() - start > timeout) {
        reject(new Error(`delayUntil timed out after ${timeout}ms`));
      } else {
        setTimeout(poll, interval);
      }
    };
    poll();
  });
}

/**
 * Rationale: This is the central, graceful shutdown function. It's designed to be
 * idempotent (callable multiple times) thanks to the `shuttingDown` flag. This is
 * crucial because it's invoked from three distinct contexts:
 *   1. The `main` function's `finally` block for a normal, successful exit.
 *   2. Signal handlers (`SIGINT`, `SIGTERM`) for user-initiated exits.
 *   3. The `worker`'s error handler for fatal, unrecoverable errors.
 *
 * The asynchronous operations within (waiting for videos, closing the browser) are
 * handled sequentially using async/await to ensure a reliable and graceful shutdown.
 *
 * Performs a graceful shutdown, closing the browser and finalizing the archive.
 * @param {string} reason - The reason for the shutdown (e.g., 'SIGINT', 'Crawl Complete').
 */
async function performShutdown(reason, exitCode = 0) {
  if (CRAWL_STATE.shuttingDown) {
    logger.info("Shutdown is already in progress.");
    return;
  }
  CRAWL_STATE.shuttingDown = true;
  logger.info({ reason }, "Initiating shutdown...");

  // Unregister handlers to prevent race conditions on exit.
  process.removeListener("SIGINT", sigintHandler);
  process.removeListener("SIGTERM", sigtermHandler);

  // 1. Terminate active downloads if exiting due to an error/signal.
  if (exitCode && (CRAWL_STATE.activeDownloadProcesses.size > 0)) {
    const processesToKill = Array.from(CRAWL_STATE.activeDownloadProcesses).reverse();
    logger.info(`Terminating ${processesToKill.length} active download process(es)...`);

    // 1. Gracefully signal all processes to terminate in parallel
    for (const proc of processesToKill) {
      logger.info({ reason }, `Signaling graceful shutdown for process: ${proc.pid}`);
      try {
        // Detach I/O listeners to prevent hangs
        proc.stdout?.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.kill('SIGTERM');
        await sleep(100);
      } catch (e) {
        logger.warn({ pid: proc.pid, err: e.message }, `Error sending SIGTERM to process, it may have already exited.`);
      }
    }

    // 2. Wait a moment for graceful shutdown
    if (CRAWL_STATE.activeDownloadProcesses.size) {
      await sleep(1000);
    }

    // 3. Forcefully kill any remaining stubborn processes
    for (const proc of processesToKill) {
      if (proc.exitCode === null) {
        logger.warn({ pid: proc.pid }, `Process did not terminate gracefully, forcing with SIGKILL.`);
        try {
          proc.removeAllListeners(); // Remove any remaining listeners (e.g., 'close')
          proc.kill('SIGKILL');
        } catch (e) {
          logger.warn({ pid: proc.pid, err: e.message }, `Error sending SIGKILL to process.`);
        }
      }
      // Clean up state tracking
      CRAWL_STATE.activeDownloadProcesses.delete(proc);
    }
  }

  // 2. Wait for any remaining video downloads to complete.
  if (CRAWL_STATE.activeVideoDownloads > 0) {
    logger.info(`Waiting for ${CRAWL_STATE.activeVideoDownloads} video(s) to finish downloading...`);
    try {
      await delayUntil(() => CRAWL_STATE.activeVideoDownloads <= 0, { timeout: 30000 });
      logger.info("All background downloads complete.");
    } catch (error) {
      logger.error({ err: error.message }, "Timeout waiting for downloads to complete. Some videos may not be saved.");
    }

    // Manually update the count since we can't rely on the 'finally' blocks anymore
    while (CRAWL_STATE.activeVideoDownloads) {
      CRAWL_STATE.activeVideoDownloads--;
      await sleep(100);
    }
  }

  // 3. Close the browser instance.
  if (CRAWL_STATE.browserInstance) {
    logger.info(`Terminating browser instance: ${CRAWL_STATE.browserInstance.process().pid}`);
    try {
      CRAWL_STATE.browserInstance.close().then(() => {
        CRAWL_STATE.browserInstance = null;
      });
      if (CRAWL_STATE.browserInstance != null) {
        // Don't wait for graceful close. Disconnect immediately and kill the process.
        CRAWL_STATE.browserInstance.disconnect();
        CRAWL_STATE.browserInstance.process()?.kill('SIGTERM');
        //CRAWL_STATE.browserInstance.process()?.kill('SIGKILL');
        CRAWL_STATE.browserInstance = null;
        logger.info("Browser forcefully terminated.");
      }
      if (CRAWL_STATE.browserInstance === null) {
        logger.info("Browser instance terminated.");
      }
    } catch (err) {
      logger.error({ err: err.message }, "Error during forceful browser termination.");
    }
  }

  // 4. Log final stats and exit immediately.
  const durationSeconds = ((Date.now() - CRAWL_STATE.stats.startTime) / 1000).toFixed(2);
  const totalMb = (CRAWL_STATE.stats.totalBytes / (1024 * 1024)).toFixed(2);

  logger.info("----------------------------------------");
  logger.info("           Crawl Complete");
  logger.info("----------------------------------------");
  logger.info(`  Pages Crawled:    ${CRAWL_STATE.stats.pagesCrawled}`);
  logger.info(`  Assets Saved:     ${CRAWL_STATE.stats.assetsSaved}`);
  logger.info(`  Total Size:       ${totalMb} MB`);
  logger.info(`  Failed Resources: ${CRAWL_STATE.stats.failedResources}`);
  logger.info(`  Duration:         ${durationSeconds}s`);
  logger.info("----------------------------------------");

  logger.info("Shutdown procedure complete. Exiting now.");

  logger.flush();
  
  await sleep(200);
  if (exitCode) {
    process.exit(exitCode);
  }
}

/* ---------------- GO ---------------- */
main().catch((err) => {
  logger.fatal({ err }, "A critical error occurred in the main process.");
  process.exit(1);
});


