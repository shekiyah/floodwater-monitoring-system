/* chart-download.js
 * One-click "Download Image" buttons for:
 *   1) Water-Level History chart  (canvas #waterChart, table water_readings)
 *      -> interval = the dashboard's Custom start/end dates
 *         (#chartCustomStart / #chartCustomEnd). If they are empty, last 24 hours.
 *   2) Upload Speed & Ping chart  (canvas #telemetrySpeedChart, table system_status)
 *      -> interval = last 48 hours (same as the chart on screen).
 * Clicking the button fetches that interval from Supabase, draws a white
 * off-screen chart and downloads the PNG immediately. No popup.
 *
 * Load it AFTER supabase-config.js, script.js and telemetry.js:
 *   <script src="chart-download.js"></script>
 * Uses: supabaseClient, parseSupabaseTimestamp (supabase-config.js), Chart.js.
 */
(() => {
  const MAX_ROWS = 300000;   // safety cap per download
  const MAX_POINTS = 2000;   // points drawn in the image (min/max kept so spikes stay)

  // Reads the dashboard's custom date inputs. Dates are local calendar dates and the
  // end date is fully included (same rule as history.js). Falls back to last 24 hours.
  function dashboardInterval() {
    const s = document.getElementById('chartCustomStart');
    const e = document.getElementById('chartCustomEnd');
    const now = new Date();
    if (s && e && s.value && e.value) {
      const [sy, sm, sd] = s.value.split('-').map(Number);
      const [ey, em, ed] = e.value.split('-').map(Number);
      const from = new Date(sy, sm - 1, sd);
      let to = new Date(ey, em - 1, ed + 1);
      if (to > now) to = now;                 // don't show a future end time
      if (from >= to) throw new Error('Start date must be on or before end date.');
      return { from, to };
    }
    return { from: new Date(now - 24 * 3600e3), to: now };
  }

  const CHARTS = [
    {
      canvasId: 'waterChart',
      title: 'Water-Level History',
      file: 'water-level',
      table: 'water_readings',
      timeCol: 'created_at',
      series: [{ col: 'water_level', label: 'Water level (m)', color: '#0b7bb5', axis: 'y', fill: true }],
      axes: { y: { text: 'Meters', position: 'left', min: 0,
                   max: () => (typeof CHART_Y_MAX !== 'undefined' ? CHART_Y_MAX : 8) } },
      interval: dashboardInterval,
      stats: { col: 'water_level', unit: 'm' },
      theme: 'cd-blue'
    },
    {
      canvasId: 'telemetrySpeedChart',
      title: 'Upload Speed & Ping',
      file: 'upload-speed-ping',
      table: 'system_status',
      timeCol: 'updated_at',
      series: [
        { col: 'upload_kbps', label: 'Upload (Mbps)', color: '#7c4dff', axis: 'y', fill: true, map: v => v / 1000 },
        { col: 'ping_ms', label: 'Ping (ms)', color: '#0b9fc4', axis: 'y1' }
      ],
      axes: { y: { text: 'Mbps', position: 'left' }, y1: { text: 'ms', position: 'right' } },
      interval: () => { const to = new Date(); return { from: new Date(to - 48 * 3600e3), to }; },
      theme: 'cd-purple'
    }
  ];

  const pad = n => String(n).padStart(2, '0');
  const fmt = d => d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const stampName = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const hasVal = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const parseTs = v => (typeof parseSupabaseTimestamp === 'function' ? parseSupabaseTimestamp(v) : new Date(v));

  // ---------- styles ----------
  function injectStyles() {
    if (document.getElementById('cdStyles')) return;
    const s = document.createElement('style');
    s.id = 'cdStyles';
    s.textContent = `
      .cd-btn{background:#0f2a3a;color:#cfe8f5;border:1px solid #1f4a63;border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit;font-weight:600}
      .cd-btn:hover{filter:brightness(1.25)}
      .cd-btn:disabled{opacity:.6;cursor:wait}
      .cd-open{display:block;margin:10px auto}
      .cd-btn.cd-purple{background:#1b1b3a;border-color:#3a3a6e;color:#d9d3ff}
    `;
    document.head.appendChild(s);
  }

  // ---------- data ----------
  async function fetchRows(cfg, from, to) {
    if (typeof supabaseClient === 'undefined') throw new Error('supabaseClient not found (load supabase-config.js first).');
    const cols = [cfg.timeCol, ...cfg.series.map(s => s.col)].join(',');
    const out = [], PAGE = 1000;
    for (let start = 0; start < MAX_ROWS; start += PAGE) {
      const { data, error } = await supabaseClient
        .from(cfg.table).select(cols)
        .gte(cfg.timeCol, from.toISOString())
        .lte(cfg.timeCol, to.toISOString())
        .order(cfg.timeCol, { ascending: true })
        .range(start, start + PAGE - 1);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out.map(r => ({
      t: parseTs(r[cfg.timeCol]),
      v: cfg.series.map(s => hasVal(r[s.col]) ? (s.map ? s.map(Number(r[s.col])) : Number(r[s.col])) : null)
    }));
  }

  // keep first, min and max (of first series) of each bucket so spikes aren't lost
  function decimate(rows) {
    if (rows.length <= MAX_POINTS) return rows;
    const size = Math.ceil(rows.length / (MAX_POINTS / 3)), keep = new Set();
    for (let i = 0; i < rows.length; i += size) {
      const end = Math.min(i + size, rows.length);
      let lo = -1, hi = -1;
      for (let j = i; j < end; j++) {
        const v = rows[j].v[0]; if (v === null) continue;
        if (lo < 0 || v < rows[lo].v[0]) lo = j;
        if (hi < 0 || v > rows[hi].v[0]) hi = j;
      }
      keep.add(i); if (lo >= 0) { keep.add(lo); keep.add(hi); }
    }
    return [...keep].sort((a, b) => a - b).map(i => rows[i]);
  }

  // ---------- render + download ----------
  async function renderAndDownload(cfg, rows, from, to) {
    const pts = decimate(rows);
    const spanH = (to - from) / 3600e3;
    const lab = t => {
      const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return spanH <= 12 ? time : `${t.getMonth() + 1}/${t.getDate()} ${time}`;
    };

    let statsText = '';
    if (cfg.stats) {
      const vals = rows.map(r => r.v[0]).filter(v => v !== null);
      if (vals.length) {
        const mn = Math.min(...vals), mx = Math.max(...vals), av = vals.reduce((a, b) => a + b, 0) / vals.length;
        statsText = `   |   Min ${mn.toFixed(2)} ${cfg.stats.unit}   Max ${mx.toFixed(2)} ${cfg.stats.unit}   Avg ${av.toFixed(2)} ${cfg.stats.unit}`;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1200; canvas.height = 600;

    const scales = { x: { ticks: { color: '#333', maxTicksLimit: 10, maxRotation: 0 }, grid: { color: '#e5e5e5' } } };
    Object.entries(cfg.axes).forEach(([id, a], n) => {
      scales[id] = {
        position: a.position, beginAtZero: true,
        min: a.min, max: typeof a.max === 'function' ? a.max() : a.max,
        title: { display: true, text: a.text, color: '#333' },
        ticks: { color: '#333' },
        grid: { color: '#e5e5e5', drawOnChartArea: n === 0 }
      };
    });

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: pts.map(p => lab(p.t)),
        datasets: cfg.series.map((s, i) => ({
          label: s.label, yAxisID: s.axis, data: pts.map(p => p.v[i]),
          borderColor: s.color, backgroundColor: s.color + '26',
          borderWidth: 1.5, pointRadius: pts.length < 60 ? 2 : 0,
          fill: !!s.fill, tension: 0, spanGaps: true
        }))
      },
      options: {
        responsive: false, animation: false, devicePixelRatio: 2,
        plugins: {
          legend: { display: cfg.series.length > 1, labels: { color: '#222' } },
          title: { display: true, text: cfg.title, color: '#111', font: { size: 20, weight: 'bold' } },
          subtitle: {
            display: true, color: '#444', font: { size: 12 }, padding: { bottom: 10 },
            text: `${fmt(from)}  →  ${fmt(to)}   |   ${rows.length.toLocaleString()} readings${statsText}`
          }
        },
        scales
      },
      plugins: [{
        id: 'whiteBg',
        beforeDraw(c) { const x = c.ctx; x.save(); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.restore(); }
      }]
    });

    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    chart.destroy();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cfg.file}_${stampName(from)}_to_${stampName(to)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- one-click download ----------
  async function runDownload(cfg, btn) {
    const label = btn.textContent;
    const flash = (text, ms) => { btn.textContent = text; setTimeout(() => { btn.textContent = label; }, ms); };
    btn.disabled = true;
    try {
      const { from, to } = cfg.interval();
      btn.textContent = 'Preparing image…';
      const rows = await fetchRows(cfg, from, to);
      if (!rows.length) { btn.disabled = false; flash('No readings in that interval', 3000); return; }
      await renderAndDownload(cfg, rows, from, to);
      btn.disabled = false; flash('✔ Downloaded', 1500);
    } catch (err) {
      console.error('chart-download:', err);
      btn.disabled = false; flash(err.message || 'Download failed', 3500);
    }
  }

  // ---------- mount ----------
  function mountOne(cfg) {
    const canvas = document.getElementById(cfg.canvasId);
    if (!canvas || canvas.dataset.cdMounted) return;
    canvas.dataset.cdMounted = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cd-btn cd-open ${cfg.theme === 'cd-purple' ? 'cd-purple' : ''}`;
    btn.textContent = '⬇ Download Image';
    btn.onclick = () => runDownload(cfg, btn);
    // chart canvas usually sits inside a sized wrapper; put the button above that wrapper
    const holder = canvas.parentElement;
    holder.parentElement.insertBefore(btn, holder);
  }

  function mount() {
    if (typeof Chart === 'undefined') { console.warn('chart-download: Chart.js not loaded'); return; }
    injectStyles();
    CHARTS.forEach(mountOne);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();