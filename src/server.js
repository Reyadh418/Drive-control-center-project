const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const {
  initDatabase,
  listAccounts,
  createAccount,
  getAccount,
  updateAccountTokens,
  updateAccountSyncSummary,
  setAccountSyncState,
  replaceAccountFiles,
  rebuildPaths,
  listFiles,
  getFileById,
  getDashboard,
  deleteFileRecord
} = require('./db');
const {
  loadCredentials,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleProfile,
  syncDriveAccount,
  downloadDriveFile,
  deleteDriveFile,
  uploadDriveFile
} = require('./google');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(ROOT_DIR, 'data', 'drive-control.sqlite');
const REDIRECT_URI = `${APP_URL}/oauth2/callback`;

const db = initDatabase(DATABASE_PATH);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const app = express();

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';

function isFolder(file) {
  return String(file?.mime_type || '').includes('application/vnd.google-apps.folder');
}

function pathDepth(filePath) {
  return String(filePath || '')
    .split('/')
    .filter(Boolean)
    .length;
}

function buildBreadcrumbs(items) {
  return [{ label: 'Home', href: '/' }, ...(items || [])];
}

function renderPage(res, view, data = {}) {
  res.render(view, {
    ...data,
    breadcrumbs: buildBreadcrumbs(data.breadcrumbs)
  });
}

function buildExplorerState(dbInstance, accountId, folderId) {
  const account = getAccount(dbInstance, accountId);

  if (!account) {
    return null;
  }

  const allFiles = listFiles(dbInstance, { accountId, limit: 5000 });
  const currentFolder = folderId ? allFiles.find((file) => file.id === Number(folderId) && isFolder(file)) : null;
  const currentPath = currentFolder?.path || '';

  const directChildren = allFiles.filter((file) => {
    if (currentFolder) {
      if (!file.path || !currentPath || !file.path.startsWith(`${currentPath}/`)) {
        return false;
      }

      return pathDepth(file.path) === pathDepth(currentPath) + 1;
    }

    return pathDepth(file.path) === 1;
  });

  const folders = directChildren.filter(isFolder).sort((left, right) => left.name.localeCompare(right.name));
  const files = directChildren.filter((file) => !isFolder(file)).sort((left, right) => left.name.localeCompare(right.name));

  const breadcrumbs = [
    { label: 'Accounts', href: '/accounts' },
    { label: account.label, href: `/accounts/${account.id}` }
  ];

  if (currentFolder?.path) {
    const segments = currentFolder.path.split('/').filter(Boolean);
    let prefix = '';

    for (const segment of segments) {
      prefix = `${prefix}/${segment}`;
      const segmentFolder = allFiles.find((file) => file.path === prefix && isFolder(file));

      breadcrumbs.push({
        label: segment,
        href: segmentFolder ? `/accounts/${account.id}?folder=${segmentFolder.id}` : `/accounts/${account.id}`
      });
    }
  }

  return {
    account,
    currentFolder,
    folders,
    files,
    allFiles,
    breadcrumbs
  };
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Serve static assets natively for index.html mapping
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Temporarily disabling EJS views as we pivot to HTML files
// app.set('views', path.join(ROOT_DIR, 'views'));
// app.set('view engine', 'ejs');

// Redirect the old roots to the new static pages if hit specifically
app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/accounts', (req, res) => res.redirect('/accounts.html'));
app.get('/files', (req, res) => res.redirect('/fileview.html'));
app.get('/settings', (req, res) => res.redirect('/settings.html'));

app.get('/accounts/:id', (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const folderId = req.query.folder ? Number(req.query.folder) : null;
    const explorer = buildExplorerState(db, accountId, folderId);

    if (!explorer) return res.status(404).send('Account not found');

    renderPage(res, 'account', {
      ...explorer,
      breadcrumbs: explorer.breadcrumbs
    });
  } catch (error) {
    res.status(500).send('Failed to render account.');
  }
});

// Files pages
app.get('/files', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const files = listFiles(db, { accountId: 'all', query: q, limit: 200 });
    renderPage(res, 'files', {
      files,
      query: q,
      breadcrumbs: [{ label: 'Files', href: '/files' }]
    });
  } catch (error) {
    res.status(500).send('Failed to render files.');
  }
});

