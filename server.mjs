// cursor-swarm: a planner splits a page into regions, then one agent per region streams JSONL edit ops.
// Every op the browser animates is a line a model wrote (or, in mock mode, a clearly labelled generator).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCatalog, paletteText, names as reuiNames } from './reui.mjs';
import { agentCall, listAgents } from './agents.mjs';

const PORT = Number(process.env.PORT ?? 8981);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, 'public');
const SESS = path.join(DIR, 'sessions');
fs.mkdirSync(SESS, { recursive: true });
const PAGE_W = 1440;

const clients = new Set();
let run = null; // { id, log: [], procs: Set, stopped, gov }

function broadcast(ev) {
  if (run && ev.t !== 'tok') {
    run.log.push(ev); if (run.log.length > 20000) run.log.shift();
    try { run.wstream?.write(JSON.stringify(ev) + '\n'); if (ev.t === 'end') { run.ended = true; run.wstream?.end(); run.wstream = null; } } catch {}
  }
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}

// ---------- director ----------
const directorSys = (palette) => `You are the design director of a swarm of UI agents. You split one web page into regions; a separate agent builds each region in parallel and cannot see the others, so your style guide and briefs are their only shared context.
You design with the ReUI design system (shadcn/React). Each region is built around ONE real ReUI component chosen from this catalog:
${palette}
Output ONE JSON object and nothing else (no prose, no code fences):
{"title":"...","style":{"bg":"#hex","surface":"#hex","text":"#hex","muted":"#hex","accent":"#hex","accent2":"#hex","font":"sans|serif|mono","radius":12},
 "rows":[{"h":120,"cols":[{"span":12,"name":"Nav bar","component":"frame","brief":"what to draw here, with concrete copy"}]}]}
Rules: the page is ${PAGE_W}px wide on a 12-column grid. Each row has a height h in px (80-520) and cols whose spans sum to exactly 12. The total number of cols across all rows must equal the requested agent count exactly. Every col MUST have a "component" that is one of the catalog names above, chosen to fit that region's purpose. Briefs are 1-2 sentences with specific content (headlines, labels, numbers), not generic instructions. Order rows top to bottom like a real page.`;

function fallbackPlan(brief, n) {
  const rows = []; let left = n;
  const first = { h: 96, cols: [{ span: 12, name: 'Nav bar', brief: `Top navigation for: ${brief}` }] };
  rows.push(first); left--;
  let k = 1;
  while (left > 0) {
    const c = Math.min(left, [1, 3, 2, 4][k % 4]);
    const span = 12 / c;
    rows.push({ h: c === 1 ? 420 : 300, cols: Array.from({ length: c }, (_, i) => ({ span, name: `Section ${k}.${i + 1}`, brief: `A section of the page for: ${brief}` })) });
    left -= c; k++;
  }
  return { title: brief.slice(0, 60), style: {}, rows };
}

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in director output');
  return JSON.parse(text.slice(a, b + 1));
}

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const col = (v, d) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : d);
const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);

function layout(plan) {
  const s = plan.style ?? {};
  const style = {
    bg: col(s.bg, '#ffffff'), surface: col(s.surface, '#f4f4f5'), text: col(s.text, '#111113'), muted: col(s.muted, '#6b7280'),
    accent: col(s.accent, '#4f46e5'), accent2: col(s.accent2, '#0ea5e9'),
    font: ['sans', 'serif', 'mono'].includes(s.font) ? s.font : 'sans', radius: num(s.radius, 0, 32, 12),
  };
  const regions = []; let y = 0;
  for (const row of Array.isArray(plan.rows) ? plan.rows : []) {
    const cols = (Array.isArray(row.cols) ? row.cols : []).filter(Boolean);
    if (!cols.length) continue;
    const h = num(row.h, 80, 520, 240);
    const total = cols.reduce((t, c) => t + num(c.span, 1, 12, 1), 0);
    let x = 0;
    cols.forEach((c, i) => {
      const w = i === cols.length - 1 ? PAGE_W - x : Math.round((num(c.span, 1, 12, 1) / total) * PAGE_W);
      regions.push({ name: String(c.name ?? `Region ${regions.length + 1}`).slice(0, 40), brief: String(c.brief ?? '').slice(0, 400), component: String(c.component ?? '').slice(0, 40), x, y, w, h });
      x += w;
    });
    y += h;
  }
  return { title: String(plan.title ?? 'Untitled').slice(0, 80), style, regions, pageH: y };
}

