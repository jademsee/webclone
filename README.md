# 🌐 WebClone.js - A Robust Website and Video Archiver

![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green?style=for-the-badge&logo=node.js)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

WebClone.js is a lean, asynchronous, and powerful command-line tool for creating complete, offline archives of websites. It crawls a site, saves all pages and assets (CSS, JS, images), rewrites links for local viewing, and can even detect and download videos from popular streaming platforms.

## 💡 Motivation

This project was born out of a specific need to archive comprehensive documentation from a dynamic website. Traditional tools like `wget` proved insufficient for handling modern web complexities, often failing to download all assets or correctly rewrite internal links. With the assistance of Gemini, this tool was developed to address those challenges, providing a more robust and intelligent solution for offline website and video archiving.

## ✨ Features

-   **Full Website Archiving**: Creates a fully self-contained offline copy of a website.
-   **Link Rewriting**: Intelligently rewrites all links (`<a>`, `<img>`, `<script>`, `<link>`, CSS `url()`, etc.) to relative paths for seamless offline browsing.
-   **Video Downloading**: Automatically detects and downloads videos from YouTube, Vimeo, TikTok, and other popular sites using `yt-dlp`.
-   **Authentication Support**: Archive content behind logins using session cookies.
    -   **Interactive Login**: Opens a browser for you to log in manually before starting the crawl.
    -   **Cookie File**: Use a `cookies.json` file exported from your browser.
-   **Highly Configurable**: Control every aspect of the crawl, including depth, concurrency, crawl scope (same-domain, subdomains), timeouts, and more.
-   **Stealth & Robustness**: Uses `puppeteer-extra` with a stealth plugin to avoid bot detection and includes built-in retries and rate-limiting cool-downs.
-   **Lazy-Loading Support**: Automatically scrolls pages to trigger and capture lazy-loaded content.

---

## ⚙️ Prerequisites

1.  **Node.js**: Version 18 or higher is recommended.
2.  **yt-dlp (Optional)**: Required for downloading videos. Must be installed and accessible in your system's `PATH`.
3.  **ffmpeg (Optional)**: Required by `yt-dlp` for merging high-quality video and audio streams.

---

## 🚀 Installation & Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/jademsee/webclone.git
    cd webclone
    ```

2.  **Install Node.js dependencies:**
    ```bash
    npm install
    ```

---

## Usage

The script is run from the command line with a starting URL.

```bash
node webclone.js [options] <start_url>
```

### Examples

**1. Basic Website Archive**
Archive a single public website.

```bash
node webclone.js https://www.example.com/
```

**2. Archive a Private Site (Login Required)**
Use the interactive login feature to authenticate, then save your session for future use.

```bash
# First time, log in and save your session
node webclone.js --interactive-login --save-cookies ./my-session.json https://private.example.com/dashboard

# Subsequent runs, use the saved session
node webclone.js --cookies ./my-session.json https://private.example.com/dashboard
```

**3. Download a Standalone Video**
The script will detect the video URL and download it.

```bash
node webclone.js https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

**4. Archive a Page and Its Embedded Videos**
Crawl an article and automatically download any embedded videos, rewriting the links to point to the local files.

```bash
node webclone.js https://my-blog.com/interesting-article
```

**5. Limit Crawl Scope and Depth**
Archive only pages on the same domain as the starting URL, going only one level deep.

```bash
node webclone.js --crawl-scope same-domain --max-depth 1 https://www.example.com/
```

**6. Full Help Menu**
For a complete list of all available options, run:

```bash
node webclone.js --help
```

---

## 🛠️ Key Configuration Options