app.get('/files/:id', (req, res) => {
  try {
    const file = getFileById(db, Number(req.params.id));
    if (!file) return res.status(404).send('File not found');

    if (isFolder(file)) {
      return res.redirect(`/accounts/${file.account_id}?folder=${file.id}`);
    }

    renderPage(res, 'file', {
      file,
      breadcrumbs: [
        { label: 'Files', href: '/files' },
        { label: file.name, href: `/files/${file.id}` }
      ]
    });
  } catch (error) {
    res.status(500).send('Failed to render file.');
  }
});

app.get('/settings', (req, res) => {
  try {
    const config = {
      appUrl: APP_URL,
      databasePath: DATABASE_PATH,
      redirectUri: REDIRECT_URI
    };

    renderPage(res, 'settings', {
      config,
      breadcrumbs: [{ label: 'Settings', href: '/settings' }]
    });
  } catch (error) {
    res.status(500).send('Failed to render settings.');
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, appUrl: APP_URL, databasePath: DATABASE_PATH });
});

app.get('/api/accounts', (req, res) => {
  // Return an array for simpler client usage (also backward compatible with
  // older clients expecting { accounts: [...] }).
  res.json(listAccounts(db));
});

app.post('/api/accounts', (req, res) => {
  const label = String(req.body.label || '').trim();

  if (!label) {
    return res.status(400).json({ error: 'Account label is required.' });
  }

  const existingAccounts = listAccounts(db);
  if (existingAccounts.length >= 5) {
    return res.status(400).json({ error: 'This version supports up to 5 linked accounts.' });
  }

  const account = createAccount(db, label);
  const authUrl = buildAuthUrl(ROOT_DIR, REDIRECT_URI, account.id);

  res.json({ account, authUrl });
});

app.post('/accounts', (req, res) => {
  const label = String(req.body.label || '').trim();

  if (!label) {
    return res.status(400).send('Account label is required.');
  }

  const existingAccounts = listAccounts(db);
  if (existingAccounts.length >= 5) {
    return res.status(400).send('This version supports up to 5 linked accounts.');
  }

  const account = createAccount(db, label);
  const authUrl = buildAuthUrl(ROOT_DIR, REDIRECT_URI, account.id);

  res.redirect(authUrl);
});

app.post('/accounts/:id/link', (req, res) => {
  const account = getAccount(db, Number(req.params.id));

  if (!account) {
    return res.status(404).send('Account not found.');
  }

  const authUrl = buildAuthUrl(ROOT_DIR, REDIRECT_URI, account.id);
  res.redirect(authUrl);
});

app.get('/oauth2/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');

  if (!code || !state) {
    return res.status(400).send('Missing OAuth code or state.');
  }

  const accountId = Number(state);
  const account = getAccount(db, accountId);

  if (!account) {
    return res.status(404).send('Unknown account.');
  }

  try {
    const { oauth2Client, tokens } = await exchangeCode(ROOT_DIR, REDIRECT_URI, code);
    const profile = await fetchGoogleProfile(oauth2Client);

    updateAccountTokens(db, accountId, {
      email: profile.email || null,
      display_name: profile.name || null,
      picture_url: profile.picture || null,
      client_id: null,
      refresh_token: tokens.refresh_token || account.refresh_token || null,
      access_token: tokens.access_token || null,
      expiry_date: tokens.expiry_date || null,
      scope: tokens.scope || null,
      sync_state: 'linked'
    });

    res.redirect('/?linked=1');
  } catch (error) {
    res.status(500).send(`OAuth callback failed: ${error.message}`);
  }
});

