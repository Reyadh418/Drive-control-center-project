const state = {
  accounts: [],
  dashboard: null,
  files: [],
  selectedAccountId: 'all',
  query: ''
};

const els = {
  statsGrid: document.getElementById('statsGrid'),
  accountCount: document.getElementById('accountCount'),
  accountsList: document.getElementById('accountsList'),
  filesTable: document.getElementById('filesTable'),
  largestFiles: document.getElementById('largestFiles'),
  duplicateFiles: document.getElementById('duplicateFiles'),
  searchInput: document.getElementById('searchInput'),
  accountFilter: document.getElementById('accountFilter'),
  linkAccountBtn: document.getElementById('linkAccountBtn'),
  syncAllBtn: document.getElementById('syncAllBtn'),
  refreshBtn: document.getElementById('refreshBtn')
};

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value === 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) {
    return 'Unknown';
  }

  return new Date(value).toLocaleString();
}

function renderStats() {
  const dashboard = state.dashboard || { totals: { file_count: 0, storage_used: 0, connected_accounts: 0, checksum_count: 0 } };
  const totalStorage = dashboard.accounts.reduce((sum, account) => sum + Number(account.storage_total || 0), 0);
  const usedStorage = dashboard.accounts.reduce((sum, account) => sum + Number(account.storage_used || 0), 0);

  const cards = [
    { label: 'Connected accounts', value: dashboard.totals.connected_accounts || 0, sub: 'Local auth links stored on this machine' },
    { label: 'Indexed files', value: dashboard.totals.file_count || 0, sub: 'Visible across the unified catalog' },
    { label: 'Tracked storage', value: formatBytes(usedStorage), sub: `${formatBytes(totalStorage)} total quota` },
    { label: 'Checksum set', value: dashboard.totals.checksum_count || 0, sub: 'Useful for duplicate detection' }
  ];

  els.statsGrid.innerHTML = cards.map((card) => `
    <article class="card stat-card">
      <div class="stat-label">${card.label}</div>
      <div class="stat-value">${card.value}</div>
      <div class="stat-sub">${card.sub}</div>
    </article>
  `).join('');
}

function renderAccounts() {
  els.accountCount.textContent = `${state.accounts.length}/5 linked`;
  els.accountFilter.innerHTML = ['<option value="all">All accounts</option>']
    .concat(state.accounts.map((account) => `<option value="${account.id}">${account.label}</option>`))
    .join('');
  els.accountFilter.value = state.selectedAccountId;

  els.accountsList.innerHTML = state.accounts.map((account) => {
    const synced = account.last_synced_at ? `Synced ${formatDate(account.last_synced_at)}` : 'Not synced yet';
    const detail = account.email ? `${account.label} · ${account.email}` : account.label;
    const statusClass = String(account.sync_state || 'idle');

    return `
      <article class="account-item">
        <div>
          <strong class="account-label">${account.label}</strong>
          <p class="account-meta">${detail}</p>
          <p class="account-meta">${synced}</p>
          <span class="status-chip ${statusClass}">${statusClass}</span>
        </div>
        <div class="account-actions">
          <button class="ghost sync-account-btn" data-account-id="${account.id}">Sync</button>
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('.sync-account-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      await syncAccount(Number(button.dataset.accountId));
    });
  });
}

function renderFiles() {
  if (!state.files.length) {
    els.filesTable.innerHTML = `
      <tr>
        <td colspan="6" class="muted">No files yet. Link an account and run sync.</td>
      </tr>
    `;
    return;
  }

  els.filesTable.innerHTML = state.files.map((file) => `
    <tr>
      <td>
        <div class="file-name">${file.name}</div>
        <span class="file-subtle">${file.mime_type || 'Unknown type'}</span>
      </td>
      <td>${file.account_label}</td>
      <td>${file.path || '/' + file.name}</td>
      <td>${formatBytes(file.size)}</td>
      <td>${formatDate(file.modified_time)}</td>
      <td>
        <div class="actions-row">
          <button class="ghost" data-action="download" data-id="${file.id}">Download</button>
          <button class="ghost" data-action="copy" data-id="${file.id}">Copy</button>
          <button class="ghost" data-action="delete" data-id="${file.id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const fileId = button.dataset.id;
      const action = button.dataset.action;

      if (action === 'download') {
        window.open(`/api/files/${fileId}/download`, '_blank', 'noopener');
        return;
      }

      if (action === 'copy') {
        const target = window.prompt('Target account ID to copy into:');
        if (!target) {
          return;
        }

        await fetch(`/api/files/${fileId}/transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetAccountId: Number(target), mode: 'copy' })
        });
        await refreshAll();
        return;
      }

      if (action === 'delete') {
        if (!window.confirm('Delete this file from Drive?')) {
          return;
        }

        await fetch(`/api/files/${fileId}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        });
        await refreshAll();
      }
    });
  });
}

