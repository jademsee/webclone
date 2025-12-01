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
-   `--crawl-scope <scope>`: Crawl scope: `same-domain`, `subdomains`, `cross-domains` (default: `cross-domains`).
-   `--show-browser`: Run the browser in a visible window for debugging.
-   `--log-level <level>`: Set the logging level (`debug`, `info`, `warn`, `error`).

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/jademsee/webclone/issues).

## 📄 License

This project is licensed under the MIT License.