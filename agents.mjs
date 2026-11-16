// Agent adapters. A model spec is "agent:model" (e.g. "claude:haiku", "opencode:provider/model");
// a bare "provider/model" means pi. Every adapter runs ONE tool-less turn and streams text back.
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';

const PI = process.env.PI_BIN ?? 'pi';
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const OPENCODE = process.env.OPENCODE_BIN ?? 'opencode';
const PI_FLAGS = ['--mode', 'rpc', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-session'];
const IDS = ['pi', 'claude', 'opencode'];

export function parseSpec(spec) {
  const s = String(spec ?? '').trim();
  const m = /^([a-z]+):(.*)$/.exec(s);
  return m && IDS.includes(m[1]) ? { agent: m[1], model: m[2].trim() } : { agent: 'pi', model: s };
}

// Spawn a CLI, hand each stdout line to onLine, resolve when it exits or done() is called.
function runLines(cmd, args, { cwd, track, onLine, stdin }) {
  return new Promise((resolve) => {
    let buf = '', stderr = '', settled = false;
    const proc = spawn(cmd, args, { cwd, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    track?.add(proc);
    const finish = (error) => { if (settled) return; settled = true; track?.delete(proc); proc.kill(); resolve(error ?? null); };
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-600); });
    proc.on('error', (e) => finish(`could not start ${cmd}: ${e.message}`));
    proc.on('exit', (code) => finish(code ? `${cmd} exited (${code}) ${stderr.trim().split('\n').pop() ?? ''}` : null));
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        onLine(m, finish, proc);
      }
    });
    if (stdin !== undefined) proc.stdin.write(stdin);
  });
}

// pi: `pi --mode rpc`, LF-delimited JSON both ways.
async function piCall({ model, system, prompt, onText, onThought, track }) {
  const args = [...PI_FLAGS, '--system-prompt', system];
  const slash = model.indexOf('/');
  if (slash > 0) args.push('--provider', model.slice(0, slash), '--model', model.slice(slash + 1));
  else if (model) args.push('--model', model);
  let text = '', usage = null, error = null;
  const exit = await runLines(PI, args, {
    track, stdin: JSON.stringify({ id: 'p1', type: 'prompt', message: prompt }) + '\n',
    onLine: (m, finish, proc) => {
      if (m.type === 'response' && m.success === false) { error = `${m.command}: ${m.error ?? 'failed'}`; finish(); }
      else if (m.type === 'message_update') {
        const e = m.assistantMessageEvent ?? {};
        if (e.type === 'text_delta') { text += e.delta; onText?.(e.delta); }
        else if (e.type === 'thinking_delta') onThought?.(e.delta);
      } else if (m.type === 'message_end' && m.message?.role === 'assistant') {
        const u = m.message.usage;
        if (u) usage = { in: (u.input ?? 0) + (u.cacheRead ?? 0), out: u.output ?? 0, cost: u.cost?.total ?? 0 };
        if (m.message.stopReason === 'error') error = m.message.errorMessage ?? 'model error';
      } else if (m.type === 'agent_end') finish();
      else if (m.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(m.method)) {
        proc.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: m.id, cancelled: true }) + '\n');
      }
    },
  });
  return { text, usage, error: error ?? (text ? null : exit) };
}

// Claude Code headless: own system prompt, no tools, no MCP, no settings files, so each agent stays small.
async function claudeCall({ model, system, prompt, onText, onThought, track }) {
  const args = ['-p', prompt, '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (model) args.push('--model', model);
  let text = '', usage = null, error = null;
  const exit = await runLines(CLAUDE, args, {
    track, cwd: os.tmpdir(),
    onLine: (m) => {
      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
        const d = m.event.delta ?? {};
        if (d.type === 'text_delta') { text += d.text; onText?.(d.text); }
        else if (d.type === 'thinking_delta') onThought?.(d.thinking ?? '');
      } else if (m.type === 'result') {
        const u = m.usage ?? {};
        usage = { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0, cost: m.total_cost_usd ?? 0 };
        if (m.is_error) error = String(m.result ?? m.subtype ?? 'claude error').slice(0, 300);
      }
    },
  });
  return { text, usage, error: error ?? (text ? null : exit) };
}

// opencode: one-shot `opencode run`. It has no system-prompt flag, so the instructions lead the prompt,
// and it sends its own full agent context with every call (see the note in listAgents).
async function opencodeCall({ model, system, prompt, onText, track }) {
  const args = ['run', '--format', 'json'];
  if (model) args.push('-m', model);
  args.push(`${system}\n\n---\n\n${prompt}`);
  let text = '', usage = null, error = null;
  const exit = await runLines(OPENCODE, args, {
    track, cwd: os.tmpdir(),
    onLine: (m) => {
      if (m.type === 'text' && m.part?.text) { text += m.part.text + '\n'; onText?.(m.part.text + '\n'); }
      else if (m.type === 'step_finish') {
        const t = m.part?.tokens ?? {};
        usage = { in: (usage?.in ?? 0) + (t.input ?? 0) + (t.cache?.read ?? 0), out: (usage?.out ?? 0) + (t.output ?? 0), cost: (usage?.cost ?? 0) + (m.part?.cost ?? 0) };
      } else if (m.type === 'error') error = String(m.error?.data?.message ?? m.error?.message ?? m.error?.name ?? 'opencode error').slice(0, 300);
    },
  });
  return { text, usage, error: error ?? (text ? null : exit) };
}

const CALLS = { pi: piCall, claude: claudeCall, opencode: opencodeCall };
export function agentCall({ spec, ...rest }) {
  const { agent, model } = parseSpec(spec);
  return CALLS[agent]({ model, ...rest });
}

// ---------- discovery: which agents are installed, and every model each can reach ----------
const sh = (cmd, args, timeout = 30000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? ''), why: err ? (err.code === 'ENOENT' ? 'not installed' : String(stderr || err.message).trim().split('\n')[0].slice(0, 120)) : '' }));
});

let memo = null;
export function listAgents() {
  memo ??= (async () => {
    const [pi, claude, oc] = await Promise.all([sh(PI, ['--list-models']), sh(CLAUDE, ['--version']), sh(OPENCODE, ['models'])]);
    const piModels = pi.out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2).map((c) => `${c[0]}/${c[1]}`);
    const ocModels = oc.out.split('\n').map((l) => l.trim()).filter((l) => l.includes('/'));
    const pick = (list, want) => list.find((m) => m === want) ?? list[0] ?? '';
    return [
      { id: 'pi', name: 'pi', ok: pi.ok && piModels.length > 0, why: pi.why, models: piModels, default: pick(piModels, 'cerebras/qwen-3.8-27b'),
        note: '' },
      { id: 'claude', name: 'Claude Code', ok: claude.ok, why: claude.why, models: ['haiku', 'sonnet', 'opus', 'fable'], default: 'haiku',
        note: 'Runs on your Claude Code login. The cost shown is the API-equivalent price, not a charge.' },
      { id: 'opencode', name: 'opencode', ok: oc.ok && ocModels.length > 0, why: oc.why, models: ocModels, default: ocModels[0] ?? '',
        warn: true, note: 'Heavy: opencode sends its whole agent context with every call (about 180K input tokens per agent in testing). Use a small agent count.' },
    ];
  })();
  return memo;
}
