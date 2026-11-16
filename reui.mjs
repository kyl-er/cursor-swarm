// Director-only ReUI: one stateless MCP call per run fetches the real component catalog.
// Credentials are read from the user's MCP config at runtime, never stored in this repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = [path.join(os.homedir(), '.config/mcp/mcp.json'), path.join(os.homedir(), '.pi/agent/mcp.json')];
const CACHE = path.join(path.dirname(new URL(import.meta.url).pathname), 'reui-catalog.json');

// Minimal fallback so the app still designs with real component names if the MCP is unreachable.
const FALLBACK = [
  ['alert', 'Callout for success, warning or error'], ['badge', 'Status / label chip'],
  ['data-grid', 'Sortable, filterable table'], ['kanban', 'Drag-and-drop column board'],
  ['stepper', 'Step-by-step progress'], ['timeline', 'Chronological events'],
  ['rating', 'Star rating'], ['frame', 'Structured content frame'],
  ['icon-tile', 'Icon in a square surface for feature rows'], ['tree', 'Nested tree'],
  ['autocomplete', 'Typeahead input'], ['date-selector', 'Date picker'],
].map(([name, summary]) => ({ name, title: name, summary }));

function readReuiServer() {
  for (const f of CFG) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const r = (d.mcpServers ?? d)?.reui;
      if (r?.url) return r;
    } catch {}
  }
  return null;
}

function parseSse(text) {
  // One JSON-RPC result arrives as `data: {...}` SSE line(s).
  for (const line of text.split('\n')) {
    const s = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!s) continue;
    try {
      const msg = JSON.parse(s);
      const inner = msg?.result?.content?.[0]?.text;
      if (inner) return JSON.parse(inner);
    } catch {}
  }
  return null;
}

let memo = null;
export async function getCatalog() {
  if (memo) return memo;
  const srv = readReuiServer();
  if (srv?.url) {
    try {
      const res = await fetch(srv.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(srv.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_components', arguments: {} } }),
        signal: AbortSignal.timeout(20000),
      });
      const data = parseSse(await res.text());
      const comps = (data?.components ?? []).map((c) => ({ name: c.name, title: c.title ?? c.name, summary: c.summary ?? '' }));
      if (comps.length) {
        memo = { components: comps, source: 'mcp.reui.io' };
        try { fs.writeFileSync(CACHE, JSON.stringify(memo)); } catch {}
        return memo;
      }
    } catch (e) { /* fall through to cache / fallback */ }
  }
  try { memo = { ...JSON.parse(fs.readFileSync(CACHE, 'utf8')), source: 'cache' }; return memo; } catch {}
  memo = { components: FALLBACK, source: 'fallback' };
  return memo;
}

export const paletteText = (comps) => comps.map((c) => `- ${c.name}: ${c.summary}`).join('\n');
export const names = (comps) => new Set(comps.map((c) => c.name));