function renderLowerPanels() {
  const dashboard = state.dashboard || { largest_files: [], duplicate_candidates: [] };

  els.largestFiles.innerHTML = dashboard.largest_files.length
    ? dashboard.largest_files.map((file) => `
      <article class="largest-item">
        <div class="mini-title">${file.name}</div>
        <p class="muted">${file.account_label} · ${file.path || '/'}</p>
        <p class="muted">${formatBytes(file.size)}</p>
      </article>
    `).join('')
    : '<p class="muted">Sync an account to see the largest files.</p>';

  els.duplicateFiles.innerHTML = dashboard.duplicate_candidates.length
    ? dashboard.duplicate_candidates.map((entry) => `
      <article class="duplicate-item">
        <div class="mini-title">${entry.copies} matching files</div>
        <p class="muted">Checksum: ${entry.md5_checksum}</p>
        <p class="muted">Potential duplicate size: ${formatBytes(entry.total_size)}</p>
      </article>
    `).join('')
    : '<p class="muted">No duplicate candidates yet. Sync more files first.</p>';
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

async function refreshAll() {
  const [accountsResult, dashboardResult] = await Promise.all([
    fetchJson('/api/accounts'),
    fetchJson('/api/dashboard')
  ]);

  state.accounts = accountsResult.accounts || [];
  state.dashboard = dashboardResult;

  renderStats();
  renderAccounts();
  renderLowerPanels();
  await loadFiles();
}

async function loadFiles() {
  const query = new URLSearchParams();
  if (state.selectedAccountId !== 'all') {
    query.set('accountId', state.selectedAccountId);
  }
  if (state.query) {
    query.set('q', state.query);
  }
  query.set('limit', '250');

  const result = await fetchJson(`/api/files?${query.toString()}`);
  state.files = result.files || [];
  renderFiles();
}

async function syncAccount(accountId) {
  await fetchJson(`/api/accounts/${accountId}/sync`, { method: 'POST' });
  await refreshAll();
}

async function syncAllAccounts() {
  await fetchJson('/api/sync-all', { method: 'POST' });
  await refreshAll();
}

async function linkAccount() {
  const label = window.prompt('Label for this account (for example: Personal, Work, Archive):');
  if (!label) {
    return;
  }

  const result = await fetchJson('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  });

  window.open(result.authUrl, '_blank', 'noopener');
  await refreshAll();
}

els.linkAccountBtn.addEventListener('click', () => linkAccount().catch((error) => alert(error.message)));
els.syncAllBtn.addEventListener('click', () => syncAllAccounts().catch((error) => alert(error.message)));
els.refreshBtn.addEventListener('click', () => refreshAll().catch((error) => alert(error.message)));
els.searchInput.addEventListener('input', async (event) => {
  state.query = event.target.value.trim();
  await loadFiles();
});
els.accountFilter.addEventListener('change', async (event) => {
  state.selectedAccountId = event.target.value;
  await loadFiles();
});

const linkedNotice = new URLSearchParams(window.location.search).get('linked');
if (linkedNotice) {
  window.history.replaceState({}, document.title, '/');
}

refreshAll().catch((error) => {
  console.error(error);
  alert(error.message);
});