// ---------- workers ----------
const workerSys = (st, n) => `You are one of ${n} UI design agents building one web page at the same time. Each agent owns one rectangular region and draws only inside it. You draw by emitting edit operations; a cursor on a shared canvas performs each one as it arrives.
Output ONLY JSONL: one JSON object per line, no prose, no code fences, no blank commentary. Coordinates are px relative to YOUR region's top-left corner.
Operations:
{"op":"box","id":"b1","x":0,"y":0,"w":200,"h":80,"fill":"#hex","radius":12,"stroke":"#hex"}
{"op":"text","id":"t1","x":24,"y":20,"w":300,"text":"Real copy","size":16,"weight":400,"color":"#hex","align":"left"}
{"op":"button","id":"k1","x":24,"y":60,"w":140,"h":44,"text":"Label","fill":"#hex","color":"#hex","radius":10}
{"op":"image","id":"i1","x":0,"y":0,"w":200,"h":120,"label":"what the image shows","radius":12}
{"op":"update","id":"b1","fill":"#hex"}
{"op":"done"}
Rules: 8 to 22 operations. Draw back to front (backgrounds first). Keep every element fully inside your region with at least 16px padding from its edges unless it is a full-bleed background. Text needs a w wide enough for its content; size is font px (12-64). Write specific, believable copy, never lorem ipsum. Do not draw the page background itself unless your brief calls for a coloured band.
Shared style guide (all agents use it so the page is coherent): page background ${st.bg}, surface ${st.surface}, text ${st.text}, muted text ${st.muted}, accent ${st.accent}, second accent ${st.accent2}, corner radius ${st.radius}px.
Finish with {"op":"done"}.`;

const OPS = new Set(['box', 'text', 'button', 'image', 'update', 'done']);
function cleanOp(o, r) {
  if (!o || typeof o !== 'object' || !OPS.has(o.op)) return null;
  if (o.op === 'done') return { op: 'done' };
  const out = { op: o.op, id: String(o.id ?? '').slice(0, 24) || `e${Math.random().toString(36).slice(2, 7)}` };
  if ('x' in o) out.x = num(o.x, 0, r.w, 0);
  if ('y' in o) out.y = num(o.y, 0, r.h, 0);
  if ('w' in o) out.w = num(o.w, 1, r.w - (out.x ?? 0), 40);
  if ('h' in o) out.h = num(o.h, 1, r.h - (out.y ?? 0), 20);
  for (const k of ['fill', 'stroke', 'color']) if (k in o) { const c = col(o[k], null); if (c) out[k] = c; }
  if ('radius' in o) out.radius = num(o.radius, 0, 999, 0);
  if ('size' in o) out.size = num(o.size, 8, 96, 16);
  if ('weight' in o) out.weight = num(o.weight, 100, 900, 400);
  if ('align' in o && ['left', 'center', 'right'].includes(o.align)) out.align = o.align;
  if ('text' in o) out.text = String(o.text).slice(0, 400);
  if ('label' in o) out.label = String(o.label).slice(0, 80);
  if (o.op !== 'update' && (out.x === undefined || out.y === undefined)) return null;
  return out;
}

