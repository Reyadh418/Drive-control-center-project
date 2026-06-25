# Drive Control Center (Drive Mess Console)

A premium, local-only web application to link multiple Google Drive accounts, build a local SQLite search index, inspect storage analytics, and manage files seamlessly from a unified, single-page dashboard.

![Drive Mess Console Banner](https://img.shields.io/badge/Stack-Node.js%20%7C%20Express%20%7C%20SQLite%20%7C%20TailwindCSS-sagegreen?style=for-the-badge)

---

## 🌟 Key Features

*   **Unified SPA Dashboard:** A sleek, dark-themed Single Page Application (SPA) styled with Tailwind CSS, featuring custom typography (*Instrument Sans* and *Cormorant Garamond*) and a responsive dual-pane layout.
*   **Multi-Account Indexing:** Securely connect up to 5 Google Drive accounts via OAuth 2.0. The application indexes metadata locally so you can browse instantly.
*   **Interactive File Explorer:**
    *   **Collapsible Folder Tree:** A sidebar folder tree dynamically populated from your local SQLite cache.
    *   **Path-Aware Breadcrumbs:** Clickable path segment navigation trails mapped directly to your Drive hierarchy.
    *   **Explorer Navigation History:** Standard back/forward navigation state support for browsing folders.
*   **Asset Thumbnail Caching:** Automatically retrieves and caches file preview thumbnails in the database for 1 hour, improving interface load speeds and conserving Google API rate limits.
*   **File Transfer & Operations:**
    *   **Cross-Account Transfers:** Copy or move files directly from one Google Drive account to another (handled securely using a temporary local bridge stream).
    *   **File Operations:** Direct uploads, downloads, and deletion prompts inside the dashboard.
*   **Storage Diagnostics & Analytics:**
    *   **Visual Storage Breakdown:** Beautiful charts powered by Chart.js representing space usage by file categories (Images, Video, Audio, Documents, Other).
    *   **MD5 Duplicate Detector:** Finds redundant files sharing identical MD5 checksums across all linked accounts, showing copies count and total wasted space.
    *   **Largest Files Directory:** Instantly highlights the largest space-consuming files in your storage.

---

## 🛠️ Architecture & Technology Stack

*   **Backend:** Node.js Express server.
*   **Database:** Local SQLite database leveraging Node's native `node:sqlite` engine.
*   **API Integrations:** Official Google API Client (`googleapis`) for OAuth 2.0 authorization flows and Drive v3 metadata retrieval.
*   **Frontend:** Modern static SPA leveraging Tailwind CSS (CDN/CLI integration), Chart.js for data visualization, and Font Awesome for icons.

---

## 🚀 Getting Started

### Prerequisites

*   **Node.js 20** or newer.
*   A Google Cloud Project with the **Google Drive API** enabled and configured for **OAuth 2.0**.

### Installation & Run

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Reyadh418/Drive-control-center-project.git
    cd Drive-control-center-project
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Place your OAuth credentials:**
    Download your OAuth client configuration JSON from the Google Cloud Console. Save it as `client_secret*.json` in the project root directory (e.g., `client_secret_xyz.json`).

4.  **Start the server:**
    ```bash
    npm start
    ```
    *For development with tailwind watches:*
    ```bash
    npm run dev
    ```

5.  **Open the app:**
    Navigate to `http://localhost:3000` in your web browser.

---

## 🔑 OAuth Redirect URI Configuration

If Google redirects with authorization errors, make sure you've added the callback URL to the **Authorized redirect URIs** in your Google Cloud Console Credentials page:

```text
http://localhost:3000/oauth2/callback
```

---

## 🛡️ Security & Privacy

> [!IMPORTANT]
> **Privacy First:** All cached indexing data, user info, and access tokens are kept 100% local inside `data/drive-control.sqlite`.
>
> **Private Credentials:** Your client secrets (`client_secret*.json`) contain sensitive API keys. They are ignored by Git in `.gitignore` and should never be pushed to version control.