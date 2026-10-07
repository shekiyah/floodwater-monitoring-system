/* chart-download.js
 * Adds "Download Image" buttons to:
 *   1) Water-Level History chart  (canvas #waterChart, table water_readings)
 *   2) Upload Speed & Ping chart  (canvas #telemetrySpeedChart, table system_status)
 * Pick an interval, data is fetched from Supabase for that exact interval,
 * drawn on a white off-screen chart and saved as PNG.
 *
 * Load it AFTER supabase-config.js, script.js and telemetry.js on the page(s) with the charts:
 *   <script src="chart-download.js"></script>
 * Uses: supabaseClient, parseSupabaseTimestamp (supabase-config.js), Chart.js.
 */
(() => {
  const MAX_ROWS = 300000;   // safety cap per download
  const MAX_POINTS = 2000;   // points drawn in the image (min/max kept so spikes stay)

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
      presets: [['1', 'Last 1 hour'], ['6', 'Last 6 hours'], ['24', 'Last 24 hours'],
                ['168', 'Last 7 days'], ['720', 'Last 30 days']],
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
      presets: [['1', 'Last 1 hour'], ['6', 'Last 6 hours'], ['24', 'Last 24 hours'],
                ['48', 'Last 48 hours'], ['168', 'Last 7 days'], ['720', 'Last 30 days']],
      theme: 'cd-purple'
    }
  ];

  const pad = n => String(n).padStart(2, '0');
  const toLocalInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
      .cd-back{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9999}
      .cd-back.open{display:flex}
      .cd-box{background:#0b1f2c;color:#dbeaf3;border:1px solid #1f4a63;border-radius:12px;padding:20px;width:min(380px,92vw)}
      .cd-box h3{margin:0 0 14px;font-size:16px}
      .cd-box label{display:block;font-size:12px;margin:10px 0 4px;opacity:.8}
      .cd-box select,.cd-box input{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #1f4a63;background:#0f2a3a;color:#fff;font:inherit}
      .cd-row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
      .cd-msg{font-size:12px;margin-top:10px;min-height:16px;color:#8fd3f4}
      .cd-purple .cd-box{background:#12122b;border-color:#3a3a6e}
      .cd-purple .cd-btn{background:#1b1b3a;border-color:#3a3a6e;color:#d9d3ff}
      .cd-purple select,.cd-purple input{background:#1b1b3a;border-color:#3a3a6e}
      .cd-purple .cd-msg{color:#b9a7ff}
    `;
    document.head.appendChild(s);
  }

  // ---------- data ----------
  async function fetchRows(cfg, from, to, onProgress) {
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
      onProgress(out.length);
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

  // ---------- modal ----------
  function buildModal(cfg) {
    const back = document.createElement('div');
    back.className = `cd-back ${cfg.theme}`;
    back.innerHTML = `
      <div class="cd-box">
        <h3>Download "${cfg.title}" as image</h3>
        <label>Interval</label>
        <select class="cd-preset">
          ${cfg.presets.map(p => `<option value="${p[0]}">${p[1]}</option>`).join('')}
          <option value="custom">Custom range…</option>
        </select>
        <div class="cd-custom" style="display:none">
          <label>From</label><input type="datetime-local" class="cd-from">
          <label>To</label><input type="datetime-local" class="cd-to">
        </div>
        <div class="cd-msg"></div>
        <div class="cd-row">
          <button type="button" class="cd-btn cd-cancel">Cancel</button>
          <button type="button" class="cd-btn cd-go">Download PNG</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const q = s => back.querySelector(s);
    const now = new Date();
    q('.cd-to').value = toLocalInput(now);
    q('.cd-from').value = toLocalInput(new Date(now - 24 * 3600e3));
    q('.cd-preset').onchange = e => { q('.cd-custom').style.display = e.target.value === 'custom' ? 'block' : 'none'; };
    q('.cd-cancel').onclick = () => back.classList.remove('open');
    back.onclick = e => { if (e.target === back) back.classList.remove('open'); };
    q('.cd-go').onclick = async () => {
      const msg = q('.cd-msg'), btn = q('.cd-go');
      try {
        let from, to;
        const v = q('.cd-preset').value;
        if (v === 'custom') {
          from = new Date(q('.cd-from').value); to = new Date(q('.cd-to').value);
          if (isNaN(from) || isNaN(to) || from >= to) throw new Error('Choose a valid From and To (From must be earlier).');
        } else { to = new Date(); from = new Date(to - Number(v) * 3600e3); }
        btn.disabled = true; msg.textContent = 'Fetching readings…';
        const rows = await fetchRows(cfg, from, to, n => { msg.textContent = `Fetching readings… ${n.toLocaleString()}`; });
        if (!rows.length) throw new Error('No readings in that interval.');
        msg.textContent = 'Drawing image…';
        await renderAndDownload(cfg, rows, from, to);
        msg.textContent = `Done — ${rows.length.toLocaleString()} readings.`;
        setTimeout(() => back.classList.remove('open'), 900);
      } catch (err) { msg.textContent = err.message || String(err); }
      finally { btn.disabled = false; }
    };
    return back;
  }

  // ---------- mount ----------
  function mountOne(cfg) {
    const canvas = document.getElementById(cfg.canvasId);
    if (!canvas || canvas.dataset.cdMounted) return;
    canvas.dataset.cdMounted = '1';
    const modal = buildModal(cfg);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cd-btn cd-open';
    btn.textContent = '⬇ Download Image';
    btn.onclick = () => modal.classList.add('open');
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