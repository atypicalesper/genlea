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
  <title>GenLea Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    *{box-sizing:border-box;}
    .info-btn{width:15px;height:15px;border-radius:50%;background:#e5e7eb;color:#6b7280;font-size:9px;font-weight:700;border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;transition:background .15s,color .15s;}
    .info-btn:hover{background:#dbeafe;color:#1d4ed8;}
    .tip-box{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 10px;font-size:11px;color:#0369a1;margin-bottom:6px;line-height:1.5;}
    .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;}
    .badge-hot_verified{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;}
    .badge-hot{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;}
    .badge-warm{background:#fefce8;color:#ca8a04;border:1px solid #fde047;}
    .badge-cold{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;}
    .badge-disqualified{background:#f9fafb;color:#6b7280;border:1px solid #e5e7eb;}
    .badge-pending{background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe;}
    .badge-skipped{background:#fafafa;color:#9ca3af;border:1px solid #e5e7eb;}
    .badge-processing{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;}
    .badge-enriching{background:#ecfdf5;color:#059669;border:1px solid #6ee7b7;}
    .badge-scoring{background:#fdf4ff;color:#9333ea;border:1px solid #e9d5ff;}
    .badge-watchlist{background:#fff7ed;color:#b45309;border:1px solid #fcd34d;}
    @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
    .live-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:currentColor;margin-right:3px;animation:pulse-dot 1.2s ease-in-out infinite;}
    .badge-success{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;}
    .badge-failed{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;}
    .badge-partial{background:#fefce8;color:#ca8a04;border:1px solid #fde047;}
    tr.data-row:hover td{background:#f8fafc;}
    .tab-btn{padding:8px 18px;font-size:13px;font-weight:500;border-bottom:2px solid transparent;color:#6b7280;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s;}
    .tab-btn.active{color:#2563eb;border-bottom-color:#2563eb;}
    .tab-btn:hover:not(.active){color:#374151;border-bottom-color:#e5e7eb;}
    .tab-panel{display:none;}
    .tab-panel.active{display:block;}
    .stat-pill{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:8px 16px;border-right:1px solid #f1f5f9;cursor:pointer;transition:background .1s;}
    .stat-pill:last-child{border-right:none;}
    .stat-pill:hover{background:#f8fafc;}
    .stat-pill.active-seg{background:#eff6ff;}
    .sort-th{cursor:pointer;user-select:none;}
    .sort-th:hover{background:#f1f5f9;}
    .sort-th span.sort-icon{opacity:.35;margin-left:3px;font-size:10px;}
    .sort-th.sorted span.sort-icon{opacity:1;color:#2563eb;}
    .queue-card{border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;}
    .prog-bar{height:8px;background:#e5e7eb;border-radius:9999px;overflow:hidden;}
    .prog-fill{height:100%;border-radius:9999px;transition:width .4s;}
    #error-banner{display:none;}
    .action-btn{padding:3px 8px;border-radius:5px;font-size:11px;border:1px solid #e5e7eb;background:white;cursor:pointer;transition:background .1s;}
    .action-btn:hover{background:#f1f5f9;}
    .action-btn.danger:hover{background:#fef2f2;border-color:#fca5a5;color:#dc2626;}
    input[type=range]{accent-color:#2563eb;}
    .toast{position:fixed;bottom:24px;right:24px;z-index:9999;background:#1e293b;color:white;padding:10px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;}
    .toast.show{opacity:1;}
    select,input[type=text],input[type=number]{border:1px solid #e5e7eb;border-radius:6px;padding:5px 8px;font-size:12px;background:white;outline:none;}
    select:focus,input:focus{border-color:#93c5fd;box-shadow:0 0 0 2px #eff6ff;}
    .warn-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:9999px;font-size:11px;font-weight:600;border:1px solid;cursor:default;}
    .warn-pill-error{background:#fef2f2;color:#dc2626;border-color:#fca5a5;}
    .warn-pill-warning{background:#fefce8;color:#ca8a04;border-color:#fde047;}
    .warn-pill-info{background:#f9fafb;color:#6b7280;border-color:#e5e7eb;}
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans text-sm text-gray-800">

<!-- HEADER -->
<div class="bg-white border-b border-gray-200 px-5 py-2.5 flex items-center justify-between sticky top-0 z-40">
  <div class="flex items-center gap-4">
    <span class="font-bold text-gray-900 text-lg tracking-tight">GenLea</span>
    <nav class="flex" id="main-tabs">
      <button class="tab-btn active" onclick="switchTab('leads')">Leads</button>
      <button class="tab-btn" onclick="switchTab('control')">Control Panel</button>
      <button class="tab-btn" onclick="switchTab('logs')">Activity Logs</button>
      <button class="tab-btn" onclick="switchTab('analytics')">Analytics</button>
      <button class="tab-btn" onclick="switchTab('queues')">Queue Monitor</button>
    </nav>
  </div>
  <div class="flex items-center gap-3">
    <span id="last-refresh" class="text-xs text-gray-400"></span>
    <span id="warnings-badge" class="hidden text-xs font-medium rounded-full px-2 py-0.5 cursor-pointer" onclick="switchTab('control')" title="Click to see system warnings"></span>
    <button onclick="hardRefresh()" class="text-xs text-blue-600 hover:underline">↻ Refresh</button>
    <a href="/health" target="_blank" class="text-xs text-gray-400 hover:underline">Health</a>
  </div>
</div>

<!-- PIPELINE ACTIVITY BAR (global, all tabs) -->
<div id="activity-bar" class="hidden bg-blue-50 border-b border-blue-200 px-5 py-1.5 flex items-center gap-2 text-xs text-blue-700 overflow-x-auto">
  <span class="inline-flex items-center gap-1 shrink-0">
    <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse inline-block"></span>
    <span class="font-semibold">Pipeline running:</span>
  </span>
  <div id="activity-pills" class="flex gap-1.5 flex-wrap"></div>
</div>

<!-- ERROR BANNER -->
<div id="error-banner" class="bg-red-50 border-b border-red-200 px-5 py-2 flex items-center justify-between">
  <span id="error-msg" class="text-red-700 text-xs"></span>
  <button onclick="hardRefresh()" class="text-xs text-red-600 hover:underline font-medium">Retry</button>
</div>

<!-- STATS BAR (always visible) -->
<div class="bg-white border-b border-gray-200 px-4 flex overflow-x-auto" id="stats-bar">
  <div class="stat-pill active-seg" id="seg-all" onclick="setSegment('all')">
    <span class="text-[10px] text-gray-400 uppercase tracking-wide">Total</span>
    <span class="font-bold text-gray-700 text-base" id="s-total">—</span>
  </div>
  <div class="stat-pill" id="seg-qualified" onclick="setSegment('qualified')">
    <span class="text-[10px] text-green-600 uppercase tracking-wide">Qualified</span>
    <span class="font-bold text-green-600 text-base" id="s-qualified">—</span>
    <span class="text-[9px] text-gray-400">hot + warm</span>
  </div>
  <div class="stat-pill" id="seg-hot" onclick="setSegment('hot_verified')">
    <span class="text-[10px] text-orange-500">🔥 Hot Verified</span>
    <span class="font-bold text-orange-600 text-base" id="s-hotv">—</span>
  </div>
  <div class="stat-pill" id="seg-hot2" onclick="setSegment('hot')">
    <span class="text-[10px] text-red-500">🔥 Hot</span>
    <span class="font-bold text-red-600 text-base" id="s-hot">—</span>
  </div>
  <div class="stat-pill" id="seg-warm" onclick="setSegment('warm')">
    <span class="text-[10px] text-yellow-600">🌡 Warm</span>
    <span class="font-bold text-yellow-600 text-base" id="s-warm">—</span>
  </div>
  <div class="stat-pill" id="seg-cold" onclick="setSegment('cold')">
    <span class="text-[10px] text-blue-500">❄ Cold</span>
    <span class="font-bold text-blue-600 text-base" id="s-cold">—</span>
  </div>
  <div class="stat-pill" id="seg-disq" onclick="setSegment('disqualified')">
    <span class="text-[10px] text-gray-400">✗ Disqualified</span>
    <span class="font-bold text-gray-500 text-base" id="s-disq">—</span>
  </div>
  <div class="stat-pill" id="seg-pending" onclick="setSegment('pending')">
    <span class="text-[10px] text-purple-500">⏳ Pending</span>
    <span class="font-bold text-purple-600 text-base" id="s-pending">—</span>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════ LEADS TAB -->
<div class="tab-panel active" id="tab-leads">
  <!-- Filters -->
  <div class="bg-white border-b border-gray-200 px-5 py-2.5 flex flex-wrap gap-2 items-end">
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Search</label>
      <input id="f-search" type="text" placeholder="company name or domain…"
        style="width:180px" oninput="debounceSearch()" />
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Status</label>
      <select id="f-status" onchange="applyFilters()">
        <option value="">All</option>
        <option value="hot_verified">🔥 Hot Verified</option>
        <option value="hot">🔥 Hot</option>
        <option value="warm">🌡 Warm</option>
        <option value="cold">❄ Cold</option>
        <option value="disqualified">✗ Disqualified</option>
        <option value="pending">⏳ Pending</option>
      </select>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Min Score</label>
      <input id="f-minscore" type="number" min="0" max="100" placeholder="0" style="width:56px"/>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Max Score</label>
      <input id="f-maxscore" type="number" min="0" max="100" placeholder="100" style="width:56px"/>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Tech Stack</label>
      <select id="f-tech" onchange="applyFilters()">
        <option value="">Any</option>
        <option>nodejs</option><option>typescript</option><option>python</option>
        <option>react</option><option>nextjs</option><option>nestjs</option>
        <option>fastapi</option><option>django</option><option>golang</option>
        <option>rust</option><option>ai</option><option>ml</option>
        <option>generative-ai</option><option>aws</option><option>docker</option>
      </select>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Funding</label>
      <select id="f-funding" onchange="applyFilters()">
        <option value="">Any</option>
        <option>Pre-seed</option><option>Seed</option>
        <option>Series A</option><option>Series B</option><option>Series C</option>
        <option>Series D+</option><option>Bootstrapped</option>
      </select>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Source</label>
      <select id="f-source" onchange="applyFilters()">
        <option value="">Any</option>
        <option>wellfound</option><option>linkedin</option><option>crunchbase</option>
        <option>apollo</option><option>indeed</option><option>glassdoor</option>
        <option>surelyremote</option><option>github</option><option>zoominfo</option>
        <option>website</option><option>hunter</option><option>clearbit</option>
        <option>clay</option>
      </select>
    </div>
    <div class="flex flex-col gap-0.5">
      <label class="text-[10px] text-gray-400 uppercase tracking-wide">Per page</label>
      <select id="f-limit" onchange="applyFilters()">
        <option value="25">25</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
        <option value="250">250</option>
      </select>
    </div>
    <button onclick="applyFilters()"
      class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded transition self-end">
      Apply
    </button>
    <button onclick="resetFilters()"
      class="text-gray-500 text-xs px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 transition self-end">
      Reset
    </button>
    <button onclick="exportCSV()"
      class="ml-auto bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1.5 rounded transition self-end">
      ↓ Export CSV
    </button>
  </div>

  <!-- Table -->
  <div class="px-5 py-3">
    <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table class="w-full text-xs" id="leads-table">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide sort-th" onclick="setSort('name')">
              Company<span class="sort-icon" id="si-name">↕</span>
            </th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide sort-th" onclick="setSort('score')">
              Score<span class="sort-icon" id="si-score">↕</span>
            </th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Status</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide sort-th" onclick="setSort('originRatio')">
              Origin %<span class="sort-icon" id="si-originRatio">↕</span>
            </th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide sort-th" onclick="setSort('fundingStage')">
              Funding<span class="sort-icon" id="si-fundingStage">↕</span>
            </th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide sort-th" onclick="setSort('employeeCount')">
              Employees<span class="sort-icon" id="si-employeeCount">↕</span>
            </th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Tech Stack</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Open Roles</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Sources</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Contacts</th>
            <th class="px-4 py-2.5 text-gray-500 uppercase tracking-wide">Actions</th>
          </tr>
        </thead>
        <tbody id="companies-tbody">
          <tr><td colspan="11" class="px-4 py-10 text-center text-gray-400">
            <div class="inline-flex flex-col items-center gap-2">
              <div class="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
              <span>Loading companies…</span>
            </div>
          </td></tr>
        </tbody>
      </table>
    </div>
    <!-- Pagination -->
    <div class="flex items-center justify-between mt-2.5 text-xs text-gray-500">
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
</div>

<!-- ══════════════════════════════════════════════════════ CONTROL PANEL TAB -->
<div class="tab-panel" id="tab-control">
  <div class="px-5 py-4 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4">

    <!-- Seed Control -->
    <div class="bg-white border border-gray-200 rounded-xl p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="font-semibold text-gray-900">Pipeline Seeding</h2>
          <p class="text-xs text-gray-400 mt-0.5">Enqueue all 26 discovery queries across every scraper</p>
        </div>
        <div class="flex gap-2">
          <button id="seed-btn" onclick="triggerSeed()"
            class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition">
            🚀 Seed Now
          </button>
          <button id="rescore-btn" onclick="triggerRescoreAll()"
            class="bg-gray-600 hover:bg-gray-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
            title="Re-score every company with current threshold settings">
            ⚖️ Rescore All
          </button>
        </div>
      </div>
      <div class="text-xs text-gray-500 space-y-1" id="cron-info">
        <div class="flex justify-between"><span>Schedule</span><span class="font-medium text-gray-700">Every 2 hours (cron)</span></div>
        <div class="flex justify-between"><span>Last seeded</span><span class="font-medium text-gray-700" id="cron-last">—</span></div>
        <div class="flex justify-between"><span>Next approx.</span><span class="font-medium text-gray-700" id="cron-next">—</span></div>
        <div class="flex justify-between"><span>Seed queries</span><span class="font-medium text-gray-700" id="cron-count">26</span></div>
      </div>
      <div id="seed-result" class="hidden mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700"></div>
    </div>

    <!-- Manual Scrape -->
    <div class="bg-white border border-gray-200 rounded-xl p-5">
      <h2 class="font-semibold text-gray-900 mb-3">Manual Scrape</h2>
      <div class="space-y-2.5">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Source</label>
          <select id="ms-source" class="text-xs">
            <option value="wellfound">Wellfound</option>
            <option value="linkedin">LinkedIn</option>
            <option value="crunchbase">Crunchbase</option>
            <option value="apollo">Apollo</option>
            <option value="indeed">Indeed</option>
            <option value="glassdoor">Glassdoor</option>
            <option value="zoominfo">ZoomInfo</option>
            <option value="surelyremote">Surely Remote</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Keywords</label>
          <input id="ms-keywords" type="text" placeholder="e.g. YC startup backend engineer US" style="width:100%"/>
        </div>
        <div class="flex items-end gap-2">
          <div class="flex flex-col gap-1 flex-1">
            <label class="text-xs text-gray-500">Limit</label>
            <input id="ms-limit" type="number" value="25" min="5" max="100" style="width:70px"/>
          </div>
          <button onclick="triggerManualScrape()"
            class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded transition">
            Queue Job
          </button>
        </div>
        <div id="scrape-result" class="hidden bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 text-xs text-indigo-700"></div>
      </div>
    </div>

    <!-- System Warnings -->
    <div class="bg-white border border-gray-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h2 class="font-semibold text-gray-900">System Warnings</h2>
          <p class="text-xs text-gray-400 mt-0.5">Credential gaps, slow workers, agent loop detection</p>
        </div>
        <button onclick="loadHealthWarnings()" class="text-xs text-blue-600 hover:underline">↻ Refresh</button>
      </div>
      <div id="warnings-panel" class="space-y-1.5 text-xs text-gray-400">Checking…</div>
    </div>

    <!-- Queue Status -->
    <div class="bg-white border border-gray-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-semibold text-gray-900">Queue Status</h2>
        <button onclick="loadQueueStats()" class="text-xs text-blue-600 hover:underline">↻ Refresh</button>
      </div>
      <div class="grid grid-cols-3 gap-3" id="queue-cards">
        <div class="queue-card"><div class="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">Discovery</div><div id="q-discovery" class="text-xs text-gray-400">Loading…</div></div>
        <div class="queue-card"><div class="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">Enrichment</div><div id="q-enrichment" class="text-xs text-gray-400">Loading…</div></div>
        <div class="queue-card"><div class="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">Scoring</div><div id="q-scoring" class="text-xs text-gray-400">Loading…</div></div>
      </div>
      <div class="flex flex-wrap gap-2 mt-3">
        <button onclick="retryFailed('discovery')" class="action-btn text-xs" style="background:#eff6ff;color:#2563eb;border-color:#bfdbfe;">↺ Retry Discovery</button>
        <button onclick="retryFailed('enrichment')" class="action-btn text-xs" style="background:#eff6ff;color:#2563eb;border-color:#bfdbfe;">↺ Retry Enrichment</button>
        <button onclick="retryFailed('scoring')" class="action-btn text-xs" style="background:#eff6ff;color:#2563eb;border-color:#bfdbfe;">↺ Retry Scoring</button>
      </div>
      <div class="flex flex-wrap gap-2 mt-2">
        <button onclick="drainQueue('discovery')" class="action-btn danger text-xs">✕ Drain Discovery</button>
        <button onclick="drainQueue('enrichment')" class="action-btn danger text-xs">✕ Drain Enrichment</button>
        <button onclick="drainQueue('scoring')" class="action-btn danger text-xs">✕ Drain Scoring</button>
      </div>
    </div>

    <!-- Worker Concurrency -->
    <div class="bg-white border border-gray-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="font-semibold text-gray-900">Worker Concurrency</h2>
          <p class="text-xs text-gray-400 mt-0.5">Live — applied within 10 seconds, no restart needed</p>
        </div>
        <button onclick="saveConcurrency()" id="save-concurrency-btn"
          class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition">
          Save
        </button>
      </div>
      <div class="grid grid-cols-3 gap-6">
        <div>
          <div class="flex items-center gap-1.5 mb-2">
            <label class="text-xs font-medium text-gray-600">Discovery workers</label>
            <button class="info-btn" onclick="toggleTip('tip-conc-discovery')">?</button>
          </div>
          <div id="tip-conc-discovery" class="tip-box hidden">
            Parallel discovery jobs — each job scrapes one source (Wellfound, Indeed, LinkedIn, etc.) for company listings.<br/><br/>
            <strong>Higher:</strong> Faster discovery, more companies found per hour — but more browser instances and memory.<br/>
            <strong>Lower:</strong> Slower but lighter on resources. Recommended: 3–8 unless on a beefy server.
          </div>
          <div class="flex items-center gap-3">
            <input type="range" id="s-concurrency-discovery" min="1" max="20" step="1" value="10"
              oninput="syncConcurrency('discovery',this.value)" class="flex-1"/>
            <input type="number" id="n-concurrency-discovery" min="1" max="20" value="10"
              oninput="syncConcurrency('discovery',this.value,true)"
              class="w-14 text-center font-bold text-blue-600 text-sm"/>
          </div>
          <div class="flex justify-between text-[10px] text-gray-400 mt-0.5"><span>1</span><span>20</span></div>
        </div>
        <div>
          <div class="flex items-center gap-1.5 mb-2">
            <label class="text-xs font-medium text-gray-600">Enrichment workers</label>
            <button class="info-btn" onclick="toggleTip('tip-conc-enrichment')">?</button>
          </div>
          <div id="tip-conc-enrichment" class="tip-box hidden">
            Parallel enrichment jobs — each job enriches one company via GitHub, Hunter, Clearbit, website scraping, and name origin analysis.<br/><br/>
            <strong>Higher:</strong> Faster enrichment pipeline — companies reach scoring sooner. Watch your API rate limits (Hunter, Clearbit, Explorium all have quotas).<br/>
            <strong>Lower:</strong> Safer for API budgets. Recommended: 5–10 unless you have high API limits.
          </div>
          <div class="flex items-center gap-3">
            <input type="range" id="s-concurrency-enrichment" min="1" max="30" step="1" value="15"
              oninput="syncConcurrency('enrichment',this.value)" class="flex-1"/>
            <input type="number" id="n-concurrency-enrichment" min="1" max="30" value="15"
              oninput="syncConcurrency('enrichment',this.value,true)"
              class="w-14 text-center font-bold text-indigo-600 text-sm"/>
          </div>
          <div class="flex justify-between text-[10px] text-gray-400 mt-0.5"><span>1</span><span>30</span></div>
        </div>
        <div>
          <div class="flex items-center gap-1.5 mb-2">
            <label class="text-xs font-medium text-gray-600">Scoring workers</label>
            <button class="info-btn" onclick="toggleTip('tip-conc-scoring')">?</button>
          </div>
          <div id="tip-conc-scoring" class="tip-box hidden">
            Parallel scoring jobs — each job computes the 0–100 lead score for one company using the 5-signal rule engine (origin ratio, job freshness, tech stack, contacts, company fit).<br/><br/>
            Scoring is <strong>CPU-only</strong> (no network calls, no API usage) so this can safely be high. Recommended: 10–30.
          </div>
          <div class="flex items-center gap-3">
            <input type="range" id="s-concurrency-scoring" min="1" max="50" step="1" value="30"
              oninput="syncConcurrency('scoring',this.value)" class="flex-1"/>
            <input type="number" id="n-concurrency-scoring" min="1" max="50" value="30"
              oninput="syncConcurrency('scoring',this.value,true)"
              class="w-14 text-center font-bold text-emerald-600 text-sm"/>
          </div>
          <div class="flex justify-between text-[10px] text-gray-400 mt-0.5"><span>1</span><span>50</span></div>
        </div>
      </div>
      <div id="concurrency-saved" class="hidden mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-xs text-emerald-700">
        ✓ Concurrency updated — workers will pick it up within 10 seconds
      </div>
    </div>

    <!-- Danger Zone -->
    <div class="bg-white border border-red-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="font-semibold text-red-700">Danger Zone</h2>
          <p class="text-xs text-gray-400 mt-0.5">Irreversible — clears all companies, contacts, jobs, logs and drains all queues</p>
        </div>
        <button onclick="resetDatabase()"
          class="bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-4 py-2 rounded-lg transition">
          ✕ Reset Database
        </button>
      </div>
    </div>

    <!-- Currently Processing -->
    <div class="bg-white border border-gray-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h2 class="font-semibold text-gray-900">Currently Processing</h2>
          <p class="text-xs text-gray-400 mt-0.5">Jobs actively running through the pipeline right now</p>
        </div>
        <button onclick="loadActiveJobs()" class="text-xs text-blue-600 hover:underline">↻ Refresh</button>
      </div>
      <div id="active-jobs-panel" class="text-xs text-gray-400">Loading…</div>
    </div>

    <!-- Scoring & Ratio Settings -->
    <div class="bg-white border border-gray-200 rounded-xl p-5 md:col-span-2">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="font-semibold text-gray-900">Pipeline Parameters</h2>
          <p class="text-xs text-gray-400 mt-0.5">Controls how companies are qualified — changes take effect on next enrichment/scoring run</p>
        </div>
        <button onclick="saveSettings()" id="save-settings-btn"
          class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition">
          Save Settings
        </button>
      </div>
      <div class="grid grid-cols-2 gap-6">

        <!-- Origin Ratio -->
        <div class="space-y-4">
          <div>
            <div class="flex justify-between items-baseline mb-1">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-gray-600">Indian Origin Ratio Threshold</label>
                <button class="info-btn" onclick="toggleTip('tip-origin-ratio')">?</button>
              </div>
              <span class="text-xs font-bold text-blue-600" id="ratio-display">60%</span>
            </div>
            <div id="tip-origin-ratio" class="tip-box hidden">
              The minimum fraction of engineers at a company that must appear to be of Indian origin for the lead to score highly. The engine classifies developer names collected from GitHub, LinkedIn, and team pages.<br/><br/>
              <strong>Higher:</strong> Fewer leads, stronger signal — the ones that pass are very warm.<br/>
              <strong>Lower:</strong> Wider net — more companies qualify but average conversion drops.<br/>
              Contributes up to <strong>30 of 100</strong> points in the score.
            </div>
            <input type="range" id="s-origin-ratio" min="10" max="90" step="5" value="60"
              oninput="updateRatioDisplay()" class="w-full"/>
            <div class="flex justify-between text-[10px] text-gray-400 mt-0.5">
              <span>10% (1 in 10)</span><span>50% (1 in 2)</span><span>90% (9 in 10)</span>
            </div>
            <div class="mt-1.5 bg-blue-50 rounded-lg px-3 py-2 text-xs text-blue-700" id="ratio-desc">
              At least <strong>6 in 10</strong> devs must be of Indian origin
            </div>
          </div>
          <div>
            <div class="flex justify-between items-baseline mb-1">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-gray-600">Min Name Sample for Ratio</label>
                <button class="info-btn" onclick="toggleTip('tip-min-sample')">?</button>
              </div>
              <span class="text-xs font-bold text-gray-600" id="sample-display">10</span>
            </div>
            <div id="tip-min-sample" class="tip-box hidden">
              How many developer names must be collected before the origin ratio is trusted. If fewer names are available, the ratio score defaults to a neutral <strong>10/30</strong> instead of 0 — preventing small samples from unfairly disqualifying good leads.<br/><br/>
              <strong>Higher:</strong> More accurate ratios, but more companies get the neutral 10/30 fallback.<br/>
              <strong>Lower:</strong> Ratio kicks in sooner but may be based on too few names to be reliable.
            </div>
            <input type="range" id="s-min-sample" min="3" max="50" step="1" value="10"
              oninput="document.getElementById('sample-display').textContent=this.value" class="w-full"/>
            <div class="text-[10px] text-gray-400 mt-0.5">Minimum names needed before ratio is considered reliable</div>
          </div>
        </div>

        <!-- Score Thresholds -->
        <div class="space-y-4">
          <div>
            <div class="flex justify-between items-baseline mb-1">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-gray-600">Hot Verified Threshold (score ≥)</label>
                <button class="info-btn" onclick="toggleTip('tip-hotv')">?</button>
              </div>
              <span class="text-xs font-bold text-orange-700" id="hotv-display">80</span>
            </div>
            <div id="tip-hotv" class="tip-box hidden">
              Companies scoring at or above this are classified as <strong>Hot Verified</strong> — top priority leads. They have confirmed contacts with verified emails, strong Indian-origin ratios, and active engineering hiring.<br/><br/>
              <strong>Raise:</strong> Tightens the top tier — more companies fall to Hot instead.<br/>
              <strong>Lower:</strong> Expands Hot Verified but risks including less-qualified leads at the top of your outreach queue.
            </div>
            <input type="range" id="s-hotv-threshold" min="60" max="100" step="5" value="80"
              oninput="document.getElementById('hotv-display').textContent=this.value" class="w-full"/>
            <div class="text-[10px] text-gray-400 mt-0.5">Score to classify as 🔥 Hot Verified lead</div>
          </div>
          <div>
            <div class="flex justify-between items-baseline mb-1">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-gray-600">Hot Lead Threshold (score ≥)</label>
                <button class="info-btn" onclick="toggleTip('tip-hot')">?</button>
              </div>
              <span class="text-xs font-bold text-orange-600" id="hot-display">55</span>
            </div>
            <div id="tip-hot" class="tip-box hidden">
              Companies scoring at or above this (but below Hot Verified) are classified as <strong>Hot</strong>. They match most criteria — hiring in target stack, team composition looks right — but may lack a verified email or have a smaller name sample.<br/><br/>
              <strong>Raise:</strong> Shrinks the Hot pool, pushes borderline companies to Warm.<br/>
              <strong>Lower:</strong> Grows Hot, potentially diluting the signal for your outreach team.
            </div>
            <input type="range" id="s-hot-threshold" min="40" max="90" step="5" value="55"
              oninput="document.getElementById('hot-display').textContent=this.value" class="w-full"/>
            <div class="text-[10px] text-gray-400 mt-0.5">Score to classify as 🔥 Hot lead</div>
          </div>
          <div>
            <div class="flex justify-between items-baseline mb-1">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-gray-600">Warm Lead Threshold (score ≥)</label>
                <button class="info-btn" onclick="toggleTip('tip-warm')">?</button>
              </div>
              <span class="text-xs font-bold text-yellow-600" id="warm-display">50</span>
            </div>
            <div id="tip-warm" class="tip-box hidden">
              Companies scoring at or above this (but below Hot) are classified as <strong>Warm</strong>. They show some signal but may be missing contacts, have low origin ratios, or be in a less-targeted tech stack. Good for follow-up after the Hot pool is worked.<br/><br/>
              <strong>Raise:</strong> More companies fall to Cold — stricter Warm qualification.<br/>
              <strong>Lower:</strong> Larger Warm pool, useful if you want to cast a wider net.
            </div>
            <input type="range" id="s-warm-threshold" min="20" max="70" step="5" value="50"
              oninput="document.getElementById('warm-display').textContent=this.value" class="w-full"/>
            <div class="text-[10px] text-gray-400 mt-0.5">Score to classify as 🌡 Warm lead</div>
          </div>
          <div id="settings-saved" class="hidden bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-xs text-emerald-700">
            ✓ Settings saved — applies to new enrichment/scoring jobs
          </div>
        </div>

      </div>

      <!-- Tag editors — full width -->
      <div class="grid grid-cols-2 gap-6 mt-4 pt-4 border-t border-gray-100">

        <!-- Tech Stack Tags -->
        <div>
          <div class="flex items-center gap-1.5 mb-1">
            <label class="text-xs font-medium text-gray-600">Target Tech Stack Tags</label>
            <button class="info-btn" onclick="toggleTip(\'tip-tech-tags\')">?</button>
          </div>
          <div id="tip-tech-tags" class="tip-box hidden mb-2">
            Comma-separated list of tech tags that score positively (up to <strong>20 pts</strong>). Tags matching <strong>ai, ml, generative-ai</strong> score 5 pts each; all others score 3 pts each.
          </div>
          <textarea id="s-tech-tags" rows="3"
            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
            placeholder="nodejs, typescript, python, react, ai, ml"></textarea>
          <div class="text-[10px] text-gray-400 mt-0.5">Comma-separated — changes apply to next scoring run</div>
        </div>

        <!-- High-Value Industries -->
        <div>
          <div class="flex items-center gap-1.5 mb-1">
            <label class="text-xs font-medium text-gray-600">High-Value Industries</label>
            <button class="info-btn" onclick="toggleTip(\'tip-industries\')">?</button>
          </div>
          <div id="tip-industries" class="tip-box hidden mb-2">
            Comma-separated industry keywords (matched as substrings, case-insensitive). Companies whose industry contains any of these receive a <strong>+3 pt bonus</strong> in the Company Fit score. Companies with no industry data also receive the bonus (failsafe).
          </div>
          <textarea id="s-industries" rows="3"
            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
            placeholder="ai, saas, fintech, healthtech, edtech"></textarea>
          <div class="text-[10px] text-gray-400 mt-0.5">Comma-separated — changes apply to next scoring run</div>
        </div>

      </div>
    </div>

  </div>
</div>

<!-- ══════════════════════════════════════════════════════════ ACTIVITY LOGS TAB -->
<div class="tab-panel" id="tab-logs">
  <div class="px-5 py-4">
    <!-- Log stats + filter bar -->
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div class="flex gap-3 items-center flex-wrap">
        <div class="flex gap-2 text-xs">
          <span class="bg-gray-100 rounded-full px-3 py-1">Total: <span id="log-total" class="font-bold">—</span></span>
          <span class="bg-green-50 text-green-700 rounded-full px-3 py-1">Success: <span id="log-success" class="font-bold">—</span></span>
          <span class="bg-yellow-50 text-yellow-700 rounded-full px-3 py-1">Partial: <span id="log-partial" class="font-bold">—</span></span>
          <span class="bg-red-50 text-red-700 rounded-full px-3 py-1">Failed: <span id="log-failed" class="font-bold">—</span></span>
        </div>
        <select id="log-filter-scraper" onchange="loadLogs()" class="text-xs">
          <option value="">All scrapers</option>
          <option>wellfound</option><option>linkedin</option><option>crunchbase</option>
          <option>apollo</option><option>indeed</option><option>glassdoor</option>
          <option>surelyremote</option><option>github</option><option>zoominfo</option>
          <option>hunter</option><option>clearbit</option><option>website</option>
          <option>clay</option>
        </select>
        <select id="log-filter-limit" onchange="loadLogs()" class="text-xs">
          <option value="50">Last 50</option>
          <option value="100">Last 100</option>
          <option value="200">Last 200</option>
        </select>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <label class="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" id="log-autorefresh" checked onchange="toggleLogRefresh()"/>
          Auto-refresh (10s)
        </label>
        <button onclick="loadLogs()" class="text-blue-600 hover:underline">↻ Refresh</button>
      </div>
    </div>

    <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Time</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Scraper</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Status</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Companies</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Contacts</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Duration</th>
            <th class="text-left px-4 py-2.5 text-gray-500 uppercase tracking-wide">Details</th>
          </tr>
        </thead>
        <tbody id="logs-tbody">
          <tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">Loading logs…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════ ANALYTICS TAB -->
<div class="tab-panel" id="tab-analytics">
  <div class="px-5 py-4 max-w-5xl mx-auto space-y-4">

    <!-- Lead Funnel -->
    <div class="bg-white border border-gray-200 rounded-xl p-5">
      <h2 class="font-semibold text-gray-900 mb-3">Lead Qualification Funnel</h2>
      <div id="funnel-bars" class="space-y-2"></div>
    </div>

    <!-- Two column: tech stacks + scraper performance -->
    <div class="grid grid-cols-2 gap-4">
      <div class="bg-white border border-gray-200 rounded-xl p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Top Tech Stacks</h2>
        <div id="tech-bars" class="space-y-1.5"></div>
      </div>
      <div class="bg-white border border-gray-200 rounded-xl p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Scraper Performance</h2>
        <div id="scraper-bars" class="space-y-2"></div>
      </div>
    </div>

    <!-- Score distribution -->
    <div class="bg-white border border-gray-200 rounded-xl p-5">
      <h2 class="font-semibold text-gray-900 mb-3">Score Distribution</h2>
      <div class="flex items-end gap-1.5 h-28" id="score-hist"></div>
      <div class="flex justify-between text-[10px] text-gray-400 mt-1 px-0.5">
        <span>0</span><span>10</span><span>20</span><span>30</span><span>40</span>
        <span>50</span><span>60</span><span>70</span><span>80</span><span>90</span><span>100</span>
      </div>
    </div>

  </div>
</div>

<!-- ══════════════════════════════════════════════════════════ QUEUE MONITOR TAB -->
<div class="tab-panel" id="tab-queues" style="height:calc(100vh - 110px)">
  <iframe id="queues-iframe" src="" class="w-full h-full border-0" title="Queue Monitor"></iframe>
</div>

<!-- ══════════════════════════════════════════════════════════ COMPANY MODAL -->
<div id="modal" class="hidden fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onclick="closeModal(event)">
  <div class="bg-white rounded-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto shadow-2xl" onclick="event.stopPropagation()">
    <div class="flex items-center justify-between px-6 py-3.5 border-b border-gray-100 sticky top-0 bg-white z-10">
      <h2 id="modal-title" class="font-semibold text-gray-900 text-base"></h2>
      <div class="flex items-center gap-2">
        <button id="modal-enrich-btn" onclick="reEnrich()" class="action-btn text-xs text-indigo-600">↺ Re-enrich</button>
        <button id="modal-rescore-btn" onclick="reScore()" class="action-btn text-xs text-amber-600">⚡ Re-score</button>
        <button onclick="document.getElementById('modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none ml-1">✕</button>
      </div>
    </div>
    <div id="modal-body" class="px-6 py-4"></div>
  </div>
</div>

<!-- TOAST -->
<div class="toast" id="toast"></div>

<script>
// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════
let currentPage   = 1;
let totalPages    = 1;
let sortCol       = 'score';
let sortDir       = 'desc';
let activeSegment = 'all';
let searchTimer   = null;
let logRefreshId  = null;
let modalCompanyId = null;
let activeJobMap    = new Map(); // companyId → 'enriching'|'scoring'
let contactsMap     = {};        // companyId → Contact[]
let _logsCache      = [];        // last loaded scrape logs (for error detail lookup)
let activeJobsTimer = null;
let _loadingCompanies = false;   // guard against concurrent loadCompanies calls
let _freshActiveJobs  = false;   // true only when jobs started within last 5 min
let _activeWarnings   = [];      // [{type, severity, source, message, detail?}]

// ══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

async function apiFetch(url, opts, ms) {
  ms = ms || 15000;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    if (!r.ok) {
      const txt = await r.text().catch(() => r.statusText);
      throw new Error('API ' + r.status + ': ' + txt.slice(0, 140));
    }
    return r.json();
  } finally {
    clearTimeout(tid);
  }
}

async function apiPost(url, body) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiPatch(url, body) {
  return apiFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function apiDelete(url) {
  return apiFetch(url, { method: 'DELETE' });
}

function showError(msg) {
  document.getElementById('error-banner').style.display = 'flex';
  document.getElementById('error-msg').textContent = msg;
}
function hideError() {
  document.getElementById('error-banner').style.display = 'none';
}

function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms || 3000);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}
function scoreColor(s) {
  if (!s || s < 1) return 'text-gray-300';
  if (s >= 80) return 'text-orange-600';
  if (s >= 65) return 'text-red-500';
  if (s >= 50) return 'text-yellow-500';
  return 'text-blue-400';
}
function ratioColor(r) {
  if (r == null) return 'text-gray-300';
  if (r >= 0.75) return 'text-green-600';
  if (r >= 0.60) return 'text-yellow-600';
  if (r >= 0.40) return 'text-orange-400';
  return 'text-gray-300';
}

// ══════════════════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════════════════

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const tabs = ['leads','control','logs','analytics','queues'];
  const idx  = tabs.indexOf(name);
  if (idx >= 0) document.querySelectorAll('.tab-btn')[idx].classList.add('active');
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  if (name === 'control')   { loadQueueStats(); loadCronInfo(); loadActiveJobs(); loadHealthWarnings(); }
  if (name === 'logs')      loadLogs();
  if (name === 'analytics') loadAnalytics();
  if (name === 'queues') {
    const iframe = document.getElementById('queues-iframe');
    if (!iframe.src || iframe.src === window.location.href) iframe.src = '/queues';
  }
  location.hash = name;
}

// ══════════════════════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════════════════════

async function loadStats() {
  try {
    const json = await apiFetch('/api/stats');
    const d = json.data;
    document.getElementById('s-total').textContent   = d.total         ?? 0;
    document.getElementById('s-hotv').textContent    = d.hot_verified  ?? 0;
    document.getElementById('s-hot').textContent     = d.hot           ?? 0;
    document.getElementById('s-warm').textContent    = d.warm          ?? 0;
    document.getElementById('s-cold').textContent    = d.cold          ?? 0;
    document.getElementById('s-disq').textContent    = d.disqualified  ?? 0;
    document.getElementById('s-pending').textContent = d.pending       ?? 0;
    const qualified = (d.hot_verified||0) + (d.hot||0) + (d.warm||0);
    document.getElementById('s-qualified').textContent = qualified;
    hideError();
  } catch(e) {
    showError('Stats unavailable — ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SEGMENT / SORT / FILTERS
// ══════════════════════════════════════════════════════════════════════════════

function setSegment(seg) {
  activeSegment = seg;
  document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active-seg'));
  const map = {
    all:'seg-all', qualified:'seg-qualified', hot_verified:'seg-hot',
    hot:'seg-hot2', warm:'seg-warm', cold:'seg-cold', disqualified:'seg-disq', pending:'seg-pending'
  };
  const el = document.getElementById(map[seg]);
  if (el) el.classList.add('active-seg');
  document.getElementById('f-status').value = ['all','qualified'].includes(seg) ? '' : seg;
  currentPage = 1;
  loadCompanies();
}

function setSort(col) {
  if (sortCol === col) {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    sortCol = col;
    sortDir = 'desc';
  }
  document.querySelectorAll('.sort-th').forEach(th => th.classList.remove('sorted'));
  document.querySelectorAll('[id^="si-"]').forEach(el => { el.textContent = '↕'; });
  const th = document.querySelector('[onclick="setSort(\\''+col+'\\')"]');
  if (th) th.classList.add('sorted');
  const icon = document.getElementById('si-' + col);
  if (icon) icon.textContent = sortDir === 'desc' ? '↓' : '↑';
  currentPage = 1;
  loadCompanies();
}

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage = 1; loadCompanies(); }, 350);
}

// ══════════════════════════════════════════════════════════════════════════════
// LEADS TABLE
// ══════════════════════════════════════════════════════════════════════════════

async function loadCompanies() {
  if (_loadingCompanies) return; // prevent concurrent calls
  _loadingCompanies = true;
  const status  = document.getElementById('f-status').value;
  const minsc   = document.getElementById('f-minscore').value;
  const maxsc   = document.getElementById('f-maxscore').value;
  const tech    = document.getElementById('f-tech').value;
  const funding = document.getElementById('f-funding').value;
  const source  = document.getElementById('f-source').value;
  const limit   = document.getElementById('f-limit').value;
  const search  = document.getElementById('f-search').value.trim();

  const params = new URLSearchParams({
    page:    String(currentPage),
    limit:   String(limit),
    sortBy:  sortCol,
    sortDir: sortDir,
  });
  if (activeSegment === 'qualified')    params.set('qualified', 'true');
  else if (activeSegment === 'disqualified') params.set('qualified', 'false');
  else if (status) params.set('status', status);
  if (minsc)   params.set('minScore', minsc);
  if (maxsc)   params.set('maxScore', maxsc);
  if (tech)    params.set('techStack', tech);
  if (funding) params.set('fundingStage', funding);
  if (source)  params.set('source', source);
  if (search)  params.set('search', search);

  const tbody = document.getElementById('companies-tbody');
  tbody.innerHTML = '<tr><td colspan="11" class="px-4 py-8 text-center text-gray-400">' +
    '<div class="inline-flex gap-2 items-center"><div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>Loading…</div>' +
    '</td></tr>';

  try {
    // Fetch companies + active pipeline jobs in parallel
    const [json, activeJson] = await Promise.all([
      apiFetch('/api/leads?' + params),
      apiFetch('/api/jobs/active').catch(() => ({ data: [] })),
    ]);

    // Build a map of companyId → pipeline phase for live overlay
    activeJobMap = new Map();
    for (const job of (activeJson.data || [])) {
      if (job.companyId && job.queue === 'enrichment') activeJobMap.set(String(job.companyId), 'enriching');
      if (job.companyId && job.queue === 'scoring')    activeJobMap.set(String(job.companyId), 'scoring');
    }

    const { data, meta } = json;
    totalPages = meta.pages || 1;
    document.getElementById('page-info').textContent =
      'Page ' + meta.page + ' of ' + totalPages + ' — ' + meta.total + ' companies';
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;
    hideError();

    // Batch-fetch contacts for this page
    if (data && data.length) {
      const ids = data.map(function(c) { return c._id; }).filter(Boolean).join(',');
      try {
        const ctJson = await apiFetch('/api/contacts/for-companies?ids=' + ids, null, 8000);
        contactsMap = ctJson.data || {};
      } catch(e) { contactsMap = {}; }
    }

    if (!data || !data.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="px-4 py-12 text-center">' +
        '<div class="flex flex-col items-center gap-2 text-gray-400">' +
        '<div class="text-3xl">📭</div>' +
        '<div class="font-medium text-gray-600">No companies found</div>' +
        '<div class="text-xs">Try adjusting filters or run a seed from the Control Panel</div>' +
        '<button onclick="resetFilters()" class="mt-1 text-xs text-blue-600 hover:underline">Clear filters</button>' +
        '</div></td></tr>';
      return;
    }

    tbody.innerHTML = data.map(function(c) {
      const ratio  = c.originRatio != null ? Math.round(c.originRatio * 100) + '%' : '—';
      const score  = c.score != null && c.score > 0 ? c.score : '—';
      const status = c.status || 'pending';
      const livePhase = activeJobMap.get(String(c._id));
      const tags   = (c.techStack || []).slice(0, 4).map(function(t) {
        return '<span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">' + esc(t) + '</span>';
      }).join(' ');
      const roles = (c.openRoles || []).slice(0, 2).map(function(r) {
        return '<span class="bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded text-[10px]">' + esc(r) + '</span>';
      }).join(' ');
      const sources = (c.sources || []).slice(0, 3).map(function(s) {
        return '<span class="bg-blue-50 text-blue-500 px-1.5 py-0.5 rounded text-[10px]">' + esc(s) + '</span>';
      }).join(' ');

      const rowContacts = contactsMap[String(c._id)] || [];
      const roleColors = {
        'CEO':'bg-orange-50 text-orange-700','Founder':'bg-orange-50 text-orange-700',
        'Co-Founder':'bg-orange-50 text-orange-700','CTO':'bg-purple-50 text-purple-700',
        'VP of Engineering':'bg-indigo-50 text-indigo-700','VP Engineering':'bg-indigo-50 text-indigo-700',
        'Head of Engineering':'bg-indigo-50 text-indigo-700','Director of Engineering':'bg-indigo-50 text-indigo-700',
        'HR':'bg-green-50 text-green-700','Recruiter':'bg-green-50 text-green-700',
        'Head of Talent':'bg-green-50 text-green-700','Talent Acquisition':'bg-green-50 text-green-700',
        'Head of HR':'bg-green-50 text-green-700','VP of HR':'bg-green-50 text-green-700',
      };
      const contactChips = rowContacts.slice(0, 3).map(function(p) {
        const cls = roleColors[p.role] || 'bg-gray-100 text-gray-600';
        const emailDot = p.email ? (p.emailVerified ? ' <span class="text-green-500">●</span>' : ' <span class="text-yellow-400">●</span>') : '';
        const firstName = p.fullName ? esc(p.fullName.split(' ')[0]) : '?';
        return '<div class="' + cls + ' px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5 leading-tight">' +
          firstName + ' · ' + esc(p.role || '?') + emailDot +
        '</div>';
      }).join('');
      const contactsCell = rowContacts.length
        ? '<div class="flex flex-col gap-0.5">' + contactChips +
          (rowContacts.length > 3 ? '<span class="text-[10px] text-gray-400">+' + (rowContacts.length - 3) + ' more</span>' : '') + '</div>'
        : '<span class="text-gray-300 text-[10px]">—</span>';

      const statusBadge = livePhase
        ? '<span class="badge badge-' + esc(status) + ' opacity-50 mr-1">' + esc(status) + '</span>' +
          '<span class="badge badge-' + livePhase + '"><span class="live-dot"></span>⚙ ' + livePhase + '</span>'
        : '<span class="badge badge-' + esc(status) + '">' + esc(status) + '</span>';

      return '<tr class="data-row border-b border-gray-100 cursor-pointer' + (livePhase ? ' bg-emerald-50/30' : '') + '" onclick="openCompany(\\''+c._id+'\\')"> ' +
        '<td class="px-4 py-2.5 max-w-[200px]">' +
          '<div class="font-medium text-gray-900 truncate">' + esc(c.name || '—') + '</div>' +
          '<div class="text-[10px] text-blue-500 truncate">' + esc(c.domain || '') + '</div>' +
        '</td>' +
        '<td class="px-4 py-2.5 font-bold ' + scoreColor(c.score) + '">' + score + '</td>' +
        '<td class="px-4 py-2.5">' + statusBadge + '</td>' +
        '<td class="px-4 py-2.5 font-semibold ' + ratioColor(c.originRatio) + '">' + ratio + '</td>' +
        '<td class="px-4 py-2.5 text-gray-500">' + esc(c.fundingStage || '—') + '</td>' +
        '<td class="px-4 py-2.5 text-gray-600">' + esc(c.employeeCount || '—') + '</td>' +
        '<td class="px-4 py-2.5"><div class="flex flex-wrap gap-1">' + (tags || '<span class="text-gray-300">—</span>') + '</div></td>' +
        '<td class="px-4 py-2.5"><div class="flex flex-wrap gap-1">' + (roles || '<span class="text-gray-300">—</span>') + '</div></td>' +
        '<td class="px-4 py-2.5"><div class="flex flex-wrap gap-1">' + (sources || '<span class="text-gray-300">—</span>') + '</div></td>' +
        '<td class="px-4 py-2.5">' + contactsCell + '</td>' +
        '<td class="px-4 py-2.5">' +
          '<div class="flex gap-1 flex-wrap" onclick="event.stopPropagation()">' +
            (status === 'disqualified'
              ? '<button onclick="restoreLead(\\''+c._id+'\\')" class="action-btn text-green-600" style="border-color:#bbf7d0;background:#f0fdf4" title="Restore lead">↩ Restore</button>'
              : '<button onclick="disqualifyLead(\\''+c._id+'\\',\\''+esc(c.name||c.domain)+'\\')" class="action-btn danger" title="Disqualify lead">✗ Disq.</button>'
            ) +
            '<button onclick="openCompany(\\''+c._id+'\\',true)" class="action-btn" title="View detail">→</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');

    document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString();

  } catch(e) {
    const msg = e.name === 'AbortError'
      ? 'Request timed out — check that the API and MongoDB are running'
      : e.message;
    showError(msg);
    tbody.innerHTML = '<tr><td colspan="11" class="px-4 py-8 text-center">' +
      '<div class="flex flex-col items-center gap-2 text-red-400"><span class="text-2xl">⚠</span>' +
      '<span class="font-medium">' + esc(msg) + '</span>' +
      '<button onclick="hardRefresh()" class="text-xs text-blue-600 hover:underline mt-1">Retry</button>' +
      '</div></td></tr>';
  } finally {
    _loadingCompanies = false;
  }
}

async function disqualifyLead(id, name) {
  if (!confirm('Disqualify "' + name + '"?\\n\\nThis marks it as manually reviewed and removes it from the active pipeline.')) return;
  try {
    await apiPatch('/api/companies/' + id + '/status', { status: 'disqualified' });
    toast('Disqualified: ' + name);
    document.getElementById('modal').classList.add('hidden');
    loadCompanies();
    loadStats();
  } catch(e) {
    toast('Failed: ' + e.message);
  }
}

async function restoreLead(id) {
  const statuses = ['hot_verified','hot','warm','cold','pending'];
  const next = prompt('Restore to which status?\\n\\n' + statuses.join(' | ') + '\\n\\n(default: cold)') || 'cold';
  if (!statuses.includes(next.trim())) { toast('Invalid status: ' + next.trim()); return; }
  try {
    await apiPatch('/api/companies/' + id + '/status', { status: next.trim() });
    toast('Restored to ' + next.trim());
    loadCompanies();
    loadStats();
  } catch(e) {
    toast('Failed: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPANY MODAL
// ══════════════════════════════════════════════════════════════════════════════

async function openCompany(id) {
  modalCompanyId = id;
  document.getElementById('modal-title').textContent = 'Loading…';
  document.getElementById('modal-body').innerHTML =
    '<div class="text-gray-400 py-6 text-center">Loading company data…</div>';
  document.getElementById('modal').classList.remove('hidden');

  try {
    const json = await apiFetch('/api/companies/' + id, null, 10000);
    const { company: c, contacts: ct, jobs: jb, summary } = json.data;
    const contactList = Array.isArray(ct) ? ct : [ct.ceo, ct.cto, ct.hr, ...(ct.other||[])].filter(Boolean);
    const activeJobs  = (jb && jb.active) ? jb.active : [];

    document.getElementById('modal-title').innerHTML =
      esc(c.name || c.domain) +
      ' <span class="badge badge-' + esc(c.status||'pending') + ' ml-2 text-xs">' + esc(c.status||'pending') + '</span>';

    const roleChipCls = function(role) {
      if (['CEO','Founder','Co-Founder'].includes(role)) return 'bg-orange-50 text-orange-700 border border-orange-200';
      if (['CTO','CPO','COO','CFO'].includes(role)) return 'bg-purple-50 text-purple-700 border border-purple-200';
      if (['VP of Engineering','VP Engineering','Head of Engineering','Director of Engineering','Engineering Manager'].includes(role)) return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
      if (['HR','Head of HR','VP of HR','Recruiter','Head of Talent','Talent Acquisition'].includes(role)) return 'bg-green-50 text-green-700 border border-green-200';
      return 'bg-gray-100 text-gray-600 border border-gray-200';
    };

    const contactCard = function(p) {
      return '<tr class="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">' +
        '<td class="py-2 pr-3">' +
          '<div class="font-medium text-gray-900 text-xs">' + esc(p.fullName||'—') + '</div>' +
        '</td>' +
        '<td class="py-2 pr-3">' +
          '<span class="badge text-[10px] ' + roleChipCls(p.role) + '">' + esc(p.role||'—') + '</span>' +
        '</td>' +
        '<td class="py-2 pr-3 text-xs">' +
          (p.email
            ? '<div class="flex items-center gap-1">' +
                '<span class="text-blue-600 font-mono text-[11px]">' + esc(p.email) + '</span>' +
                (p.emailVerified
                  ? '<span class="text-green-500 text-[10px] font-semibold" title="Verified">✓</span>'
                  : (p.emailConfidence > 0 ? '<span class="text-yellow-500 text-[10px]" title="Unverified — ' + Math.round(p.emailConfidence*100) + '% confidence">~' + Math.round(p.emailConfidence*100) + '%</span>' : '')) +
              '</div>'
            : '<span class="text-gray-300">—</span>') +
        '</td>' +
        '<td class="py-2 pr-3 text-xs text-gray-500">' + esc(p.phone||'') + '</td>' +
        '<td class="py-2 text-xs">' +
          (p.linkedinUrl ? '<a href="' + esc(p.linkedinUrl) + '" target="_blank" class="text-blue-500 hover:underline">LinkedIn ↗</a>' : '') +
        '</td>' +
      '</tr>';
    };

    const jobCard = function(j) {
      return '<div class="flex items-start justify-between py-1.5 border-b border-gray-50 last:border-0 text-xs">' +
        '<div>' +
          '<span class="font-medium text-gray-800">' + esc(j.title||'—') + '</span>' +
          (j.postedAt ? ' <span class="text-gray-400 ml-1">' + fmtDate(j.postedAt) + '</span>' : '') +
          (j.techTags && j.techTags.length ? '<div class="flex flex-wrap gap-1 mt-0.5">' +
            j.techTags.slice(0,4).map(t => '<span class="bg-gray-100 text-gray-500 px-1 rounded text-[10px]">'+esc(t)+'</span>').join('') +
          '</div>' : '') +
        '</div>' +
        '<span class="bg-blue-50 text-blue-500 text-[10px] px-1.5 py-0.5 rounded ml-2 shrink-0">' + esc(j.source||'') + '</span>' +
      '</div>';
    };

    const scoreRow = c.scoreBreakdown ? (
      '<div class="mt-4 bg-gray-50 rounded-lg p-3 text-xs">' +
        '<div class="font-medium text-gray-600 mb-2">Score Breakdown</div>' +
        Object.entries(c.scoreBreakdown).filter(function(e){ return e[0] !== 'total'; }).map(function(e) {
          const maxMap = { originRatioScore:30, jobFreshnessScore:20, techStackScore:20, contactScore:15, companyFitScore:15 };
          const max = maxMap[e[0]] || 30;
          const pct = max > 0 ? Math.round((Number(e[1]) / max) * 100) : 0;
          return '<div class="flex items-center gap-2 mb-1.5">' +
            '<span class="text-gray-400 w-36 shrink-0">' + esc(e[0].replace(/Score$/,'').replace(/([A-Z])/g,' $1')) + '</span>' +
            '<div class="prog-bar flex-1"><div class="prog-fill bg-blue-400" style="width:' + pct + '%"></div></div>' +
            '<span class="font-medium text-gray-700 w-10 text-right">' + e[1] + ' / ' + max + '</span>' +
          '</div>';
        }).join('') +
        '<div class="flex justify-between font-bold text-gray-800 mt-2 pt-2 border-t border-gray-200">' +
          '<span>Total Score</span><span class="' + scoreColor(c.score) + '">' + (c.score||0) + ' / 100</span>' +
        '</div>' +
      '</div>'
    ) : '';

    document.getElementById('modal-body').innerHTML =
      '<div class="grid grid-cols-2 gap-2 mb-2">' +
        mfield('Domain', '<a href="https://'+esc(c.domain)+'" target="_blank" class="text-blue-500 hover:underline">'+esc(c.domain)+'</a>') +
        mfield('Score',  '<span class="font-bold text-lg '+scoreColor(c.score)+'">'+(c.score||'—')+' / 100</span>') +
        mfield('Status', '<span class="badge badge-'+(c.status||'pending')+'">'+esc(c.status||'pending')+'</span>') +
        mfield('Origin Ratio','<span class="'+ratioColor(c.originRatio)+' font-semibold">'+(c.originRatio!=null?Math.round(c.originRatio*100)+'%':'—')+'</span>') +
        mfield('Funding', esc(c.fundingStage||'—')) +
        mfield('Employees', esc(c.employeeCount||'—')) +
        mfield('Founded', esc(c.foundedYear||'—')) +
        mfield('HQ', esc([c.hqCity,c.hqState,c.hqCountry].filter(Boolean).join(', ')||'—')) +
        mfield('Sources', (c.sources||[]).map(s=>'<span class="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px]">'+esc(s)+'</span>').join(' ')||'—') +
        mfield('Scraped', fmtDate(c.lastScrapedAt)) +
      '</div>' +
      scoreRow +
      (c.techStack&&c.techStack.length
        ? '<div class="mt-3"><div class="text-xs text-gray-500 mb-1.5 font-medium">Tech Stack</div>' +
          '<div class="flex flex-wrap gap-1">' + c.techStack.map(t=>'<span class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs">'+esc(t)+'</span>').join('') + '</div></div>'
        : '') +
      (c.description ? '<div class="mt-3 text-xs text-gray-400 italic border-l-2 border-gray-200 pl-3">' + esc(c.description.slice(0,300)) + (c.description.length>300?'…':'') + '</div>' : '') +
      '<div class="mt-4">' +
        '<div class="flex items-center justify-between mb-2">' +
          '<div class="text-xs text-gray-500 font-medium">Contacts (' + contactList.length + ')</div>' +
          (contactList.filter(function(p){return p.emailVerified;}).length
            ? '<span class="text-[10px] text-green-600">✓ ' + contactList.filter(function(p){return p.emailVerified;}).length + ' verified email' + (contactList.filter(function(p){return p.emailVerified;}).length > 1 ? 's' : '') + '</span>'
            : '') +
        '</div>' +
        (contactList.length
          ? '<div class="border border-gray-100 rounded-lg overflow-hidden">' +
              '<table class="w-full text-xs">' +
                '<thead class="bg-gray-50 border-b border-gray-100">' +
                  '<tr>' +
                    '<th class="py-1.5 px-3 text-left text-[10px] text-gray-400 font-medium">Name</th>' +
                    '<th class="py-1.5 px-3 text-left text-[10px] text-gray-400 font-medium">Role</th>' +
                    '<th class="py-1.5 px-3 text-left text-[10px] text-gray-400 font-medium">Email</th>' +
                    '<th class="py-1.5 px-3 text-left text-[10px] text-gray-400 font-medium">Phone</th>' +
                    '<th class="py-1.5 px-3 text-left text-[10px] text-gray-400 font-medium">LinkedIn</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody class="px-3">' + contactList.map(contactCard).join('') + '</tbody>' +
              '</table>' +
            '</div>'
          : '<div class="text-gray-300 text-xs py-3 text-center border border-gray-100 rounded-lg">No contacts enriched yet — re-enrich to fetch decision-makers</div>') +
      '</div>' +
      '<div class="mt-3"><div class="text-xs text-gray-500 mb-2 font-medium">Active Jobs (' + activeJobs.length + ')</div>' +
        (activeJobs.length ? '<div class="border border-gray-100 rounded-lg px-3 py-1">' + activeJobs.map(jobCard).join('') + '</div>'
          : '<div class="text-gray-300 text-xs py-3 text-center">No open jobs found yet</div>') +
      '</div>' +
      '<div class="mt-4 pt-3 border-t border-gray-100 flex gap-2 flex-wrap">' +
        (c.status === 'disqualified'
          ? '<button onclick="restoreLead(\\''+id+'\\');closeModal({target:null})" class="action-btn text-xs text-green-600" style="border-color:#bbf7d0;background:#f0fdf4">↩ Restore Lead</button>'
          : '<button onclick="disqualifyLead(\\''+id+'\\',\\''+esc(c.name||c.domain)+'\\')" class="action-btn danger text-xs">✗ Disqualify</button>'
        ) +
        '<button onclick="quickStatus(\\''+id+'\\',\\''+esc(c.status||'pending')+'\\')" class="action-btn text-xs">✎ Change Status</button>' +
        '<button onclick="deleteCompany(\\''+id+'\\')" class="action-btn danger text-xs" style="margin-left:auto">✕ Delete</button>' +
      '</div>';

  } catch(e) {
    document.getElementById('modal-body').innerHTML =
      '<div class="text-red-400 py-4 text-center text-sm">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function mfield(label, value) {
  return '<div class="bg-gray-50 rounded-lg p-2.5"><div class="text-[10px] text-gray-400 mb-0.5">' + label + '</div><div class="text-sm">' + value + '</div></div>';
}

function closeModal(e) {
  if (e.target === document.getElementById('modal'))
    document.getElementById('modal').classList.add('hidden');
}

async function reEnrich() {
  if (!modalCompanyId) return;
  try {
    await apiPost('/api/companies/' + modalCompanyId + '/enrich', {});
    toast('Re-enrichment queued');
  } catch(e) { toast('Failed: ' + e.message); }
}

async function reScore() {
  if (!modalCompanyId) return;
  try {
    await apiPost('/api/companies/' + modalCompanyId + '/score', {});
    toast('Re-scoring queued');
  } catch(e) { toast('Failed: ' + e.message); }
}

async function deleteCompany(id) {
  if (!confirm('Delete this company and all its data?')) return;
  try {
    await apiDelete('/api/companies/' + id);
    toast('Company deleted');
    document.getElementById('modal').classList.add('hidden');
    loadCompanies();
    loadStats();
  } catch(e) { toast('Failed: ' + e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROL PANEL
// ══════════════════════════════════════════════════════════════════════════════

async function triggerSeed() {
  const btn = document.getElementById('seed-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Seeding…';
  try {
    const json = await apiPost('/api/seed', {});
    const d = json.data;
    const el = document.getElementById('seed-result');
    el.classList.remove('hidden');
    el.textContent = '✓ ' + d.queries + ' discovery jobs queued — Run ID: ' + d.runId;
    toast('Seed round queued: ' + d.queries + ' jobs');
    loadQueueStats();
    setTimeout(() => el.classList.add('hidden'), 8000);
  } catch(e) {
    toast('Seed failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Seed Now';
  }
}

async function triggerRescoreAll() {
  const btn = document.getElementById('rescore-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Queuing…';
  try {
    const json = await apiPost('/api/jobs/rescore-all', {});
    const d = json.data;
    toast('Rescore queued: ' + d.queued + ' companies');
    loadQueueStats();
  } catch(e) {
    toast('Rescore failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚖️ Rescore All';
  }
}

async function triggerManualScrape() {
  const source   = document.getElementById('ms-source').value;
  const keywords = document.getElementById('ms-keywords').value.trim();
  const limit    = parseInt(document.getElementById('ms-limit').value) || 25;
  if (!keywords) { toast('Enter keywords first'); return; }
  try {
    const json = await apiPost('/api/scrape', { source, query: { keywords, location: 'United States' }, limit });
    const el = document.getElementById('scrape-result');
    el.classList.remove('hidden');
    el.textContent = '✓ Queued — Run ID: ' + json.data.runId;
    toast('Job queued for ' + source);
    loadQueueStats();
    setTimeout(() => el.classList.add('hidden'), 6000);
  } catch(e) {
    toast('Failed: ' + e.message);
  }
}

async function loadQueueStats() {
  try {
    const json = await apiFetch('/api/jobs/status');
    const d = json.data;
    ['discovery','enrichment','scoring'].forEach(function(q) {
      const counts = d[q] || {};
      const waiting   = counts.waiting || 0;
      const active    = counts.active  || 0;
      const completed = counts.completed || 0;
      const failed    = counts.failed || 0;
      document.getElementById('q-' + q).innerHTML =
        '<div class="space-y-1">' +
          qrow('Waiting', waiting,  'text-yellow-600') +
          qrow('Active',  active,   'text-blue-600') +
          qrow('Done',    completed,'text-green-600') +
          qrow('Failed',  failed,   'text-red-500') +
        '</div>';
    });
  } catch(e) { /* silent */ }
}

function qrow(label, val, cls) {
  return '<div class="flex justify-between"><span class="text-gray-400">' + label + '</span>' +
    '<span class="font-semibold ' + cls + '">' + val + '</span></div>';
}

const STAGE_COLORS = { discovery: 'bg-blue-100 text-blue-700', enrichment: 'bg-purple-100 text-purple-700', scoring: 'bg-green-100 text-green-700' };
const STAGE_LABELS = { discovery: '🔍 Scraping', enrichment: '🔬 Enriching', scoring: '⚖️ Scoring' };

async function loadActiveJobs() {
  try {
    const json = await apiFetch('/api/jobs/active');
    const jobs = json.data || [];
    const panel = document.getElementById('active-jobs-panel');
    const bar   = document.getElementById('activity-bar');
    const pills = document.getElementById('activity-pills');

    if (!jobs.length) {
      panel.innerHTML = '<div class="text-gray-400 italic">No jobs currently running — pipeline is idle.</div>';
      bar.classList.add('hidden');
      _freshActiveJobs = false;
      updateWarningsFromJobs([]);
      return;
    }

    // Only treat jobs as "fresh" if started within the last 5 minutes
    // Stale active jobs (workers crashed) shouldn't trigger continuous table reloads
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    _freshActiveJobs = jobs.some(function(j) {
      return j.startedAt && new Date(j.startedAt).getTime() > fiveMinAgo;
    });

    // Group by queue stage
    const byStage = { discovery: [], enrichment: [], scoring: [] };
    jobs.forEach(function(j) { (byStage[j.queue] = byStage[j.queue] || []).push(j); });

    let html = '<div class="grid grid-cols-3 gap-3">';
    ['discovery','enrichment','scoring'].forEach(function(stage) {
      const list = byStage[stage] || [];
      const cls  = STAGE_COLORS[stage] || 'bg-gray-100 text-gray-700';
      const lbl  = STAGE_LABELS[stage] || stage;
      html += '<div class="rounded-lg border border-gray-100 p-3">';
      html += '<div class="text-xs font-semibold mb-2 ' + cls + ' inline-flex items-center gap-1 px-2 py-0.5 rounded">' + lbl + ' <span class="font-bold">' + list.length + '</span></div>';
      if (!list.length) {
        html += '<div class="text-xs text-gray-300 mt-1">idle</div>';
      } else {
        html += '<div class="space-y-1.5 mt-1">';
        list.forEach(function(j) {
          const label = stage === 'discovery'  ? (j.source || '?')
                      : stage === 'enrichment' ? (j.domain || '?')
                      : 'company';
          const since = j.startedAt ? Math.round((Date.now() - new Date(j.startedAt).getTime()) / 1000) + 's' : '';
          html += '<div class="flex items-center justify-between gap-2">';
          html += '<span class="font-medium text-gray-700 truncate">' + label + '</span>';
          if (since) html += '<span class="text-gray-400 shrink-0">' + since + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
    panel.innerHTML = html;
    updateWarningsFromJobs(jobs);

    // Update global activity bar
    bar.classList.remove('hidden');
    pills.innerHTML = jobs.map(function(j) {
      const label = j.queue === 'discovery'  ? j.source
                  : j.queue === 'enrichment' ? j.domain
                  : 'scoring';
      const cls = STAGE_COLORS[j.queue] || 'bg-gray-100 text-gray-700';
      return '<span class="' + cls + ' px-2 py-0.5 rounded-full font-medium">' + j.queue + ':' + label + '</span>';
    }).join('');
  } catch(e) {
    document.getElementById('active-jobs-panel').innerHTML = '<div class="text-red-400">Failed to load active jobs</div>';
  }
}

async function loadCronInfo() {
  try {
    const json = await apiFetch('/api/jobs/cron');
    const d = json.data;
    document.getElementById('cron-last').textContent = d.lastSeedAt ? fmtDate(d.lastSeedAt) : 'Not yet (startup seeds on launch)';
    document.getElementById('cron-next').textContent = fmtDate(d.nextApproxAt);
    document.getElementById('cron-count').textContent = d.seedQueryCount;
  } catch(e) { /* silent */ }
}

async function retryFailed(name) {
  try {
    const res = await apiPost('/api/jobs/retry/' + name, {});
    toast(res.data.message);
    loadQueueStats();
  } catch(e) { toast('Retry failed: ' + e.message); }
}

async function drainQueue(name) {
  if (!confirm('Drain all waiting jobs in the ' + name + ' queue? Active jobs will finish.')) return;
  try {
    await apiDelete('/api/jobs/clear/' + name);
    toast(name + ' queue drained');
    loadQueueStats();
  } catch(e) { toast('Failed: ' + e.message); }
}

function toggleTip(id) {
  document.getElementById(id).classList.toggle('hidden');
}

function syncConcurrency(worker, val, fromNumber) {
  const n = Math.max(1, parseInt(val) || 1);
  document.getElementById('s-concurrency-' + worker).value = n;
  document.getElementById('n-concurrency-' + worker).value = n;
}

async function saveConcurrency() {
  const btn = document.getElementById('save-concurrency-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiPatch('/api/settings', {
      workerConcurrencyDiscovery:  parseInt(document.getElementById('n-concurrency-discovery').value),
      workerConcurrencyEnrichment: parseInt(document.getElementById('n-concurrency-enrichment').value),
      workerConcurrencyScoring:    parseInt(document.getElementById('n-concurrency-scoring').value),
    });
    const el = document.getElementById('concurrency-saved');
    el.classList.remove('hidden');
    toast('Worker concurrency saved');
    setTimeout(() => el.classList.add('hidden'), 4000);
  } catch(e) {
    toast('Save failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

async function resetDatabase() {
  const confirmed = confirm(
    'This will permanently delete ALL companies, contacts, jobs and logs, and drain all queues.\\n\\nType OK to confirm.'
  );
  if (!confirmed) return;
  try {
    await apiFetch('/api/admin/reset-db', { method: 'POST' });
    toast('Database reset — all data cleared');
    loadStats();
    loadCompanies();
    loadQueueStats();
  } catch(e) {
    toast('Reset failed: ' + e.message);
  }
}

async function loadSettings() {
  try {
    const json = await apiFetch('/api/settings');
    const d = json.data;
    const orPct = Math.round((d.originRatioThreshold || 0.10) * 100);
    document.getElementById('s-origin-ratio').value    = orPct;
    document.getElementById('s-min-sample').value      = d.originRatioMinSample           || 5;
    document.getElementById('s-hotv-threshold').value  = d.leadScoreHotVerifiedThreshold  || 80;
    document.getElementById('s-hot-threshold').value   = d.leadScoreHotThreshold          || 55;
    document.getElementById('s-warm-threshold').value  = d.leadScoreWarmThreshold         || 38;
    document.getElementById('sample-display').textContent = d.originRatioMinSample           || 5;
    document.getElementById('hotv-display').textContent   = d.leadScoreHotVerifiedThreshold  || 80;
    document.getElementById('hot-display').textContent    = d.leadScoreHotThreshold          || 55;
    document.getElementById('warm-display').textContent   = d.leadScoreWarmThreshold         || 38;
    const cd = d.workerConcurrencyDiscovery  || 10;
    const ce = d.workerConcurrencyEnrichment || 15;
    const cs = d.workerConcurrencyScoring    || 30;
    syncConcurrency('discovery',  cd);
    syncConcurrency('enrichment', ce);
    syncConcurrency('scoring',    cs);
    const defaultTags = 'nodejs, typescript, python, react, nextjs, nestjs, frontend, backend, fullstack, ai, ml, generative-ai, fastapi';
    const defaultInds = 'ai, saas, fintech, healthtech, edtech';
    document.getElementById('s-tech-tags').value = (d.targetTechTags ?? []).join(', ') || defaultTags;
    document.getElementById('s-industries').value = (d.highValueIndustries ?? []).join(', ') || defaultInds;
    updateRatioDisplay();
  } catch(e) { /* silent */ }
}

function updateRatioDisplay() {
  const val = parseInt(document.getElementById('s-origin-ratio').value);
  document.getElementById('ratio-display').textContent = val + '%';
  const n = Math.round(10 / (val / 100));
  document.getElementById('ratio-desc').innerHTML =
    'At least <strong>' + val + '%</strong> — roughly <strong>' + Math.round(100/val) + ' in ' + Math.round(100/val * (val/100)*10).toFixed(0) + '</strong>... ' +
    '<strong>1 in ' + Math.round(100/val) + ' devs</strong> must be of Indian origin';
}

async function saveSettings() {
  const btn = document.getElementById('save-settings-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const ratio = parseInt(document.getElementById('s-origin-ratio').value) / 100;
    const techTags = document.getElementById('s-tech-tags').value
      .split(',').map(t => t.trim()).filter(Boolean);
    const industries = document.getElementById('s-industries').value
      .split(',').map(t => t.trim()).filter(Boolean);
    await apiPatch('/api/settings', {
      originRatioThreshold:          ratio,
      originRatioMinSample:          parseInt(document.getElementById('s-min-sample').value),
      leadScoreHotVerifiedThreshold: parseInt(document.getElementById('s-hotv-threshold').value),
      leadScoreHotThreshold:         parseInt(document.getElementById('s-hot-threshold').value),
      leadScoreWarmThreshold:        parseInt(document.getElementById('s-warm-threshold').value),
      targetTechTags:                techTags,
      highValueIndustries:           industries,
    });
    const el = document.getElementById('settings-saved');
    el.classList.remove('hidden');
    toast('Settings saved');
    setTimeout(() => el.classList.add('hidden'), 4000);
  } catch(e) {
    toast('Save failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGS TAB
// ══════════════════════════════════════════════════════════════════════════════

async function loadLogs() {
  const scraper = document.getElementById('log-filter-scraper').value;
  const limit   = document.getElementById('log-filter-limit').value;
  const params  = new URLSearchParams({ limit });
  if (scraper) params.set('scraper', scraper);

  try {
    const [logsJson, statsJson] = await Promise.all([
      apiFetch('/api/jobs/logs?' + params),
      apiFetch('/api/jobs/stats'),
    ]);
    const logs  = logsJson.data || [];
    const stats = statsJson.data || {};
    document.getElementById('log-total').textContent   = stats.total   || 0;
    document.getElementById('log-success').textContent = stats.success || 0;
    document.getElementById('log-partial').textContent = stats.partial || 0;
    document.getElementById('log-failed').textContent  = stats.failed  || 0;

    _logsCache = logs;
    const tbody = document.getElementById('logs-tbody');
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">No scrape logs yet</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(function(l, i) {
      const errCount   = (l.errors || []).length;
      const stepCount  = (l.agentSteps || []).length;
      const hasDetails = errCount > 0 || stepCount > 0;

      let detailBtn = '<span class="text-gray-300">—</span>';
      if (errCount > 0 && stepCount > 0) {
        detailBtn = '<button onclick="showLogTrace(event,' + i + ')" class="text-red-500 text-[10px] hover:underline font-medium">'
          + errCount + ' error' + (errCount>1?'s':'') + ' · ' + stepCount + ' steps</button>';
      } else if (errCount > 0) {
        detailBtn = '<button onclick="showLogTrace(event,' + i + ')" class="text-red-500 text-[10px] hover:underline font-medium">'
          + errCount + ' error' + (errCount>1?'s':'') + '</button>';
      } else if (stepCount > 0) {
        detailBtn = '<button onclick="showLogTrace(event,' + i + ')" class="text-blue-500 text-[10px] hover:underline">'
          + stepCount + ' steps</button>';
      }

      return '<tr class="border-b border-gray-100 hover:bg-gray-50">' +
        '<td class="px-4 py-2 text-gray-400 whitespace-nowrap">' + fmtTime(l.startedAt) + '</td>' +
        '<td class="px-4 py-2"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px] font-medium">' + esc(l.scraper||'—') + '</span></td>' +
        '<td class="px-4 py-2"><span class="badge badge-' + esc(l.status||'processing') + '">' + esc(l.status||'—') + '</span></td>' +
        '<td class="px-4 py-2 font-medium ' + (l.companiesFound > 0 ? 'text-green-600' : 'text-gray-400') + '">' + (l.companiesFound || 0) + '</td>' +
        '<td class="px-4 py-2 text-gray-500">' + (l.contactsFound || 0) + '</td>' +
        '<td class="px-4 py-2 text-gray-400 whitespace-nowrap">' + fmtDuration(l.durationMs) + '</td>' +
        '<td class="px-4 py-2">' + detailBtn + '</td>' +
      '</tr>';
    }).join('');
  } catch(e) { /* silent */ }
}

function showLogTrace(event, idx) {
  event.stopPropagation();
  const log = _logsCache[idx];
  if (!log) return;
  document.getElementById('log-trace-popover')?.remove();

  const btn  = event.currentTarget;
  const rect = btn.getBoundingClientRect();
  const errors = log.errors || [];
  const steps  = log.agentSteps || [];

  const pop = document.createElement('div');
  pop.id = 'log-trace-popover';
  pop.style.cssText = 'position:fixed;z-index:9999;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:14px 16px;font-size:11px;font-family:ui-monospace,monospace;max-width:580px;min-width:300px;max-height:420px;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.45);line-height:1.6;';
  pop.style.top  = Math.min(rect.bottom + 6, window.innerHeight - 440) + 'px';
  pop.style.left = Math.min(rect.left, window.innerWidth - 600) + 'px';

  const scraper  = esc(log.scraper || '?');
  const duration = fmtDuration(log.durationMs);
  const saved    = log.companiesFound || 0;

  let html = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">' +
    '<div><span style="font-weight:700;color:#93c5fd;">' + scraper + '</span>' +
    '<span style="color:#64748b;margin-left:8px;">' + duration + ' · ' + saved + ' saved</span></div>' +
    '<button onclick="document.getElementById(\'log-trace-popover\').remove()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;flex-shrink:0;">✕</button>' +
    '</div>';

  // Errors section
  if (errors.length > 0) {
    html += '<div style="margin-bottom:8px;padding:6px 8px;background:#1e1b22;border-radius:6px;border-left:3px solid #f87171;">' +
      '<div style="color:#f87171;font-weight:700;margin-bottom:4px;">Errors (' + errors.length + ')</div>' +
      errors.map(function(e) {
        return '<div style="color:#fca5a5;word-break:break-all;padding:2px 0;">' + esc(String(e)) + '</div>';
      }).join('') + '</div>';
  }

  // Agent steps section
  if (steps.length > 0) {
    html += '<div style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px;">Agent Trace (' + steps.length + ' steps)</div>';
    html += steps.map(function(s) {
      const toolColor = s.tool.startsWith('scrape') ? '#fde68a' :
                        s.tool === 'save_companies'  ? '#86efac' :
                        s.tool.startsWith('get_') || s.tool.startsWith('check_') ? '#93c5fd' :
                        '#e2e8f0';
      const time = s.ts ? new Date(s.ts).toLocaleTimeString() : '';
      return '<div style="display:flex;gap:6px;align-items:baseline;padding:3px 0;border-top:1px solid #1e293b;">' +
        '<span style="color:' + toolColor + ';flex-shrink:0;min-width:160px;">' + esc(s.tool) + '</span>' +
        '<span style="color:#94a3b8;flex:1;word-break:break-all;">' + esc(s.summary) + '</span>' +
        '<span style="color:#475569;flex-shrink:0;font-size:9px;">' + time + '</span>' +
        '</div>';
    }).join('');
  }

  if (errors.length === 0 && steps.length === 0) {
    html += '<div style="color:#475569;">No details available</div>';
  }

  pop.innerHTML = html;
  document.body.appendChild(pop);

  function onOutside(ev) {
    if (!pop.contains(ev.target) && ev.target !== btn) {
      pop.remove();
      document.removeEventListener('click', onOutside, true);
    }
  }
  setTimeout(function() { document.addEventListener('click', onOutside, true); }, 0);
}

function toggleLogRefresh() {
  const on = document.getElementById('log-autorefresh').checked;
  if (logRefreshId) { clearInterval(logRefreshId); logRefreshId = null; }
  if (on) logRefreshId = setInterval(loadLogs, 10000);
}

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ══════════════════════════════════════════════════════════════════════════════

async function loadAnalytics() {
  try {
    const [statsJson, leadsJson, logsJson] = await Promise.all([
      apiFetch('/api/stats'),
      apiFetch('/api/leads?limit=250&sortBy=score&sortDir=desc'),
      apiFetch('/api/jobs/stats'),
    ]);
    const s     = statsJson.data;
    const leads = leadsJson.data || [];

    // Funnel bars
    const funnelData = [
      { label: 'Total Companies', val: s.total, color: 'bg-gray-400' },
      { label: '⏳ Pending (not yet scored)', val: s.pending, color: 'bg-purple-400' },
      { label: '🔥 Hot Verified (≥80)', val: s.hot_verified, color: 'bg-orange-500' },
      { label: '🔥 Hot (65–79)',         val: s.hot,          color: 'bg-red-400' },
      { label: '🌡 Warm (50–64)',        val: s.warm,         color: 'bg-yellow-400' },
      { label: '❄ Cold (35–49)',         val: s.cold,         color: 'bg-blue-400' },
      { label: '✗ Disqualified (<35)',   val: s.disqualified, color: 'bg-gray-300' },
    ];
    const maxVal = s.total || 1;
    document.getElementById('funnel-bars').innerHTML = funnelData.map(function(f) {
      const pct = Math.round(((f.val||0) / maxVal) * 100);
      return '<div class="flex items-center gap-3 text-xs">' +
        '<span class="w-44 text-gray-600 shrink-0">' + f.label + '</span>' +
        '<div class="prog-bar flex-1"><div class="prog-fill ' + f.color + '" style="width:' + pct + '%"></div></div>' +
        '<span class="w-10 text-right font-semibold text-gray-700">' + (f.val||0) + '</span>' +
        '<span class="w-10 text-right text-gray-400">' + pct + '%</span>' +
      '</div>';
    }).join('');

    // Tech stack frequency from leads
    const techCount = {};
    leads.forEach(function(c) {
      (c.techStack || []).forEach(function(t) { techCount[t] = (techCount[t]||0) + 1; });
    });
    const topTech = Object.entries(techCount).sort((a,b) => b[1]-a[1]).slice(0,10);
    const maxTech = topTech[0] ? topTech[0][1] : 1;
    document.getElementById('tech-bars').innerHTML = topTech.length
      ? topTech.map(function(e) {
          const pct = Math.round((e[1] / maxTech) * 100);
          return '<div class="flex items-center gap-2 text-xs">' +
            '<span class="w-24 text-gray-600 truncate shrink-0">' + esc(e[0]) + '</span>' +
            '<div class="prog-bar flex-1"><div class="prog-fill bg-indigo-400" style="width:'+pct+'%"></div></div>' +
            '<span class="w-8 text-right font-medium text-gray-600">' + e[1] + '</span>' +
          '</div>';
        }).join('')
      : '<div class="text-gray-300 text-xs py-4 text-center">No data yet</div>';

    // Scraper performance from logs
    const scrapeStats = logsJson.data;
    const scraperPerf = {};
    (leadsJson.data || []).forEach(function(c) {
      (c.sources || []).forEach(function(s) {
        scraperPerf[s] = (scraperPerf[s]||0) + 1;
      });
    });
    const topScrapers = Object.entries(scraperPerf).sort((a,b) => b[1]-a[1]).slice(0, 8);
    const maxScraper = topScrapers[0] ? topScrapers[0][1] : 1;
    document.getElementById('scraper-bars').innerHTML = topScrapers.length
      ? topScrapers.map(function(e) {
          const pct = Math.round((e[1] / maxScraper) * 100);
          return '<div class="flex items-center gap-2 text-xs">' +
            '<span class="w-24 text-gray-600 truncate shrink-0">' + esc(e[0]) + '</span>' +
            '<div class="prog-bar flex-1"><div class="prog-fill bg-teal-400" style="width:'+pct+'%"></div></div>' +
            '<span class="w-8 text-right font-medium text-gray-600">' + e[1] + '</span>' +
          '</div>';
        }).join('')
      : '<div class="text-gray-300 text-xs py-4 text-center">No data yet</div>';

    // Score histogram (0–100 in 10-point buckets)
    const buckets = new Array(10).fill(0);
    leads.forEach(function(c) {
      if (c.score != null && c.score >= 0) {
        const b = Math.min(Math.floor(c.score / 10), 9);
        buckets[b]++;
      }
    });
    const maxBucket = Math.max(...buckets, 1);
    const bucketColors = ['bg-gray-200','bg-gray-300','bg-blue-200','bg-blue-300','bg-blue-400','bg-yellow-300','bg-yellow-400','bg-orange-400','bg-red-400','bg-orange-500'];
    document.getElementById('score-hist').innerHTML = buckets.map(function(count, i) {
      const h = Math.round((count / maxBucket) * 100);
      return '<div class="flex flex-col items-center flex-1" title="Score ' + (i*10) + '–' + (i*10+9) + ': ' + count + ' companies">' +
        '<span class="text-[9px] text-gray-400 mb-0.5">' + (count||'') + '</span>' +
        '<div class="' + bucketColors[i] + ' w-full rounded-t-sm" style="height:' + h + '%"></div>' +
      '</div>';
    }).join('');

  } catch(e) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH / WARNINGS
// ══════════════════════════════════════════════════════════════════════════════

const _SLOW_THRESHOLDS   = { discovery: 5*60, enrichment: 12*60, scoring: 3*60 };
const _LOOP_THRESHOLD    = 20 * 60; // seconds — any job older than this is probably stuck

async function loadHealthWarnings() {
  // Clear credential/scraper-failure warnings before re-fetching
  _activeWarnings = _activeWarnings.filter(w => w.type === 'slow_worker' || w.type === 'agent_loop');
  try {
    const json = await apiFetch('/api/health/sources', null, 8000);
    const sources = json.data.sources || [];
    for (const src of sources) {
      // Missing credentials on opt-in sources
      if (src.needsCredential && !src.configured) {
        _activeWarnings.push({
          type: 'credential', severity: 'info', source: src.source,
          message: src.source + ' — credentials not configured, source disabled',
        });
      }
      // High failure rate (configured + enough samples)
      if (src.configured && src.recentTotal >= 5 && src.failRate >= 50) {
        _activeWarnings.push({
          type: 'scraper_failure', severity: 'error', source: src.source,
          message: src.source + ' — ' + src.failRate + '% failure rate (' + src.recentFailed + '/' + src.recentTotal + ' recent jobs)',
          detail: src.lastError,
        });
      }
    }
  } catch(e) { /* silent — health endpoint optional */ }
  renderWarningsPanel();
}

function updateWarningsFromJobs(jobs) {
  // Recompute slow/loop warnings from live active-jobs data
  _activeWarnings = _activeWarnings.filter(w => w.type !== 'slow_worker' && w.type !== 'agent_loop');
  const now = Date.now();
  for (const job of jobs) {
    if (!job.startedAt) continue;
    const ageSec = Math.round((now - new Date(job.startedAt).getTime()) / 1000);
    const label  = job.queue === 'discovery'  ? (job.source  || '?')
                 : job.queue === 'enrichment' ? (job.domain  || '?')
                 : 'company';
    if (ageSec > _LOOP_THRESHOLD) {
      _activeWarnings.push({
        type: 'agent_loop', severity: 'error', source: job.queue,
        message: job.queue + ':' + label + ' — possibly stuck / looping (' + Math.round(ageSec/60) + 'm elapsed)',
      });
    } else if (ageSec > (_SLOW_THRESHOLDS[job.queue] || 10*60)) {
      _activeWarnings.push({
        type: 'slow_worker', severity: 'warning', source: job.queue,
        message: job.queue + ':' + label + ' — slow response (' + Math.round(ageSec/60) + 'm elapsed)',
      });
    }
  }
  renderWarningsPanel();
}

function renderWarningsPanel() {
  const panel = document.getElementById('warnings-panel');
  if (!panel) return;
  const errors   = _activeWarnings.filter(w => w.severity === 'error');
  const warnings = _activeWarnings.filter(w => w.severity === 'warning');
  const infos    = _activeWarnings.filter(w => w.severity === 'info');
  const ordered  = [...errors, ...warnings, ...infos];
  if (!ordered.length) {
    panel.innerHTML = '<div class="flex items-center gap-1.5 text-green-600"><span class="w-1.5 h-1.5 rounded-full bg-green-400 inline-block shrink-0"></span>All systems healthy</div>';
    updateWarningsBadge();
    return;
  }
  const C = {
    error:   { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-700',    dot: 'bg-red-500',    label: 'ERROR'   },
    warning: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', dot: 'bg-amber-400',  label: 'SLOW'    },
    info:    { bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-500',   dot: 'bg-gray-300',   label: 'INFO'    },
  };
  panel.innerHTML = ordered.map(function(w) {
    const c = C[w.severity] || C.info;
    return '<div class="' + c.bg + ' border ' + c.border + ' rounded-lg px-3 py-2 flex items-start gap-2">' +
      '<span class="w-1.5 h-1.5 rounded-full ' + c.dot + ' mt-1 shrink-0"></span>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="' + c.text + ' text-xs font-medium">' + esc(w.message) + '</div>' +
        (w.detail ? '<div class="text-[10px] text-gray-400 mt-0.5 truncate font-mono" title="' + esc(w.detail) + '">' + esc(String(w.detail).slice(0,130)) + '</div>' : '') +
      '</div>' +
      '<span class="text-[9px] font-bold ' + c.text + ' opacity-60 shrink-0 mt-0.5">' + c.label + '</span>' +
    '</div>';
  }).join('');
  updateWarningsBadge();
}

function updateWarningsBadge() {
  const badge = document.getElementById('warnings-badge');
  if (!badge) return;
  const errors   = _activeWarnings.filter(w => w.severity === 'error').length;
  const warnings = _activeWarnings.filter(w => w.severity === 'warning').length;
  const infos    = _activeWarnings.filter(w => w.severity === 'info').length;
  if (errors > 0) {
    badge.textContent = '⚠ ' + errors + ' error' + (errors > 1 ? 's' : '');
    badge.className   = 'text-xs font-medium rounded-full px-2 py-0.5 cursor-pointer bg-red-50 text-red-600 border border-red-200';
    badge.style.display = 'inline-block';
  } else if (warnings > 0) {
    badge.textContent = '⚠ ' + warnings + ' slow worker' + (warnings > 1 ? 's' : '');
    badge.className   = 'text-xs font-medium rounded-full px-2 py-0.5 cursor-pointer bg-yellow-50 text-yellow-600 border border-yellow-200';
    badge.style.display = 'inline-block';
  } else if (infos > 0) {
    badge.textContent = infos + ' source' + (infos > 1 ? 's' : '') + ' unconfigured';
    badge.className   = 'text-xs rounded-full px-2 py-0.5 cursor-pointer bg-gray-50 text-gray-400 border border-gray-200';
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FILTER / PAGINATION CONTROLS
// ══════════════════════════════════════════════════════════════════════════════

function applyFilters() { currentPage = 1; loadCompanies(); }
function resetFilters() {
  ['f-status','f-tech','f-funding','f-source'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-minscore').value = '';
  document.getElementById('f-maxscore').value = '';
  document.getElementById('f-search').value   = '';
  document.getElementById('f-limit').value    = '50';
  activeSegment = 'all';
  sortCol = 'score'; sortDir = 'desc';
  document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active-seg'));
  document.getElementById('seg-all').classList.add('active-seg');
  document.querySelectorAll('[id^="si-"]').forEach(el => { el.textContent = '↕'; });
  document.querySelectorAll('.sort-th').forEach(el => el.classList.remove('sorted'));
  document.getElementById('si-score').textContent = '↓';
  document.querySelector('[onclick="setSort(\\'score\\')"]').classList.add('sorted');
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

function exportCSV() {
  const status  = document.getElementById('f-status').value;
  const minsc   = document.getElementById('f-minscore').value;
  const p = new URLSearchParams();
  if (activeSegment === 'qualified')    p.set('status', 'hot');
  else if (activeSegment === 'disqualified') p.set('status', 'disqualified');
  else if (status) p.set('status', status);
  if (minsc) p.set('minScore', minsc);
  window.location.href = '/api/export/csv?' + p;
}

// ══════════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════════

const _validTabs = ['leads','control','logs','analytics','queues'];
const _hashTab = location.hash.replace('#','');
if (_validTabs.includes(_hashTab)) {
  switchTab(_hashTab);
  if (_hashTab !== 'leads') loadCompanies(); // keep data warm in background
} else {
  loadCompanies();
}
loadStats();
loadSettings();
loadActiveJobs();
loadHealthWarnings();

// Sort score column by default
document.getElementById('si-score').textContent = '↓';
document.querySelector('[onclick="setSort(\\'score\\')"]').classList.add('sorted');

// Auto-refresh leads + stats every 30s
setInterval(function() {
  loadStats();
  if (document.getElementById('tab-leads').classList.contains('active')) loadCompanies();
}, 30000);

// Start log auto-refresh when logs tab is shown
logRefreshId = setInterval(function() {
  if (document.getElementById('tab-logs').classList.contains('active')) loadLogs();
}, 10000);

// Queue stats + active jobs + warnings auto-refresh (control tab only)
setInterval(function() {
  if (document.getElementById('tab-control').classList.contains('active')) {
    loadQueueStats();
    loadActiveJobs();
  }
}, 8000);

// Health warnings refresh every 30s (runs globally — badge visible on all tabs)
setInterval(loadHealthWarnings, 30000);

// Activity bar: poll active jobs every 20s (non-control tabs only)
setInterval(function() {
  if (!document.getElementById('tab-control').classList.contains('active')) {
    loadActiveJobs();
  }
}, 20000);

// Fast-refresh leads table only when pipeline has fresh active jobs (every 10s)
setInterval(function() {
  if (_freshActiveJobs && document.getElementById('tab-leads').classList.contains('active')) {
    loadCompanies();
  }
}, 10000);
</script>
</body>
</html>`;
