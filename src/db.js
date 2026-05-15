const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function runInTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function initDatabase(dbPath) {
  ensureDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      picture_url TEXT,
      client_id TEXT,
      refresh_token TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      storage_total INTEGER DEFAULT 0,
      storage_used INTEGER DEFAULT 0,
      storage_trash INTEGER DEFAULT 0,
      storage_used_in_drive INTEGER DEFAULT 0,
      last_synced_at TEXT,
      sync_state TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER DEFAULT 0,
      md5_checksum TEXT,
      parents_json TEXT,
      path TEXT,
      trashed INTEGER DEFAULT 0,
      modified_time TEXT,
      created_time TEXT,
      owners_json TEXT,
      web_view_link TEXT,
      icon_link TEXT,
      starred INTEGER DEFAULT 0,
      shared INTEGER DEFAULT 0,
      drive_id TEXT,
      UNIQUE(account_id, drive_file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_files_account_id ON files(account_id);
    CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5_checksum);
  `);

  return db;
}

function listAccounts(db) {
  return db.prepare(`
    SELECT
      id, label, email, display_name, picture_url, storage_total, storage_used,
      storage_trash, storage_used_in_drive, last_synced_at, sync_state, created_at,
      updated_at,
      CASE
        WHEN storage_total > 0 THEN CAST(storage_used AS REAL) / storage_total
        ELSE 0
      END AS storage_ratio
    FROM accounts
    ORDER BY id ASC
  `).all();
}

function createAccount(db, label) {
  const stmt = db.prepare(`INSERT INTO accounts (label, sync_state) VALUES (?, 'needs-auth')`);
  const result = stmt.run(label);
  return getAccount(db, result.lastInsertRowid);
}

function getAccount(db, id) {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

function updateAccountTokens(db, accountId, tokenData) {
  const stmt = db.prepare(`
    UPDATE accounts
    SET
      email = COALESCE(@email, email),
      display_name = COALESCE(@display_name, display_name),
      picture_url = COALESCE(@picture_url, picture_url),
      client_id = COALESCE(@client_id, client_id),
      refresh_token = COALESCE(@refresh_token, refresh_token),
      access_token = COALESCE(@access_token, access_token),
      expiry_date = COALESCE(@expiry_date, expiry_date),
      scope = COALESCE(@scope, scope),
      sync_state = COALESCE(@sync_state, sync_state),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @account_id
  `);

  stmt.run({
    account_id: accountId,
    email: tokenData.email ?? null,
    display_name: tokenData.display_name ?? null,
    picture_url: tokenData.picture_url ?? null,
    client_id: tokenData.client_id ?? null,
    refresh_token: tokenData.refresh_token ?? null,
    access_token: tokenData.access_token ?? null,
    expiry_date: tokenData.expiry_date ?? null,
    scope: tokenData.scope ?? null,
    sync_state: tokenData.sync_state ?? null
  });
}

function updateAccountSyncSummary(db, accountId, summary) {
  const stmt = db.prepare(`
    UPDATE accounts
    SET
      storage_total = @storage_total,
      storage_used = @storage_used,
      storage_trash = @storage_trash,
      storage_used_in_drive = @storage_used_in_drive,
      last_synced_at = CURRENT_TIMESTAMP,
      sync_state = 'synced',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @account_id
  `);

  stmt.run({
    account_id: accountId,
    storage_total: summary.storage_total ?? 0,
    storage_used: summary.storage_used ?? 0,
    storage_trash: summary.storage_trash ?? 0,
    storage_used_in_drive: summary.storage_used_in_drive ?? 0
  });
}

function setAccountSyncState(db, accountId, syncState) {
  db.prepare(`UPDATE accounts SET sync_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(syncState, accountId);
}

function upsertFiles(db, accountId, files) {
  const insert = db.prepare(`
    INSERT INTO files (
      account_id, drive_file_id, name, mime_type, size, md5_checksum, parents_json,
      path, trashed, modified_time, created_time, owners_json, web_view_link,
      icon_link, starred, shared, drive_id
    ) VALUES (
      @account_id, @drive_file_id, @name, @mime_type, @size, @md5_checksum, @parents_json,
      @path, @trashed, @modified_time, @created_time, @owners_json, @web_view_link,
      @icon_link, @starred, @shared, @drive_id
    )
    ON CONFLICT(account_id, drive_file_id) DO UPDATE SET
      name = excluded.name,
      mime_type = excluded.mime_type,
      size = excluded.size,
      md5_checksum = excluded.md5_checksum,
      parents_json = excluded.parents_json,
      path = excluded.path,
      trashed = excluded.trashed,
      modified_time = excluded.modified_time,
      created_time = excluded.created_time,
      owners_json = excluded.owners_json,
      web_view_link = excluded.web_view_link,
      icon_link = excluded.icon_link,
      starred = excluded.starred,
      shared = excluded.shared,
      drive_id = excluded.drive_id
  `);

  for (const file of files) {
    insert.run({
      account_id: accountId,
      drive_file_id: file.drive_file_id,
      name: file.name,
      mime_type: file.mime_type,
      size: file.size,
      md5_checksum: file.md5_checksum,
      parents_json: JSON.stringify(file.parents ?? []),
      path: file.path ?? null,
      trashed: file.trashed ? 1 : 0,
      modified_time: file.modified_time ?? null,
      created_time: file.created_time ?? null,
      owners_json: JSON.stringify(file.owners ?? []),
      web_view_link: file.web_view_link ?? null,
      icon_link: file.icon_link ?? null,
      starred: file.starred ? 1 : 0,
      shared: file.shared ? 1 : 0,
      drive_id: file.drive_id ?? null
    });
  }
}