-   `--cookies <path>`: Path to a `cookies.json` file.
-   `--out-dir <path>`: The directory to save the archive (default: `./archive`).
-   `--max-depth <num>`: Maximum crawl depth (default: 5).
-   `--concurrency <num>`: Number of concurrent browser pages to use (default: 3).
-   `--videos <mode>`: Video download mode: `auto`, `all`, or `none` (default: `auto`).
-   `--video-resolution <height>`: Maximum video height (e.g., `720`).
-   `--crawl-scope <scope>`: Controls which domains the crawler is allowed to visit. See "Understanding Crawl Scope" below. (`same-domain`, `subdomains`, `cross-domains` (default: `cross-domains`)).
-   `--show-browser`: Run the browser in a visible window for debugging.
-   `--log-level <level>`: Set the logging level (`debug`, `info`, `warn`, `error`).

---

### Understanding Crawl Scope

The `--crawl-scope` option is crucial for controlling which external domains the archiver will visit. It helps define the boundaries of your crawl and prevents it from straying too far from your intended target.

Here's how each scope option works:

*   **`cross-domains` (Default):**
    *   **Behavior:** This is the most permissive mode. The crawler will follow any navigable link it discovers, regardless of the domain. It will archive content from all linked websites.
    *   **Use Case:** Ideal for archiving an entire web presence, following external references, or when you don't want to restrict domain access.

*   **`same-domain`:**
    *   **Behavior:** This is the strictest mode. A discovered link will only be followed if its **exact hostname** matches one of the exact hostnames of your initial starting URLs. Links to subdomains or entirely different domains will be ignored.
    *   **Example:** If you start with `https://www.example.com/` and `https://blog.example.com/`, it will only crawl pages on `www.example.com` and `blog.example.com` respectively. A link from `www.example.com` to `sub.www.example.com` would be ignored.
    *   **Use Case:** Perfect for archiving a single, specific website without drifting into its subdomains or external sites.

*   **`subdomains`:**
    *   **Behavior:** This mode is a middle ground. A discovered link will be followed if its **base domain** matches the base domain of one of your initial starting URLs. This means it will crawl across different subdomains of your primary target but will ignore entirely different top-level domains.
    *   **Example:** If you start with `https://www.example.com/`, it will crawl `www.example.com`, `blog.example.com`, `shop.example.com`, etc., but will ignore `www.another-site.com`.
    *   **Use Case:** Useful for archiving a company's entire web presence, including various services hosted on different subdomains.

**Important Considerations:**

*   **Start URLs Always Crawled:** The URL(s) you provide as command-line arguments are always processed, regardless of the `--crawl-scope` setting. These URLs define the initial boundaries of your scope.
*   **Video Downloads:** URLs identified as direct video links (e.g., YouTube) are downloaded directly and are generally not subject to page-crawling scope rules.
*   **Link Type:** Only "navigable" links (those pointing to HTML-like content) are considered for increasing crawl depth and applying scope rules. Links to assets (images, CSS, JS) are downloaded as part of the current page but are not checked against crawl scope rules to determine if *they themselves* should be crawled.

### Exceptions to Crawl Scope Rules:

While the `--crawl-scope` option provides strong control, there are a few scenarios where its rules are not strictly applied or are bypassed:

*   **Initial Start URLs:** As mentioned above, the URL(s) you explicitly provide on the command line are always processed to kick off the crawl. They are considered within scope by definition.
*   **Direct Video Downloads:** URLs that are recognized as direct video links (e.g., to YouTube or Vimeo) are immediately handed off to the video downloading component (`yt-dlp`). These operations bypass the page-crawling scope checks.
*   **Dependent Assets (Images, CSS, Fonts, etc.):** The scope rules decide which **pages to navigate to**, not which assets to save. Once a page is deemed in-scope, the crawler will download all of its required assets (images, stylesheets, fonts) to ensure a complete archive, even if those assets are hosted on a different domain (like a CDN).
*   **Invalid/Malformed URLs:** Links that cannot be parsed into valid URLs are discarded before any scope rules can be applied.
*   **Rewritten Local Video Paths:** Once a video is downloaded, its URL is mapped to a local file, and these local paths are no longer subject to domain-based scope rules during rewriting.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/jademsee/webclone/issues).

## 📄 License

This project is licensed under the MIT License.