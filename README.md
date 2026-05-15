# Drive Control Center

Local-only web app for linking multiple Google Drive accounts, indexing their files, and searching them from one place.

## What it does

- Link up to 5 Google Drive accounts with OAuth.
- Build a local SQLite index of file metadata.
- Search files across all accounts or filter to one account.
- View storage usage, recent files, and duplicate candidates.
- Download, upload, transfer, and delete files from the local UI.

## Run it locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Start the app with `npm start`.
4. Open `http://localhost:3000`.

## OAuth setup

This project expects a Google OAuth client JSON in the repo root. The app looks for a file named like `client_secret*.json` and uses the installed-app credentials inside it.

If Google rejects the callback URI, add `http://localhost:3000/oauth2/callback` as an authorized redirect URI in the OAuth client settings.

## Notes

- All data stays on your machine in `data/drive-control.sqlite`.
- The Google credentials file should remain private and should not be committed.
- Cross-account transfer is implemented as download from one account and upload to another, so Google Docs may be exported to a downloadable format instead of preserved natively.