function replaceAccountFiles(db, accountId, files) {
  runInTransaction(db, () => {
    db.prepare(`DELETE FROM files WHERE account_id = ?`).run(accountId);
    upsertFiles(db, accountId, files);
  });
}

function rebuildPaths(db, accountId) {
  const rows = db.prepare(`
    SELECT drive_file_id, name, parents_json
    FROM files
    WHERE account_id = ?
  `).all(accountId);

  const byId = new Map(rows.map((row) => [row.drive_file_id, row]));
  const cache = new Map();
  const updates = [];

  function resolvePath(file) {
    if (cache.has(file.drive_file_id)) {
      return cache.get(file.drive_file_id);
    }

    const parentIds = JSON.parse(file.parents_json || '[]');
    const parentId = parentIds[0];
    let resolved = `/${file.name}`;

    if (parentId && byId.has(parentId)) {
      const parentPath = resolvePath(byId.get(parentId));
      resolved = parentPath === '/' ? `/${file.name}` : `${parentPath}/${file.name}`;
    }

    cache.set(file.drive_file_id, resolved);
    return resolved;
  }

  for (const row of rows) {
    updates.push({ path: resolvePath(row), drive_file_id: row.drive_file_id });
  }

  const stmt = db.prepare(`UPDATE files SET path = ? WHERE account_id = ? AND drive_file_id = ?`);
  runInTransaction(db, () => {
    for (const item of updates) {
      stmt.run(item.path, accountId, item.drive_file_id);
    }
  });
}

function listFiles(db, { accountId, query, limit = 200, offset = 0 }) {
  const where = [];
  const params = { limit, offset };

  if (accountId && accountId !== 'all') {
    where.push('account_id = @accountId');
    params.accountId = Number(accountId);
  }

  if (query) {
    where.push('(name LIKE @query OR path LIKE @query OR mime_type LIKE @query)');
    params.query = `%${query}%`;
  }

  const sql = `
    SELECT files.*, accounts.label AS account_label, accounts.email AS account_email
    FROM files
    JOIN accounts ON accounts.id = files.account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY datetime(files.modified_time) DESC, files.id DESC
    LIMIT @limit OFFSET @offset
  `;

  return db.prepare(sql).all(params);
}

function getFileById(db, fileId) {
  return db.prepare(`
    SELECT files.*, accounts.label AS account_label, accounts.email AS account_email
    FROM files
    JOIN accounts ON accounts.id = files.account_id
    WHERE files.id = ?
  `).get(fileId);
}

function getDashboard(db) {
  const accountSummary = db.prepare(`
    SELECT
      id,
      label,
      email,
      storage_total,
      storage_used,
      storage_trash,
      storage_used_in_drive,
      last_synced_at,
      sync_state,
      (SELECT COUNT(*) FROM files WHERE account_id = accounts.id) AS file_count
    FROM accounts
    ORDER BY id ASC
  `).all();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS file_count,
      COALESCE(SUM(size), 0) AS storage_used,
      COALESCE(COUNT(DISTINCT account_id), 0) AS connected_accounts,
      COALESCE(COUNT(*) FILTER (WHERE md5_checksum IS NOT NULL), 0) AS checksum_count
    FROM files
  `).get();

  const duplicateCandidates = db.prepare(`
    SELECT md5_checksum, COUNT(*) AS copies, SUM(size) AS total_size
    FROM files
    WHERE md5_checksum IS NOT NULL AND md5_checksum != ''
    GROUP BY md5_checksum
    HAVING COUNT(*) > 1
    ORDER BY copies DESC, total_size DESC
    LIMIT 10
  `).all();

  const largestFiles = db.prepare(`
    SELECT files.id, files.name, files.size, files.path, files.account_id, accounts.label AS account_label
    FROM files
    JOIN accounts ON accounts.id = files.account_id
    ORDER BY files.size DESC
    LIMIT 10
  `).all();

  return {
    totals: {
      file_count: totals.file_count ?? 0,
      storage_used: totals.storage_used ?? 0,
      connected_accounts: totals.connected_accounts ?? 0,
      checksum_count: totals.checksum_count ?? 0
    },
    accounts: accountSummary,
    duplicate_candidates: duplicateCandidates,
    largest_files: largestFiles
  };
}

function deleteFileRecord(db, fileId) {
  const row = getFileById(db, fileId);
  if (!row) {
    return null;
  }

  db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
  return row;
}

module.exports = {
  initDatabase,
  listAccounts,
  createAccount,
  getAccount,
  updateAccountTokens,
  updateAccountSyncSummary,
  setAccountSyncState,
  upsertFiles,
  replaceAccountFiles,
  rebuildPaths,
  listFiles,
  getFileById,
  getDashboard,
  deleteFileRecord
};