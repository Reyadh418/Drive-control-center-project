const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function findCredentialsFile(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && /^client_secret.*\.json$/i.test(entry.name));

  if (!match) {
    throw new Error('Missing Google OAuth credentials file. Add a client_secret*.json file to the project root.');
  }

  return path.join(rootDir, match.name);
}

function loadCredentials(rootDir) {
  const filePath = findCredentialsFile(rootDir);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const config = raw.installed || raw.web;

  if (!config || !config.client_id || !config.client_secret) {
    throw new Error('The Google credentials file does not contain installed/web OAuth client details.');
  }

  return { filePath, config };
}

function createOAuthClient(rootDir, redirectUri) {
  const { config } = loadCredentials(rootDir);
  return new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
}

function buildAuthUrl(rootDir, redirectUri, accountId) {
  const { config } = loadCredentials(rootDir);
  const oauth2Client = new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'openid'
    ],
    state: String(accountId)
  });
}

async function exchangeCode(rootDir, redirectUri, code) {
  const oauth2Client = createOAuthClient(rootDir, redirectUri);
  const response = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(response.tokens);
  return { oauth2Client, tokens: response.tokens };
}

async function fetchGoogleProfile(oauth2Client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const response = await oauth2.userinfo.get();
  return response.data || {};
}

function createDriveClient(oauth2Client) {
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function buildOAuthClientFromTokens(rootDir, redirectUri, tokenData, onTokenRefresh) {
  const oauth2Client = createOAuthClient(rootDir, redirectUri);
  oauth2Client.setCredentials({
    access_token: tokenData.access_token || undefined,
    refresh_token: tokenData.refresh_token || undefined,
    expiry_date: tokenData.expiry_date || undefined,
    scope: tokenData.scope || undefined,
    token_type: tokenData.token_type || undefined
  });
  if (onTokenRefresh) {
    oauth2Client.on('tokens', (tokens) => {
      onTokenRefresh(tokens);
    });
  }
  return oauth2Client;
}

async function syncDriveAccount(rootDir, redirectUri, account, onBatch, onTokenRefresh) {
  const oauth2Client = buildOAuthClientFromTokens(rootDir, redirectUri, account, onTokenRefresh);
  const drive = createDriveClient(oauth2Client);

  const aboutResponse = await drive.about.get({
    fields: 'storageQuota,user',
    supportsAllDrives: true
  });

  const summary = aboutResponse.data || {};
  const quota = summary.storageQuota || {};
  const user = summary.user || {};

  const collected = [];
  let pageToken = undefined;

  do {
    const response = await drive.files.list({
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'user',
      fields: 'nextPageToken, files(id,name,mimeType,parents,modifiedTime,createdTime,size,md5Checksum,trashed,owners(displayName,emailAddress,photoLink),webViewLink,iconLink,starred,shared,driveId)',
      orderBy: 'modifiedTime desc'
    });

    const batch = (response.data.files || []).map((file) => ({
      drive_file_id: file.id,
      name: file.name || 'Untitled',
      mime_type: file.mimeType || null,
      size: Number(file.size || 0),
      md5_checksum: file.md5Checksum || null,
      parents: file.parents || [],
      trashed: Boolean(file.trashed),
      modified_time: file.modifiedTime || null,
      created_time: file.createdTime || null,
      owners: file.owners || [],
      web_view_link: file.webViewLink || null,
      icon_link: file.iconLink || null,
      starred: Boolean(file.starred),
      shared: Boolean(file.shared),
      drive_id: file.driveId || null
    }));

    collected.push(...batch);

    if (typeof onBatch === 'function') {
      onBatch(batch.length, collected.length);
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return {
    files: collected,
    summary: {
      storage_total: Number(quota.limit || 0),
      storage_used: Number(quota.usage || 0),
      storage_trash: Number(quota.usageInTrash || 0),
      storage_used_in_drive: Number(quota.usage || 0),
      email: user.email || null,
      display_name: user.name || null,
      picture_url: user.picture || null,
      client_id: null,
      sync_state: 'synced'
    }
  };
}

async function downloadDriveFile(rootDir, redirectUri, account, file, onTokenRefresh) {
  const oauth2Client = buildOAuthClientFromTokens(rootDir, redirectUri, account, onTokenRefresh);
  const drive = createDriveClient(oauth2Client);

  if (file.mime_type && file.mime_type.startsWith('application/vnd.google-apps.')) {
    const exportMimeType = file.mime_type === 'application/vnd.google-apps.spreadsheet'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : file.mime_type === 'application/vnd.google-apps.document'
        ? 'application/pdf'
        : 'application/pdf';

    return drive.files.export(
      { fileId: file.drive_file_id, mimeType: exportMimeType },
      { responseType: 'stream' }
    );
  }

  return drive.files.get(
    { fileId: file.drive_file_id, alt: 'media' },
    { responseType: 'stream' }
  );
}

async function deleteDriveFile(rootDir, redirectUri, account, file, onTokenRefresh) {
  const oauth2Client = buildOAuthClientFromTokens(rootDir, redirectUri, account, onTokenRefresh);
  const drive = createDriveClient(oauth2Client);
  await drive.files.delete({ fileId: file.drive_file_id, supportsAllDrives: true });
}

async function uploadDriveFile(rootDir, redirectUri, account, buffer, options, onTokenRefresh) {
  const oauth2Client = buildOAuthClientFromTokens(rootDir, redirectUri, account, onTokenRefresh);
  const drive = createDriveClient(oauth2Client);

  const response = await drive.files.create({
    requestBody: {
      name: options.name,
      parents: options.parents || undefined,
      mimeType: options.mimeType || 'application/octet-stream'
    },
    media: {
      mimeType: options.mimeType || 'application/octet-stream',
      body: buffer
    },
    fields: 'id, name, mimeType, webViewLink',
    supportsAllDrives: true
  });

  return response.data;
}

module.exports = {
  loadCredentials,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleProfile,
  syncDriveAccount,
  downloadDriveFile,
  deleteDriveFile,
  uploadDriveFile
};