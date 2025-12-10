# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.1.0] - 2025-12-10

This release is a major update focused on improving the reliability and efficiency of video downloading, correcting cookie handling, and enhancing documentation.

### ✨ Features & Performance

*   **Intelligent Link Prioritization:** The script now uses a context-aware scoring system to prioritize important pages, ensuring more relevant content is archived first, especially in limited crawls.
*   **Efficient Video Archiving:** The script now determines a video's final filename *before* starting the download. This allows it to save the containing page immediately without waiting for large video downloads to complete, significantly speeding up crawls.
*   **Smart Filename Fallback:** When downloading videos, the script will now attempt to use the video's title for the filename. If the title is too long for the filesystem, it will automatically fall back to using the short video ID, preventing crashes.
*   **Improved Facebook Compatibility:**
    *   Transforms `/watch/` URLs to the more compatible `/reel/` format to improve download success with older versions of `yt-dlp`.
    *   Added the `--clean-info-json` flag to `yt-dlp` calls to handle anti-bot measures used by sites like Facebook.
*   **Better Error Logging:** If a video download fails because `yt-dlp` can't parse the data, the error message will now include a hint to update `yt-dlp`.

### 🐛 Bug Fixes

*   **Corrected Cookie Handling:** Fixed a critical bug where the cookie format for Puppeteer (JSON) and `yt-dlp` (Netscape) was inconsistent. User-facing cookie files are now consistently JSON, with on-the-fly conversion to Netscape format for `yt-dlp` handled internally and automatically.
*   **`--save-cookies` Now Works:** The interactive login flow now correctly saves the captured session cookies as a JSON file when the `--save-cookies` flag is used.
*   **Accurate Download Statistics:** Fixed a race condition where the size of downloaded videos was not always included in the final "Total Size" statistic.

### 📚 Documentation

*   Updated the main file header, function docstrings, and `README.md` to be consistent with the current cookie handling and video download logic.

---

## [1.0.2] - 2025-12-07

### 📚 Documentation

*   Improved documentation for the `--crawl-scope` feature in `README.md`.

### ⚙️ Miscellaneous

*   Improved asset discovery logic and performed general code cleanup.

## [1.0.1] - 2025-12-06

### 🐛 Bug Fixes

*   Resolved an issue where the script would crash if `yt-dlp` was not installed, even when video downloading was not required. The video downloader is now correctly treated as an optional dependency.
*   Updated `.gitignore` to exclude temporary files.

## [1.0.0] - 2025-12-01

*   Initial release of the `webclone.js` script.
