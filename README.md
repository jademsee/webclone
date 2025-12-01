# WebClone.js - Website and Video Archiver

`webclone.js` is a Node.js script designed to archive websites and download videos.

## Core Functionality

*   **Website Archiving:**
    *   Crawls websites starting from a given URL.
    *   Saves all pages and assets (CSS, JS, images, etc.).
    *   Rewrites all links to relative paths, creating a self-contained offline archive.
*   **Video Archiving:**
    *   Intelligently detects and downloads videos from popular streaming sites (e.g., YouTube, Vimeo, Dailymotion, TikTok, Facebook Reels, Bilibili) using `yt-dlp`.
    *   Rewrites embedded video links to point to local files.

## Prerequisites

*   Node.js (v18 or higher recommended).
*   Run `npm install` to install project dependencies.
*   For video downloading: `yt-dlp` and `ffmpeg` must be installed and available in your system's PATH.

## Usage

The script is executed from the command line:

```bash
node webclone.js [options] <start_url_1> [start_url_2] ...
```

To see a full list of options, run:
```bash
node webclone.js --help
```

## Key Features & Configuration Options

The script's behavior can be customized with the following command-line arguments:

*   `--cookies <path>`: Path to a JSON file containing browser cookies for authenticating with private sites.
*   `--interactive-login`: Opens a browser for you to log in manually before the crawl begins.
*   `--save-cookies <path>`: Specifies a path to save cookies after a successful interactive login.
*   `--out-dir <path>`: The root directory where the archive will be saved (default: `./archive`).
*   `--max-depth <num>`: Sets the maximum crawl depth (0 for start URLs only, default: 5).
*   `--max-pages <num>`: Sets the maximum number of pages to crawl (default: 600).
*   `--concurrency <num>`: The number of concurrent workers (browser pages) to use (default: 3).
*   `--max-consecutive-failures <num>`: The maximum number of consecutive page failures before stopping the crawl (default: 10).
*   `--user-agent <string>`: The User-Agent string to use for requests.
*   `--save-failed-responses`: If true, saves responses that failed (e.g., with 404 or 500 status codes).
*   `--rewrite-css`: Enables or disables the rewriting of CSS `url()` paths (default: true).
*   `--follow-iframes`: If true, the crawler will crawl content inside iframes (default: true).
*   `--protocol-timeout <ms>`: The Puppeteer protocol timeout in milliseconds (default: 90000).
*   `--videos <mode>`: Sets the video download mode. Options are `"auto"`, `"all"`, or `"none"` (default: `"auto"`).
*   `--video-resolution <height>`: The maximum desired video height (e.g., 1080, 720).
*   `--yt-dlp-path <path>`: A specific path to the `yt-dlp` executable.
*   `--crawl-scope <scope>`: Defines the scope of the crawl. Options are `"same-domain"`, `"subdomains"`, `"cross-domains"` (default: `"cross-domains"`).
*   `--global-timeout <minutes>`: Sets the maximum total crawl time in minutes (0 for no limit).
*   `--stall-timeout <minutes>`: The number of minutes without a successful page crawl before stopping (0 for no limit).
*   `--asset-timeout <seconds>`: The number of seconds to wait for an asset to buffer before timing out (default: 30).
*   `--show-browser`: Runs the browser in a visible window for debugging purposes.
*   `--log-level <level>`: Sets the logging level. Options are `debug`, `info`, `warn`, `error`, `fatal`.

## Dependencies

*   **Node.js Built-ins:** `fs`, `os`, `path`, `crypto`, `child_process`, `timers/promises`, `stream/promises`, `readline`
*   **cheerio**: For HTML parsing and manipulation.
*   **puppeteer-extra** & **puppeteer-extra-plugin-stealth**: For browser automation with stealth capabilities.
*   **pino**: For logging.
*   **yargs**: For parsing command-line arguments.

## Internal Architecture & State (`CRAWL_STATE`)

The script maintains a global state object (`CRAWL_STATE`) to manage the crawl process:

*   **Queue-based crawling:** `CRAWL_STATE.queue` holds the list of URLs to be crawled.
*   **Uniqueness Sets:** `CRAWL_STATE.enqueued` and `CRAWL_STATE.visited` track URLs to prevent redundant processing.
*   **Records:** `CRAWL_STATE.records` stores metadata (file path, content type, status) for every URL encountered, which is crucial for link rewriting.
*   **Rate-limiting:** `CRAWL_STATE.coolDownUntil` implements a global pause for all workers to respect `Retry-After` headers from servers.
*   **Statistics:** `CRAWL_STATE.stats` tracks various metrics like pages crawled, assets saved, and total bytes.
*   **Scope Control:** `CRAWL_STATE.initialHosts` and `CRAWL_STATE.initialBaseDomains` are used to enforce the boundaries of the crawl based on the configuration.
*   **Video State:** `CRAWL_STATE.processedVideos`, `CRAWL_STATE.videoUrlMap`, and `CRAWL_STATE.activeVideoDownloads` are used to manage the state of video downloads.

## Key Functions & Logic

*   `main()`: The primary function that initializes the crawl, handles the interactive login flow, launches the browser workers, and monitors the overall progress.
*   `worker()`: Pulls URLs from the queue and passes them to `crawlPage` for processing.
*   `crawlPage()`: Navigates to a page, discovers all links and assets, handles network responses, and orchestrates the archiving process.
*   `archivePageAndAssets()`: Coordinates the in-memory rewriting of HTML and CSS and saves all content to disk.
*   `rewriteHtml()`: Rewrites URLs found within HTML attributes and inline styles to point to their local, archived versions.
*   `rewriteCssUrls()`: Rewrites `url()` and `@import` paths within CSS content.
*   `downloadVideo()`: Manages video downloads by spawning `yt-dlp`, including retry logic and cookie handling.
*   `urlToFilePath()`: Converts a URL into a local file path, handling potential issues like path length limits and query parameters.
*   `setupResponseListener()`: Listens for all network responses from the browser to capture assets and recursively discover URLs within CSS files.
*   `handleEvictedAsset()`: Provides a robust fallback mechanism to re-fetch assets that may have been evicted from the browser's cache.
*   `autoScroll()`: Automatically scrolls the page to the bottom to trigger and load any lazy-loaded content.
*   **Helper Functions:** Includes various helpers for URL normalization (`normalizeUrl`), domain extraction (`getBaseDomain`), file extension inference (`inferExtension`), file system operations (`sanitizeSegment`), and data hashing (`hash`).
*   The script includes graceful shutdown handlers for `SIGINT` and `SIGTERM` to ensure a clean exit.
