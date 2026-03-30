import { FastifyInstance } from 'fastify';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (_req, reply) => {
    reply.type('text/html').send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>GenLea — Companies Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .badge-hot       { background:#fef2f2; color:#dc2626; border:1px solid #fca5a5; }
    .badge-hot_verified { background:#fff7ed; color:#ea580c; border:1px solid #fdba74; }
    .badge-warm      { background:#fefce8; color:#ca8a04; border:1px solid #fde047; }
    .badge-cold      { background:#f0f9ff; color:#0369a1; border:1px solid #bae6fd; }
    .badge-disqualified { background:#f9fafb; color:#6b7280; border:1px solid #e5e7eb; }
    tr:hover td { background:#f8fafc; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans">

<!-- Header -->
<div class="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
  <div class="flex items-center gap-3">
    <span class="text-2xl font-bold text-gray-900">GenLea</span>
    <span class="text-gray-400 text-sm">Lead Dashboard</span>
  </div>
  <div class="flex gap-3">
    <a href="/queues" target="_blank" class="text-sm text-blue-600 hover:underline">Queue Monitor</a>
    <a href="/api/stats" target="_blank" class="text-sm text-gray-500 hover:underline">API Stats</a>
  </div>
</div>

<!-- Stats bar -->
<div class="bg-white border-b border-gray-200 px-6 py-3 flex gap-6" id="stats-bar">
  <div class="text-sm text-gray-400">Loading stats…</div>
</div>

<!-- Filters -->
<div class="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap gap-3 items-end">

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Status</label>
    <select id="f-status" class="border border-gray-200 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">All</option>
      <option value="hot_verified">🔥 Hot Verified</option>
      <option value="hot">🔥 Hot</option>
      <option value="warm">🌡 Warm</option>
      <option value="cold">❄️ Cold</option>
      <option value="disqualified">✗ Disqualified</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Min Score</label>
    <input id="f-score" type="number" min="0" max="100" placeholder="0"
      class="border border-gray-200 rounded px-3 py-1.5 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-400"/>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Tech Stack</label>
    <select id="f-tech" class="border border-gray-200 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">Any</option>
      <option>nodejs</option><option>typescript</option><option>python</option>
      <option>react</option><option>nextjs</option><option>nestjs</option>
      <option>fastapi</option><option>ai</option><option>ml</option><option>generative-ai</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Funding Stage</label>
    <select id="f-funding" class="border border-gray-200 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">Any</option>
      <option value="Pre-seed">Pre-seed</option>
      <option value="Seed">Seed</option>
      <option value="Series A">Series A</option>
      <option value="Series B">Series B</option>
      <option value="Series C">Series C</option>
      <option value="Series D+">Series D+</option>
      <option value="Bootstrapped">Bootstrapped</option>
      <option value="Public">Public</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Per page</label>
    <select id="f-limit" class="border border-gray-200 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="25">25</option>
      <option value="50" selected>50</option>
      <option value="100">100</option>
    </select>
  </div>

  <button onclick="applyFilters()"
    class="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded transition">
    Apply
  </button>
  <button onclick="resetFilters()"
    class="text-gray-500 hover:text-gray-700 text-sm px-3 py-1.5 rounded border border-gray-200 hover:border-gray-300 transition">
    Reset
  </button>

  <button onclick="exportCSV()"
    class="ml-auto bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-1.5 rounded transition flex items-center gap-1.5">
    ↓ Export CSV
  </button>
</div>

<!-- Table -->
<div class="px-6 py-4">
  <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
    <table class="w-full text-sm">
      <thead class="bg-gray-50 border-b border-gray-200">
        <tr>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Company</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Score</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Indian Ratio</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Funding</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Employees</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tech Stack</th>
          <th class="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
        </tr>
      </thead>
      <tbody id="companies-tbody">
        <tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  <div class="flex items-center justify-between mt-4 text-sm text-gray-500" id="pagination">
    <span id="page-info"></span>
    <div class="flex gap-2">
      <button id="btn-prev" onclick="changePage(-1)"
        class="px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
        ← Prev
      </button>
      <button id="btn-next" onclick="changePage(1)"
        class="px-3 py-1.5 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
        Next →
      </button>
    </div>
  </div>
</div>

<!-- Company detail modal -->
<div id="modal" class="hidden fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onclick="closeModal(event)">
  <div class="bg-white rounded-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto shadow-2xl" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
      <h2 id="modal-title" class="font-semibold text-gray-900 text-lg"></h2>
      <button onclick="document.getElementById('modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl">✕</button>
    </div>
    <div id="modal-body" class="px-6 py-4"></div>
  </div>
</div>

<script>
let currentPage = 1;
let totalPages  = 1;

async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const { data } = await r.json();
    document.getElementById('stats-bar').innerHTML =
      stat('Total', data.total, 'text-gray-700') +
      stat('🔥 Hot', data.hot, 'text-orange-600') +
      stat('🌡 Warm', data.warm, 'text-yellow-600') +
      stat('❄️ Cold', data.cold, 'text-blue-500') +
      stat('✗ Disqualified', data.disqualified, 'text-gray-400');
  } catch { /* ignore */ }
}

function stat(label, value, cls) {
  return '<div class="flex items-center gap-1.5">' +
    '<span class="text-xs text-gray-400">' + label + '</span>' +
    '<span class="font-semibold text-sm ' + cls + '">' + (value ?? 0) + '</span>' +
    '</div>';
}

async function loadCompanies() {
  const status  = document.getElementById('f-status').value;
  const score   = document.getElementById('f-score').value;
  const tech    = document.getElementById('f-tech').value;
  const funding = document.getElementById('f-funding').value;
  const limit   = document.getElementById('f-limit').value;

  const params = new URLSearchParams({ page: currentPage, limit });
  if (status)  params.set('status', status);
  if (score)   params.set('minScore', score);
  if (tech)    params.set('techStack', tech);
  if (funding) params.set('fundingStage', funding);

  const tbody = document.getElementById('companies-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">Loading…</td></tr>';

  try {
    const r    = await fetch('/api/leads?' + params);
    const json = await r.json();
    const { data, meta } = json;

    totalPages = meta.pages || 1;
    document.getElementById('page-info').textContent =
      'Page ' + meta.page + ' of ' + totalPages + ' — ' + meta.total + ' companies';
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-10 text-center text-gray-400">No companies found. Run <code class="bg-gray-100 px-1 rounded">npm run seed</code> to start scraping.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(c => {
      const ratio   = c.originRatio != null ? Math.round(c.originRatio * 100) + '%' : '—';
      const score   = c.score != null ? c.score : '—';
      const tags    = (c.techStack || []).slice(0, 4).map(t =>
        '<span class="bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded">' + escHtml(t) + '</span>'
      ).join(' ');

      return '<tr class="border-b border-gray-100 cursor-pointer" onclick="openCompany(\'' + c._id + '\')">' +
        '<td class="px-4 py-3"><div class="font-medium text-gray-900">' + escHtml(c.name || '—') + '</div>' +
          '<div class="text-xs text-blue-500">' + escHtml(c.domain || '') + '</div></td>' +
        '<td class="px-4 py-3"><span class="font-bold ' + scoreColor(score) + '">' + score + '</span></td>' +
        '<td class="px-4 py-3"><span class="badge-' + (c.status||'cold') + ' text-xs px-2 py-0.5 rounded-full font-medium">' + escHtml(c.status || '—') + '</span></td>' +
        '<td class="px-4 py-3 font-medium ' + ratioColor(c.originRatio) + '">' + ratio + '</td>' +
        '<td class="px-4 py-3 text-gray-600 text-xs">' + escHtml(c.fundingStage || '—') + '</td>' +
        '<td class="px-4 py-3 text-gray-600">' + (c.employeeCount || '—') + '</td>' +
        '<td class="px-4 py-3"><div class="flex flex-wrap gap-1">' + tags + '</div></td>' +
        '<td class="px-4 py-3"><button onclick="event.stopPropagation();openCompany(\'' + c._id + '\')" class="text-blue-500 hover:text-blue-700 text-xs">View →</button></td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-red-400">Error loading companies: ' + e.message + '</td></tr>';
  }
}

async function openCompany(id) {
  document.getElementById('modal-title').textContent = 'Loading…';
  document.getElementById('modal-body').innerHTML = '<div class="text-gray-400 py-4 text-center">Loading…</div>';
  document.getElementById('modal').classList.remove('hidden');

  try {
    const r    = await fetch('/api/companies/' + id);
    const json = await r.json();
    const { company: c, contacts } = json.data;

    document.getElementById('modal-title').textContent = c.name || c.domain;

    const contactsHtml = contacts && contacts.length
      ? contacts.map(ct =>
          '<div class="border border-gray-100 rounded-lg p-3">' +
            '<div class="flex justify-between items-start">' +
              '<div><span class="font-medium">' + escHtml(ct.fullName || '—') + '</span>' +
              ' <span class="text-xs text-gray-400">' + escHtml(ct.role || '') + '</span></div>' +
              '<span class="text-xs ' + (ct.emailVerified ? 'text-green-600' : 'text-gray-400') + '">' +
                (ct.emailVerified ? '✓ verified' : 'unverified') + '</span>' +
            '</div>' +
            (ct.email ? '<div class="text-xs text-blue-500 mt-1">' + escHtml(ct.email) + '</div>' : '') +
            (ct.phone ? '<div class="text-xs text-gray-500 mt-0.5">' + escHtml(ct.phone) + '</div>' : '') +
          '</div>'
        ).join('')
      : '<div class="text-gray-400 text-sm">No contacts yet</div>';

    document.getElementById('modal-body').innerHTML =
      '<div class="grid grid-cols-2 gap-3 mb-4">' +
        field('Domain', '<a href="https://' + escHtml(c.domain) + '" target="_blank" class="text-blue-500 hover:underline">' + escHtml(c.domain) + '</a>') +
        field('Score', '<span class="font-bold ' + scoreColor(c.score) + '">' + (c.score ?? '—') + ' / 100</span>') +
        field('Status', '<span class="badge-' + (c.status||'cold') + ' text-xs px-2 py-0.5 rounded-full">' + (c.status || '—') + '</span>') +
        field('Indian Ratio', '<span class="' + ratioColor(c.originRatio) + ' font-medium">' + (c.originRatio != null ? Math.round(c.originRatio*100)+'%' : '—') + '</span>') +
        field('Funding', c.fundingStage || '—') +
        field('Employees', c.employeeCount || '—') +
      '</div>' +
      (c.techStack && c.techStack.length ? '<div class="mb-4"><div class="text-xs text-gray-500 mb-1.5 font-medium">Tech Stack</div><div class="flex flex-wrap gap-1">' + c.techStack.map(t => '<span class="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded">' + escHtml(t) + '</span>').join('') + '</div></div>' : '') +
      '<div class="mt-2"><div class="text-xs text-gray-500 mb-2 font-medium">Contacts (' + (contacts ? contacts.length : 0) + ')</div>' +
      '<div class="flex flex-col gap-2">' + contactsHtml + '</div></div>';
  } catch (e) {
    document.getElementById('modal-body').innerHTML = '<div class="text-red-400">Error: ' + e.message + '</div>';
  }
}

function field(label, value) {
  return '<div class="bg-gray-50 rounded-lg p-3"><div class="text-xs text-gray-400 mb-0.5">' + label + '</div><div class="text-sm text-gray-800">' + value + '</div></div>';
}

function closeModal(e) {
  if (e.target === document.getElementById('modal')) document.getElementById('modal').classList.add('hidden');
}

function exportCSV() {
  const status  = document.getElementById('f-status').value || 'hot';
  const score   = document.getElementById('f-score').value;
  const params  = new URLSearchParams({ status });
  if (score) params.set('minScore', score);
  window.location.href = '/api/export/csv?' + params;
}

function applyFilters() { currentPage = 1; loadCompanies(); }
function resetFilters() {
  ['f-status','f-tech','f-funding'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-score').value = '';
  document.getElementById('f-limit').value = '50';
  currentPage = 1;
  loadCompanies();
}
function changePage(dir) {
  const next = currentPage + dir;
  if (next < 1 || next > totalPages) return;
  currentPage = next;
  loadCompanies();
}

function scoreColor(s) {
  if (s >= 80) return 'text-orange-600';
  if (s >= 65) return 'text-yellow-600';
  if (s >= 50) return 'text-blue-500';
  return 'text-gray-400';
}
function ratioColor(r) {
  if (r == null) return 'text-gray-400';
  if (r >= 0.75) return 'text-green-600';
  if (r >= 0.60) return 'text-yellow-600';
  return 'text-gray-400';
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Init
loadStats();
loadCompanies();
// Auto-refresh every 30s
setInterval(() => { loadStats(); loadCompanies(); }, 30000);
</script>
</body>
</html>`;