app.post('/api/accounts/:id/sync', async (req, res) => {
  const accountId = Number(req.params.id);
  const account = getAccount(db, accountId);

  if (!account) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  if (!account.refresh_token) {
    return res.status(400).json({ error: 'Link this account first.' });
  }

  try {
    setAccountSyncState(db, accountId, 'syncing');
    const result = await syncDriveAccount(ROOT_DIR, REDIRECT_URI, account, () => {});
    replaceAccountFiles(db, accountId, result.files);
    rebuildPaths(db, accountId);
    updateAccountSyncSummary(db, accountId, result.summary);

    res.json({
      ok: true,
      files_synced: result.files.length,
      summary: result.summary
    });
  } catch (error) {
    setAccountSyncState(db, accountId, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync-all', async (req, res) => {
  const accounts = listAccounts(db).filter((account) => account.refresh_token);
  const results = [];

  for (const account of accounts) {
    try {
      setAccountSyncState(db, account.id, 'syncing');
      const result = await syncDriveAccount(ROOT_DIR, REDIRECT_URI, account, () => {});
      replaceAccountFiles(db, account.id, result.files);
      rebuildPaths(db, account.id);
      updateAccountSyncSummary(db, account.id, result.summary);
      results.push({ account_id: account.id, ok: true, files_synced: result.files.length });
    } catch (error) {
      setAccountSyncState(db, account.id, 'error');
      results.push({ account_id: account.id, ok: false, error: error.message });
    }
  }

  res.json({ ok: true, results });
});

app.get('/api/dashboard', (req, res) => {
  res.json(getDashboard(db));
});

app.get('/api/storage-summary', (req, res) => {
  try {
    const dash = getDashboard(db);

    // File type aggregation by mime_type prefix
    const rows = db.prepare(`
      SELECT mime_type, COUNT(*) AS cnt
      FROM files
      GROUP BY mime_type
    `).all();

    const fileTypes = {};
    for (const row of rows) {
      const mt = String(row.mime_type || '').toLowerCase();
      let bucket = 'Other';
      if (mt.startsWith('image/')) bucket = 'Images';
      else if (mt.startsWith('video/')) bucket = 'Video';
      else if (mt.startsWith('audio/')) bucket = 'Audio';
      else if (mt.startsWith('text/') || mt.includes('pdf') || mt.includes('word') || mt.includes('excel') || mt.includes('offic')) bucket = 'Documents';
      fileTypes[bucket] = (fileTypes[bucket] || 0) + (row.cnt || 0);
    }

    const largestFiles = (dash.largest_files || []).map((f) => ({ name: f.name, size: f.size, account: f.account_label }));

    res.json({
      totalFiles: dash.totals.file_count || 0,
      potentialDuplicates: (dash.duplicate_candidates || []).length || 0,
      fileTypes,
      largestFiles
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/browse', (req, res) => {
  const accountId = Number(req.query.accountId);
  const folderId = req.query.folderId || 'root';

  if (!accountId) {
    return res.status(400).json({ error: 'Missing accountId parameter.' });
  }

  try {
    let query;
    let params;

    if (folderId === 'root') {
      // Root means the first parent ID is null, or points to an ID not in our DB (which usually means the top-level Drive root)
      query = `
        SELECT drive_file_id, name, mime_type, size, created_time, web_view_link, parents_json
        FROM files
        WHERE account_id = ?
          AND (
            json_extract(parents_json, '$[0]') IS NULL 
            OR json_extract(parents_json, '$[0]') NOT IN (
              SELECT drive_file_id FROM files WHERE account_id = ?
            )
          )
      `;
      params = [accountId, accountId];
    } else {
      query = `
        SELECT drive_file_id, name, mime_type, size, created_time, web_view_link, parents_json
        FROM files
        WHERE account_id = ? AND json_extract(parents_json, '$[0]') = ?
      `;
      params = [accountId, folderId];
    }

    const rows = db.prepare(query).all(...params);

    const items = rows.map((row) => ({
      id: row.drive_file_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      parentId: folderId,
      created: row.created_time,
      driveUrl: row.web_view_link
    }));

    res.json({ items });
  } catch (err) {
    console.error('Error fetching browse items:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tree/subfolders', (req, res) => {
  const accountId = Number(req.query.accountId);
  const folderId = req.query.folderId || 'root';

  if (!accountId) {
    return res.status(400).json({ error: 'Missing accountId parameter.' });
  }

  try {
    let query;
    let params;
    const folderMime = 'application/vnd.google-apps.folder';

    if (folderId === 'root') {
      query = `
        SELECT drive_file_id, name 
        FROM files
        WHERE account_id = ?
          AND mime_type = ?
          AND (
            json_extract(parents_json, '$[0]') IS NULL 
            OR json_extract(parents_json, '$[0]') NOT IN (
              SELECT drive_file_id FROM files WHERE account_id = ?
            )
          )
        ORDER BY name ASC
      `;
      params = [accountId, folderMime, accountId];
    } else {
      query = `
        SELECT drive_file_id, name 
        FROM files
        WHERE account_id = ? 
          AND mime_type = ?
          AND json_extract(parents_json, '$[0]') = ?
        ORDER BY name ASC
      `;
      params = [accountId, folderMime, folderId];
    }

    const rows = db.prepare(query).all(...params);

    const folders = rows.map((row) => ({
      id: row.drive_file_id,
      name: row.name,
      accountId: accountId
    }));

    res.json({ folders });
  } catch (err) {
    console.error('Error fetching tree subfolders:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files', (req, res) => {
  const accountId = req.query.accountId || 'all';
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  res.json({ files: listFiles(db, { accountId, query: q, limit, offset }) });
});

app.get('/api/files/:id', (req, res) => {
  const file = getFileById(db, Number(req.params.id));

  if (!file) {
    return res.status(404).json({ error: 'File not found.' });
  }

  res.json({ file });
});

app.get('/api/files/:id/download', async (req, res) => {
  const file = getFileById(db, Number(req.params.id));

  if (!file) {
    return res.status(404).json({ error: 'File not found.' });
  }

  if (!file.account_id) {
    return res.status(400).json({ error: 'File is missing its account mapping.' });
  }

  const account = getAccount(db, file.account_id);

  if (!account?.refresh_token) {
    return res.status(400).json({ error: 'Linked account is missing a refresh token.' });
  }

  try {
    const response = await downloadDriveFile(ROOT_DIR, REDIRECT_URI, account, file);
    const fileName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    response.data.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/files/:id/delete', async (req, res) => {
  const file = getFileById(db, Number(req.params.id));

  if (!file) {
    return res.status(404).json({ error: 'File not found.' });
  }

  if (!req.body.confirm) {
    return res.status(400).json({ error: 'Set confirm=true to delete a file.' });
  }

  const account = getAccount(db, file.account_id);

  try {
    await deleteDriveFile(ROOT_DIR, REDIRECT_URI, account, file);
    deleteFileRecord(db, file.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/files/:id/transfer', async (req, res) => {
  const file = getFileById(db, Number(req.params.id));
  const targetAccountId = Number(req.body.targetAccountId);
  const mode = String(req.body.mode || 'copy');

  if (!file) {
    return res.status(404).json({ error: 'File not found.' });
  }

  const sourceAccount = getAccount(db, file.account_id);
  const targetAccount = getAccount(db, targetAccountId);

  if (!sourceAccount?.refresh_token || !targetAccount?.refresh_token) {
    return res.status(400).json({ error: 'Both accounts must be linked first.' });
  }

  if (!targetAccountId || targetAccountId === file.account_id) {
    return res.status(400).json({ error: 'Pick a different target account.' });
  }

  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-center-'));
    const tempPath = path.join(tempDir, crypto.randomUUID());
    const downloadResponse = await downloadDriveFile(ROOT_DIR, REDIRECT_URI, sourceAccount, file);

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(tempPath);
      downloadResponse.data.pipe(stream);
      downloadResponse.data.on('error', reject);
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    const buffer = fs.readFileSync(tempPath);
    const uploaded = await uploadDriveFile(ROOT_DIR, REDIRECT_URI, targetAccount, buffer, {
      name: file.name,
      mimeType: file.mime_type || 'application/octet-stream'
    });

    if (mode === 'move') {
      await deleteDriveFile(ROOT_DIR, REDIRECT_URI, sourceAccount, file);
      deleteFileRecord(db, file.id);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });

    res.json({ ok: true, uploaded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/accounts/:id/upload', upload.single('file'), async (req, res) => {
  const account = getAccount(db, Number(req.params.id));

  if (!account?.refresh_token) {
    return res.status(400).json({ error: 'Link the account before uploading.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Upload a file first.' });
  }

  try {
    const uploaded = await uploadDriveFile(ROOT_DIR, REDIRECT_URI, account, req.file.buffer, {
      name: req.file.originalname,
      mimeType: req.file.mimetype
    });

    res.json({ ok: true, uploaded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const credentials = loadCredentials(ROOT_DIR);
    res.json({
      ok: true,
      redirectUri: REDIRECT_URI,
      clientId: credentials.config.client_id
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Drive Control Center running at ${APP_URL}`);
});

// Unlink / remove an account and its files
app.post('/api/accounts/:id/unlink', (req, res) => {
  const accountId = Number(req.params.id);
  const account = getAccount(db, accountId);
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  try {
    // Delete account will cascade to files (ON DELETE CASCADE)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});