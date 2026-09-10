'use strict';

/*
 * The on-device bench panel, injected by bench/serve.js after the probe. A
 * floating button runs window.__FMPerf.runAll with fixtures fetched from the
 * same server, shows progress and the result, and uploads it. Plain DOM, no
 * dependencies, sized for a gloved finger.
 */
(function () {
  const css = `
#fm-bench{position:fixed;right:12px;bottom:12px;z-index:99999;font:14px/1.4 -apple-system,system-ui,sans-serif;color:#111}
#fm-bench button{min-height:48px;min-width:48px;padding:0 18px;border:0;border-radius:10px;background:#2f6fed;color:#fff;font-weight:600;font-size:16px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
#fm-bench button[disabled]{opacity:.55}
#fm-bench .panel{display:none;position:fixed;left:12px;right:12px;bottom:72px;max-height:70vh;overflow:auto;background:#fff;border-radius:12px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.3)}
#fm-bench .panel.open{display:block}
#fm-bench .row{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
#fm-bench input{min-height:44px;font-size:16px;padding:0 10px;border:1px solid #bbb;border-radius:8px;flex:1}
#fm-bench pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f4f4f6;padding:10px;border-radius:8px;max-height:36vh;overflow:auto}
#fm-bench .log{color:#444;font-size:13px;min-height:20px}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'fm-bench';
  root.innerHTML = `
    <div class="panel">
      <div class="row"><input id="fm-bench-label" placeholder="device label, e.g. ipad-pro-11-2024" /></div>
      <div class="row">
        <button id="fm-bench-run">Run bench</button>
        <button id="fm-bench-upload" disabled>Upload</button>
        <button id="fm-bench-copy" disabled>Copy JSON</button>
      </div>
      <div class="log" id="fm-bench-log">Idle. Keep the tablet awake and do not touch the page while it runs (about a minute).</div>
      <pre id="fm-bench-out"></pre>
    </div>
    <button id="fm-bench-toggle" aria-label="Bench">Bench</button>`;
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const panel = root.querySelector('.panel');
  const logEl = $('fm-bench-log'), out = $('fm-bench-out');
  const guess = () => {
    const ua = navigator.userAgent;
    if (/iPad|Macintosh.*Mobile/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ipad';
    if (/Android/.test(ua)) return 'android-tablet';
    return 'device';
  };
  $('fm-bench-label').value = guess();
  let result = null;

  $('fm-bench-toggle').addEventListener('click', () => panel.classList.toggle('open'));
  $('fm-bench-run').addEventListener('click', async () => {
    $('fm-bench-run').disabled = true; $('fm-bench-upload').disabled = true; $('fm-bench-copy').disabled = true;
    out.textContent = ''; result = null;
    const load = async (name) => {
      logEl.textContent = 'fetching ' + name;
      const r = await fetch('/fixtures/' + name);
      if (!r.ok) throw new Error('fixture ' + name + ' → ' + r.status);
      return r.arrayBuffer();
    };
    try {
      panel.classList.remove('open'); // the viewer needs the screen while it measures
      result = await window.__FMPerf.runAll(load, (m) => { logEl.textContent = m; });
      result.label = $('fm-bench-label').value || guess();
      const S = App.PerfStats;
      out.textContent = S.reportRows(result).map((r) => r[0] + ': ' + r[1] + ' ' + r[2]).join('\n') +
        '\n\n' + JSON.stringify(result);
      logEl.textContent = 'done — tap Upload (needs the serve.js terminal) or Copy JSON.';
      $('fm-bench-upload').disabled = false; $('fm-bench-copy').disabled = false;
    } catch (e) {
      logEl.textContent = 'failed: ' + (e && e.message);
    } finally {
      panel.classList.add('open');
      $('fm-bench-run').disabled = false;
    }
  });
  $('fm-bench-upload').addEventListener('click', async () => {
    if (!result) return;
    result.label = $('fm-bench-label').value || result.label;
    try {
      const r = await fetch('/bench/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
      const j = await r.json();
      logEl.textContent = j.ok ? 'uploaded → ' + j.file : 'upload failed: ' + j.error;
    } catch (e) { logEl.textContent = 'upload failed: ' + e.message; }
  });
  $('fm-bench-copy').addEventListener('click', async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(JSON.stringify(result)); logEl.textContent = 'JSON copied.'; }
    catch (_) { logEl.textContent = 'Clipboard blocked — select the text above and copy it.'; }
  });
})();
