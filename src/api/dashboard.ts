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
  <title>GenLea — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .badge { display:inline-block; padding:2px 8px; border-radius:9999px; font-size:11px; font-weight:600; }
    .badge-hot_verified { background:#fff7ed; color:#c2410c; border:1px solid #fed7aa; }
    .badge-hot         { background:#fef2f2; color:#dc2626; border:1px solid #fca5a5; }
    .badge-warm        { background:#fefce8; color:#ca8a04; border:1px solid #fde047; }
    .badge-cold        { background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; }
    .badge-disqualified{ background:#f9fafb; color:#6b7280; border:1px solid #e5e7eb; }
    .badge-pending     { background:#f5f3ff; color:#7c3aed; border:1px solid #ddd6fe; }
    tr.data-row:hover td { background:#f8fafc; }
    .stat-card { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; padding:8px 20px; border-right:1px solid #f1f5f9; }
    .stat-card:last-child { border-right:none; }
    #error-banner { display:none; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans text-sm">

<!-- Header -->
<div class="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
  <div class="flex items-center gap-3">
    <span class="font-bold text-gray-900 text-xl">GenLea</span>
    <span class="text-gray-400">Lead Dashboard</span>
  </div>
  <div class="flex items-center gap-4">
    <span id="last-refresh" class="text-xs text-gray-400"></span>
    <button onclick="hardRefresh()" class="text-xs text-blue-600 hover:underline">↻ Refresh</button>
    <a href="/queues" target="_blank" class="text-xs text-gray-500 hover:underline">Queue Monitor</a>
    <a href="/health" target="_blank" class="text-xs text-gray-500 hover:underline">Health</a>
  </div>
</div>

<!-- Error banner (shown when API is unreachable) -->
<div id="error-banner" class="bg-red-50 border-b border-red-200 px-6 py-2 flex items-center justify-between">
  <span id="error-msg" class="text-red-700 text-xs"></span>
  <button onclick="hardRefresh()" class="text-xs text-red-600 hover:underline font-medium">Retry</button>
</div>

<!-- Stats bar -->
<div class="bg-white border-b border-gray-200 px-4 flex overflow-x-auto" id="stats-bar">
  <div class="stat-card"><span class="text-xs text-gray-400">Total</span><span class="font-bold text-gray-700 text-lg" id="s-total">—</span></div>
  <div class="stat-card"><span class="text-xs text-purple-500">Pending</span><span class="font-bold text-purple-600 text-lg" id="s-pending">—</span></div>
  <div class="stat-card"><span class="text-xs text-orange-500">🔥 Hot</span><span class="font-bold text-orange-600 text-lg" id="s-hot">—</span></div>
  <div class="stat-card"><span class="text-xs text-yellow-600">🌡 Warm</span><span class="font-bold text-yellow-600 text-lg" id="s-warm">—</span></div>
  <div class="stat-card"><span class="text-xs text-blue-500">❄ Cold</span><span class="font-bold text-blue-600 text-lg" id="s-cold">—</span></div>
  <div class="stat-card"><span class="text-xs text-gray-400">✗ Disqual.</span><span class="font-bold text-gray-500 text-lg" id="s-disq">—</span></div>
</div>

<!-- Filters -->
<div class="bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap gap-3 items-end">
  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Status</label>
    <select id="f-status" class="border border-gray-200 rounded px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">All</option>
      <option value="pending">⏳ Pending</option>
      <option value="hot_verified">🔥 Hot Verified</option>
      <option value="hot">🔥 Hot</option>
      <option value="warm">🌡 Warm</option>
      <option value="cold">❄ Cold</option>
      <option value="disqualified">✗ Disqualified</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Min Score</label>
    <input id="f-score" type="number" min="0" max="100" placeholder="0"
      class="border border-gray-200 rounded px-2 py-1.5 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-400"/>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Tech Stack</label>
    <select id="f-tech" class="border border-gray-200 rounded px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">Any</option>
      <option>nodejs</option><option>typescript</option><option>python</option>
      <option>react</option><option>nextjs</option><option>nestjs</option>
      <option>fastapi</option><option>ai</option><option>ml</option>
      <option>generative-ai</option><option>golang</option><option>rust</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Funding</label>
    <select id="f-funding" class="border border-gray-200 rounded px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">Any</option>
      <option>Pre-seed</option><option>Seed</option><option>Series A</option>
      <option>Series B</option><option>Series C</option><option>Bootstrapped</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Source</label>
    <select id="f-source" class="border border-gray-200 rounded px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="">Any</option>
      <option>wellfound</option><option>linkedin</option><option>crunchbase</option>
      <option>apollo</option><option>indeed</option><option>glassdoor</option>
      <option>surelyremote</option><option>github</option>
    </select>
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-xs text-gray-500 font-medium">Per page</label>
    <select id="f-limit" class="border border-gray-200 rounded px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
      <option value="25">25</option>
      <option value="50" selected>50</option>
      <option value="100">100</option>
      <option value="250">250</option>
    </select>
  </div>

  <button onclick="applyFilters()"
    class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded transition">
    Apply
  </button>
  <button onclick="resetFilters()"
    class="text-gray-500 hover:text-gray-700 text-xs px-3 py-1.5 rounded border border-gray-200 transition">
    Reset
  </button>
  <button onclick="exportCSV()"
    class="ml-auto bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1.5 rounded transition">
    ↓ Export CSV
  </button>
</div>

<!-- Table -->
<div class="px-6 py-4">
  <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
    <table class="w-full text-xs">
      <thead class="bg-gray-50 border-b border-gray-200">
        <tr>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Company</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Status</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Score</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Origin Ratio</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Funding</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Employees</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Tech Stack</th>
          <th class="text-left px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Sources</th>
          <th class="px-4 py-2.5"></th>
        </tr>
      </thead>
      <tbody id="companies-tbody">
        <tr><td colspan="9" class="px-4 py-10 text-center text-gray-400">
          <div class="inline-flex flex-col items-center gap-2">
            <div class="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            <span>Loading companies…</span>
          </div>
        </td></tr>
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  <div class="flex items-center justify-between mt-3 text-xs text-gray-500" id="pagination">
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
  <div class="bg-white rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-2xl" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
      <h2 id="modal-title" class="font-semibold text-gray-900"></h2>
      <button onclick="document.getElementById('modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
    </div>
    <div id="modal-body" class="px-6 py-4 text-sm"></div>
  </div>
</div>

<script>
let currentPage = 1;
let totalPages  = 1;

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(url, ms = 12000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      const text = await r.text().catch(() => r.statusText);
      throw new Error('API ' + r.status + ': ' + text.slice(0, 120));
    }
    return r.json();
  } finally {
    clearTimeout(id);
  }
}

function showError(msg) {
  document.getElementById('error-banner').style.display = 'flex';
  document.getElementById('error-msg').textContent = msg;
}
function hideError() {
  document.getElementById('error-banner').style.display = 'none';
}

// ── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const json = await apiFetch('/api/stats');
    const d = json.data;
    document.getElementById('s-total').textContent   = d.total   ?? 0;
    document.getElementById('s-pending').textContent = d.pending ?? 0;
    document.getElementById('s-hot').textContent     = d.hot     ?? 0;
    document.getElementById('s-warm').textContent    = d.warm    ?? 0;
    document.getElementById('s-cold').textContent    = d.cold    ?? 0;
    document.getElementById('s-disq').textContent    = d.disqualified ?? 0;
    hideError();
  } catch (e) {
    showError('Stats unavailable — ' + e.message + '. Is the API running? (npm run dev)');
  }
}

// ── Company table ────────────────────────────────────────────────────────────

async function loadCompanies() {
  const status  = document.getElementById('f-status').value;
  const score   = document.getElementById('f-score').value;
  const tech    = document.getElementById('f-tech').value;
  const funding = document.getElementById('f-funding').value;
  const source  = document.getElementById('f-source').value;
  const limit   = document.getElementById('f-limit').value;

  const params = new URLSearchParams({ page: currentPage, limit });
  if (status)  params.set('status', status);
  if (score)   params.set('minScore', score);
  if (tech)    params.set('techStack', tech);
  if (funding) params.set('fundingStage', funding);
  if (source)  params.set('source', source);

  const tbody = document.getElementById('companies-tbody');
  tbody.innerHTML = \`<tr><td colspan="9" class="px-4 py-10 text-center text-gray-400">
    <div class="inline-flex flex-col items-center gap-2">
      <div class="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
      <span>Loading…</span>
    </div>
  </td></tr>\`;

  try {
    const json = await apiFetch('/api/leads?' + params);
    const { data, meta } = json;

    totalPages = meta.pages || 1;
    document.getElementById('page-info').textContent =
      'Page ' + meta.page + ' of ' + totalPages + ' — ' + meta.total + ' companies';
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;
    hideError();

    if (!data || !data.length) {
      const isFiltered = status || score || tech || funding || source;
      tbody.innerHTML = \`<tr><td colspan="9" class="px-4 py-12 text-center">
        <div class="flex flex-col items-center gap-3 text-gray-400">
          <div class="text-3xl">\${isFiltered ? '🔍' : '📭'}</div>
          <div class="font-medium text-gray-600">\${isFiltered ? 'No matches for current filters' : 'No companies in database yet'}</div>
          <div class="text-xs max-w-sm">\${isFiltered
            ? 'Try removing filters — companies may still be in <b>pending</b> state (not yet scored).'
            : 'Run <code class="bg-gray-100 px-1 rounded font-mono">npm run seed</code> to start scraping, or wait for the auto-scheduler (runs every 2h).'
          }</div>
          \${isFiltered ? '<button onclick="resetFilters()" class="mt-1 text-xs text-blue-600 hover:underline">Clear filters</button>' : ''}
        </div>
      </td></tr>\`;
      return;
    }

    tbody.innerHTML = data.map(c => {
      const ratio = c.originRatio != null ? Math.round(c.originRatio * 100) + '%' : '—';
      const score = c.score != null && c.score > 0 ? c.score : '—';
      const tags  = (c.techStack || []).slice(0, 4).map(t =>
        '<span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">' + esc(t) + '</span>'
      ).join(' ');
      const sources = (c.sources || []).slice(0, 3).map(s =>
        '<span class="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px]">' + esc(s) + '</span>'
      ).join(' ');
      const status = c.status || 'pending';

      return '<tr class="data-row border-b border-gray-100 cursor-pointer" onclick="openCompany(\\''+c._id+'\\')"> ' +
        '<td class="px-4 py-2.5"><div class="font-medium text-gray-900">' + esc(c.name || '—') + '</div>' +
          '<div class="text-[10px] text-blue-500">' + esc(c.domain || '') + '</div></td>' +
        '<td class="px-4 py-2.5"><span class="badge badge-' + status + '">' + esc(status) + '</span></td>' +
        '<td class="px-4 py-2.5 font-bold ' + scoreColor(c.score) + '">' + score + '</td>' +
        '<td class="px-4 py-2.5 font-semibold ' + ratioColor(c.originRatio) + '">' + ratio + '</td>' +
        '<td class="px-4 py-2.5 text-gray-500">' + esc(c.fundingStage || '—') + '</td>' +
        '<td class="px-4 py-2.5 text-gray-600">' + (c.employeeCount || '—') + '</td>' +
        '<td class="px-4 py-2.5"><div class="flex flex-wrap gap-1">' + (tags || '—') + '</div></td>' +
        '<td class="px-4 py-2.5"><div class="flex flex-wrap gap-1">' + (sources || '—') + '</div></td>' +
        '<td class="px-4 py-2.5"><button onclick="event.stopPropagation();openCompany(\\''+c._id+'\\') " class="text-blue-500 hover:text-blue-700">→</button></td>' +
      '</tr>';
    }).join('');

    document.getElementById('last-refresh').textContent =
      'Last updated ' + new Date().toLocaleTimeString();

  } catch (e) {
    const isAbort = e.name === 'AbortError';
    const msg = isAbort
      ? 'Request timed out (12s). MongoDB or API may be slow — check terminal logs.'
      : e.message;
    showError(msg);
    tbody.innerHTML = \`<tr><td colspan="9" class="px-4 py-10 text-center">
      <div class="flex flex-col items-center gap-2 text-red-400">
        <span class="text-2xl">⚠</span>
        <span class="font-medium">\${esc(msg)}</span>
        <button onclick="hardRefresh()" class="mt-1 text-xs text-blue-600 hover:underline">Retry</button>
      </div>
    </td></tr>\`;
  }
}

// ── Company modal ────────────────────────────────────────────────────────────

async function openCompany(id) {
  document.getElementById('modal-title').textContent = 'Loading…';
  document.getElementById('modal-body').innerHTML =
    '<div class="text-gray-400 py-6 text-center">Loading…</div>';
  document.getElementById('modal').classList.remove('hidden');

  try {
    const json = await apiFetch('/api/companies/' + id, 10000);
    const { company: c, contacts: ct, summary } = json.data;

    // API returns contacts as { ceo, cto, hr, other[] } — flatten to array
    const contactList = [ct.ceo, ct.cto, ct.hr, ...(ct.other||[])].filter(Boolean);
    const totalContacts = summary ? summary.totalContacts : contactList.length;

    document.getElementById('modal-title').innerHTML =
      esc(c.name || c.domain) +
      ' <span class="badge badge-' + (c.status||'pending') + ' ml-2">' + esc(c.status||'pending') + '</span>';

    const contactCard = (person) =>
      '<div class="border border-gray-100 rounded-lg p-3 mb-2">' +
        '<div class="flex justify-between">' +
          '<div><span class="font-medium">' + esc(person.fullName||'—') + '</span>' +
          ' <span class="text-gray-400 text-xs">' + esc(person.role||'') + '</span></div>' +
          '<span class="text-xs ' + (person.emailVerified?'text-green-600':'text-gray-300') + '">' +
            (person.emailVerified?'✓ verified':'unverified') + '</span>' +
        '</div>' +
        (person.email ? '<div class="text-blue-500 text-xs mt-1">' + esc(person.email) + '</div>' : '') +
        (person.phone ? '<div class="text-gray-400 text-xs">' + esc(person.phone) + '</div>' : '') +
        (person.linkedinUrl ? '<div class="text-xs mt-0.5"><a href="' + esc(person.linkedinUrl) + '" target="_blank" class="text-blue-400 hover:underline">LinkedIn →</a></div>' : '') +
      '</div>';

    const contactsHtml = contactList.length
      ? contactList.map(contactCard).join('')
      : '<div class="text-gray-400 text-sm py-4 text-center">No contacts enriched yet</div>';

    const scoreRow = c.scoreBreakdown
      ? '<div class="mt-3 bg-gray-50 rounded-lg p-3 text-xs">' +
          '<div class="font-medium text-gray-600 mb-2">Score Breakdown</div>' +
          Object.entries(c.scoreBreakdown).map(([k,v]) =>
            '<div class="flex justify-between"><span class="text-gray-400">' + esc(k) + '</span><span class="font-medium">' + v + '</span></div>'
          ).join('') +
        '</div>' : '';

    document.getElementById('modal-body').innerHTML =
      '<div class="grid grid-cols-2 gap-2 mb-3">' +
        field('Domain',     '<a href="https://'+esc(c.domain)+'" target="_blank" class="text-blue-500 hover:underline">'+esc(c.domain)+'</a>') +
        field('Score',      '<span class="font-bold text-lg '+scoreColor(c.score)+'">'+(c.score||'—')+' / 100</span>') +
        field('Status',     '<span class="badge badge-'+(c.status||'pending')+'">'+esc(c.status||'pending')+'</span>') +
        field('Origin Ratio','<span class="'+ratioColor(c.originRatio)+' font-semibold">'+(c.originRatio!=null?Math.round(c.originRatio*100)+'%':'—')+'</span>') +
        field('Funding',    esc(c.fundingStage||'—')) +
        field('Employees',  esc(c.employeeCount||'—')) +
        field('Founded',    esc(c.foundedYear||'—')) +
        field('Sources',    (c.sources||[]).map(s=>'<span class="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px]">'+esc(s)+'</span>').join(' ')||'—') +
      '</div>' +
      scoreRow +
      (c.techStack&&c.techStack.length ?
        '<div class="mt-3"><div class="text-xs text-gray-500 mb-1.5 font-medium">Tech Stack</div>' +
        '<div class="flex flex-wrap gap-1">' + c.techStack.map(t=>'<span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs">'+esc(t)+'</span>').join('') + '</div></div>' : '') +
      (c.description ? '<div class="mt-3 text-xs text-gray-500 italic">' + esc(c.description.slice(0,300)) + '</div>' : '') +
      '<div class="mt-4"><div class="text-xs text-gray-500 mb-2 font-medium">Contacts (' + totalContacts + ')</div>' +
      contactsHtml + '</div>';

  } catch (e) {
    document.getElementById('modal-body').innerHTML =
      '<div class="text-red-400 py-4 text-center">Failed to load: ' + esc(e.message) + '</div>';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function field(label, value) {
  return '<div class="bg-gray-50 rounded-lg p-2.5"><div class="text-[10px] text-gray-400 mb-0.5">'+label+'</div><div class="text-sm">'+value+'</div></div>';
}
function closeModal(e) {
  if (e.target === document.getElementById('modal'))
    document.getElementById('modal').classList.add('hidden');
}
function exportCSV() {
  const status = document.getElementById('f-status').value;
  const score  = document.getElementById('f-score').value;
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (score)  p.set('minScore', score);
  window.location.href = '/api/export/csv?' + p;
}
function applyFilters() { currentPage = 1; loadCompanies(); }
function resetFilters() {
  ['f-status','f-tech','f-funding','f-source'].forEach(id =>
    document.getElementById(id).value = '');
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
function hardRefresh() { loadStats(); loadCompanies(); }
function scoreColor(s) {
  if (!s || s < 1) return 'text-gray-400';
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
function esc(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────────────────────
loadStats();
loadCompanies();
setInterval(() => { loadStats(); loadCompanies(); }, 30000);
</script>
</body>
</html>`;