function mockOps(r, st, i) {
  const p = 20, ops = [];
  ops.push({ op: 'box', id: 'bg', x: 8, y: 8, w: r.w - 16, h: r.h - 16, fill: st.surface, radius: st.radius });
  ops.push({ op: 'text', id: 'h', x: p + 8, y: p + 4, w: r.w - 2 * p - 16, text: `${r.name}`, size: r.h > 300 ? 34 : 22, weight: 700, color: st.text });
  ops.push({ op: 'text', id: 's', x: p + 8, y: p + (r.h > 300 ? 56 : 40), w: r.w - 2 * p - 16, text: 'Mock data. No model wrote this line.', size: 14, color: st.muted });
  if (r.h > 200) ops.push({ op: 'image', id: 'im', x: p + 8, y: p + 90, w: Math.min(r.w - 2 * p - 16, 420), h: Math.max(40, r.h - 190), label: 'placeholder', radius: st.radius });
  if (r.h > 140) ops.push({ op: 'button', id: 'cta', x: p + 8, y: r.h - p - 48, w: 132, h: 40, text: 'Action', fill: i % 2 ? st.accent2 : st.accent, color: '#ffffff', radius: st.radius });
  ops.push({ op: 'done' });
  return ops;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWorker(me, i, plan, cfg) {
  const r = plan.regions[i];
  const send = (ev) => { if (run === me && !me.stopped) broadcast({ ...ev, a: i }); };
  if (cfg.mode === 'mock') {
    send({ t: 'agent', status: 'working' });
    for (const op of mockOps(r, plan.style, i)) { await sleep(60 + Math.random() * 140); send({ t: 'op', op }); }
    send({ t: 'agent', status: 'done', ops: 6 });
    return {};
  }
  let line = '', ops = 0, pending = '', pendingThought = '';
  const flush = setInterval(() => {
    if (pending || pendingThought) { send({ t: 'tok', d: pending, th: pendingThought }); pending = ''; pendingThought = ''; }
  }, 120);
  const feed = (s) => {
    const o = (() => { try { return JSON.parse(s); } catch { return null; } })();
    const op = cleanOp(o, r);
    if (op) { ops++; send({ t: 'op', op }); }
  };
  send({ t: 'agent', status: 'working' });
  const res = await agentCall({
    spec: cfg.model, track: me.procs,
    system: workerSys(plan.style, plan.regions.length),
    prompt: `Page: ${plan.title}\nOverall brief: ${cfg.prompt}\nYour region: "${r.name}", ${r.w}px wide by ${r.h}px tall, located at x=${r.x}, y=${r.y} of a ${PAGE_W}x${plan.pageH}px page.\nYour brief: ${r.brief}${r.component ? `\nRender the ReUI "${r.component}" component${plan.summ?.[r.component] ? ` (${plan.summ[r.component]})` : ''}. Reproduce its real ReUI appearance with the op primitives.` : ''}\nEmit your JSONL operations now.`,
    onText: (d) => {
      pending += d; line += d;
      let k;
      while ((k = line.indexOf('\n')) >= 0) { const s = line.slice(0, k).trim(); line = line.slice(k + 1); if (s.startsWith('{')) feed(s); }
    },
    onThought: (d) => { pendingThought += d; },
  });
  clearInterval(flush);
  if (line.trim().startsWith('{')) feed(line.trim());
  if (pending || pendingThought) send({ t: 'tok', d: pending, th: pendingThought });
  return { ...res, ops };
}

// ---------- governor: caps concurrency and launch rate, backs off on rate-limit errors ----------
async function governor(me, plan, cfg) {
  const gov = me.gov = { active: 0, launched: 0, done: 0, failed: 0, retries: 0, tokIn: 0, tokOut: 0, cost: 0, backoffUntil: 0, concurrency: cfg.concurrency, rpm: cfg.rpm };
  const queue = plan.regions.map((_, i) => ({ i, tries: 0 }));
  const gap = 60000 / cfg.rpm;
  let last = 0;
  const report = () => { if (run === me) broadcast({ t: 'gov', ...gov, queued: queue.length }); };
  await new Promise((resolve) => {
    const tick = () => {
      if (me.stopped) return resolve();
      if (!queue.length && !gov.active) return resolve();
      const now = Date.now();
      while (queue.length && gov.active < cfg.concurrency && now - last >= gap && now >= gov.backoffUntil) {
        const job = queue.shift(); last = Date.now(); gov.active++; gov.launched++;
        runWorker(me, job.i, plan, cfg).then((res) => {
          gov.active--;
          if (res.usage) { gov.tokIn += res.usage.in; gov.tokOut += res.usage.out; gov.cost += res.usage.cost; }
          const limited = res.error && /429|rate.?limit|too many|quota/i.test(res.error);
          // Payment and auth errors will not fix themselves: stop the whole run instead of burning retries.
          if (res.error && !res.ops && !me.stopped && /\b(401|402|403)\b|insufficient|balance|api.?key|unauthori|usage.?limit/i.test(res.error)) {
            gov.failed++; me.stopped = true; queue.length = 0;
            for (const p of me.procs) p.kill();
            if (run === me) {
              broadcast({ t: 'agent', a: job.i, status: 'failed', error: res.error });
              broadcast({ t: 'error', text: `${cfg.model} refused the request (${res.error}). Check the provider's credits or key, or pick another worker model.` });
            }
          } else if (res.error && !me.stopped && job.tries < 2 && (limited || !res.ops)) {
            job.tries++; gov.retries++; queue.push(job);
            if (limited) gov.backoffUntil = Date.now() + 4000 * 2 ** job.tries;
            if (run === me) broadcast({ t: 'agent', a: job.i, status: 'waiting', error: res.error });
          } else if (res.error && !res.ops) {
            gov.failed++;
            if (run === me) broadcast({ t: 'agent', a: job.i, status: 'failed', error: res.error });
          } else {
            gov.done++;
            if (run === me) broadcast({ t: 'agent', a: job.i, status: 'done', ops: res.ops, usage: res.usage, error: res.error });
          }
          report();
        });
        report();
        if (gap > 0) break;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
  report();
}

async function startRun(cfg) {
  stopRun();
  const me = run = { id: Date.now(), log: [], procs: new Set(), stopped: false, gov: null };
  try {
    me.wstream = fs.createWriteStream(path.join(SESS, `${me.id}.jsonl`), { flags: 'a' });
    me.wstream.write(JSON.stringify({ t: 'meta', id: me.id, cfg: { ...cfg }, started: new Date().toISOString() }) + '\n');
  } catch {}
  broadcast({ t: 'run', id: me.id, cfg: { ...cfg }, pageW: PAGE_W });
  let plan;
  if (cfg.mode === 'mock') {
    plan = layout(fallbackPlan(cfg.prompt, cfg.agents));
    broadcast({ t: 'director', status: 'done', note: 'mock layout, no model' });
  } else {
    const cat = await getCatalog();
    if (me.stopped || run !== me) return;
    broadcast({ t: 'reui', source: cat.source, count: cat.components.length });
    const sys = directorSys(paletteText(cat.components));
    const valid = reuiNames(cat.components);
    const summ = Object.fromEntries(cat.components.map((c) => [c.name, c.summary]));
    broadcast({ t: 'director', status: 'working', model: cfg.director });
    let pend = '';
    const fl = setInterval(() => { if (pend && run === me) { broadcast({ t: 'tok', a: -1, d: pend }); pend = ''; } }, 120);
    const ask = (model) => agentCall({ spec: model, track: me.procs, system: sys, prompt: `Agent count: ${cfg.agents}\nPage to design: ${cfg.prompt}`, onText: (d) => { pend += d; } });
    let res = await ask(cfg.director), note = '';
    if (me.stopped) { clearInterval(fl); return; }
    let parsed = null;
    const tryParse = (r) => { try { const p = layout(extractJson(r.text)); return p.regions.length ? p : null; } catch { return null; } };
    parsed = res.error ? null : tryParse(res);
    if (!parsed && cfg.director !== cfg.model) {
      note = `director ${cfg.director} failed (${res.error ?? 'unparseable plan'}); retried with ${cfg.model}`;
      broadcast({ t: 'director', status: 'working', model: cfg.model, note });
      res = await ask(cfg.model);
      if (me.stopped) { clearInterval(fl); return; }
      parsed = res.error ? null : tryParse(res);
    }
    clearInterval(fl);
    if (!parsed) {
      note = `director failed (${res.error ?? 'unparseable plan'}); using a generic grid`;
      parsed = layout(fallbackPlan(cfg.prompt, cfg.agents));
    }
    plan = parsed;
    for (const r of plan.regions) if (r.component && !valid.has(r.component)) r.component = '';
    plan.summ = summ;
    broadcast({ t: 'director', status: 'done', note, usage: res.usage });
  }
  if (me.stopped || run !== me) return;
  broadcast({ t: 'plan', title: plan.title, style: plan.style, regions: plan.regions, pageH: plan.pageH });
  await governor(me, plan, cfg);
  if (run === me && !me.ended) broadcast({ t: 'end', stopped: me.stopped, ms: Date.now() - me.id });
}

function stopRun() {
  if (!run) return;
  run.stopped = true;
  for (const p of run.procs) p.kill();
  run.procs.clear();
  try { run.wstream?.end(); run.wstream = null; } catch {}
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const local = (req) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const origin = req.headers.origin;
  const ok = (h) => h === 'localhost' || h === '127.0.0.1';
  return ok(host) && (!origin || ok(new URL(origin).hostname));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!local(req)) { res.writeHead(403).end('localhost only'); return; } // it can start agents
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    // A page that connects mid-run catches up; finished runs are reached through /sessions instead.
    if (run && !run.ended) for (const ev of run.log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/agents') {
    listAgents().then((a) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(a)));
    return;
  }
  if (url.pathname === '/sessions') {
    let list = [];
    try {
      list = fs.readdirSync(SESS).filter((f) => f.endsWith('.jsonl')).map((f) => {
        const full = path.join(SESS, f);
        let meta = {}, title = '', regions = 0, ops = 0, ended = false;
        try {
          for (const ln of fs.readFileSync(full, 'utf8').split('\n')) {
            if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
            if (e.t === 'meta') meta = e;
            else if (e.t === 'plan') { title = e.title; regions = e.regions?.length ?? 0; }
            else if (e.t === 'op') ops++;
            else if (e.t === 'end') ended = true;
          }
        } catch {}
        return { id: meta.id ?? f.replace('.jsonl', ''), title, regions, ops, ended, cfg: meta.cfg ?? {}, mtime: fs.statSync(full).mtimeMs };
      }).filter((s) => s.ops > 0).sort((a, b) => b.mtime - a.mtime);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
    return;
  }
  if (url.pathname === '/session') {
    const id = (url.searchParams.get('id') ?? '').replace(/[^0-9]/g, '');
    const full = path.join(SESS, `${id}.jsonl`);
    if (!id || !full.startsWith(SESS) || !fs.existsSync(full)) { res.writeHead(404, { 'Content-Type': 'application/json' }).end('[]'); return; }
    const evs = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(evs));
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/run' || url.pathname === '/stop')) {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      if (url.pathname === '/stop') { if (run && !run.ended) broadcast({ t: 'end', stopped: true, ms: Date.now() - run.id }); stopRun(); res.writeHead(200).end('{}'); return; }
      let b; try { b = JSON.parse(body || '{}'); } catch { res.writeHead(400).end('bad json'); return; }
      const cfg = {
        prompt: String(b.prompt ?? '').slice(0, 2000) || 'A landing page for a note-taking app',
        agents: num(b.agents, 1, 48, 12),
        model: String(b.model ?? 'cerebras/qwen-3.8-27b').slice(0, 160),
        director: String(b.director || b.model || 'cerebras/qwen-3.8-27b').slice(0, 160),
        mode: b.mode === 'mock' ? 'mock' : 'pi',
        concurrency: num(b.concurrency, 1, 48, 10),
        rpm: num(b.rpm, 1, 2000, 120),
      };
      startRun(cfg).catch((e) => broadcast({ t: 'error', text: String(e?.message ?? e) }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    return;
  }
  const file = path.join(ROOT, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopRun(); process.exit(0); });
server.listen(PORT, '127.0.0.1', () => console.log(`cursor-swarm on http://127.0.0.1:${PORT}`));
