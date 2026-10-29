import os from 'node:os';
import path from 'node:path';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function parseLadder(raw) {
  const ladder = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = ladder.filter((e) => !EFFORTS.includes(e));
  if (bad.length || ladder.length === 0) {
    throw new Error(`JEV_LEVELS must be a comma list of ${EFFORTS.join('/')}; got "${raw}"`);
  }
  return ladder;
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer; got "${v}"`);
  return n;
}

function probabilityEnv(env, name, fallback) {
  const v = Number(env[name] ?? fallback);
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be 0..1; got "${env[name]}"`);
  return v;
}

function switchEnv(env, name, fallback) {
  const v = (env[name] || fallback).toLowerCase();
  if (!['on', 'off'].includes(v)) throw new Error(`${name} must be on|off; got "${v}"`);
  return v === 'on';
}

function providerEnv(env) {
  const v = (env.JEV_PROVIDER || 'chatgpt').toLowerCase();
  if (!['chatgpt', 'openai', 'openrouter'].includes(v)) throw new Error(`JEV_PROVIDER must be chatgpt|openai|openrouter; got "${v}"`);
  return v;
}

export function loadConfig(env = process.env) {
  const home = env.JEV_HOME || path.join(os.homedir(), '.jev-gpt');
  const openrouterKey = env.OPENROUTER_API_KEY || '';
  // With an OpenRouter key the TypeSafe Jev decision model routes by default.
  const mode = (env.JEV_MODE || (openrouterKey ? 'jev' : 'heuristic')).toLowerCase();
  if (!['jev', 'heuristic', 'llm', 'off'].includes(mode)) throw new Error(`JEV_MODE must be jev|heuristic|llm|off; got "${mode}"`);
  if (mode === 'jev' && !openrouterKey) throw new Error('JEV_MODE=jev needs OPENROUTER_API_KEY');
  const ladder = parseLadder(env.JEV_LEVELS || 'low,medium,high,xhigh');
  const defaultEffort = (env.JEV_DEFAULT_EFFORT || 'medium').trim().toLowerCase();
  if (!ladder.includes(defaultEffort)) {
    throw new Error(`JEV_DEFAULT_EFFORT must be one of JEV_LEVELS (${ladder.join(',')}); got "${defaultEffort}"`);
  }
  return Object.freeze({
    host: env.JEV_HOST || '127.0.0.1',
    port: intEnv(env, 'JEV_PORT', 8789),
    ladder,
    // Where a turn starts when nothing says it is trivial or hard, and the floor once the
    // model has tried to stop early in a turn.
    defaultEffort,
    // The one upstream model; every routed request is served by it.
    model: env.JEV_GPT_MODEL || 'gpt-6.1-terra',
    // Client model names that hand the request to the router (besides the model id itself).
    autoModels: (env.JEV_AUTO_MODELS || 'jev-auto,auto').split(',').map((s) => s.trim()).filter(Boolean),
    // Long-task help: resume a turn the model ended before the work was done, and remind it
    // of an unfinished plan before each generation.
    continueTurns: switchEnv(env, 'JEV_CONTINUE', 'on'),
    maxContinues: intEnv(env, 'JEV_MAX_CONTINUES', 3),
    continueThreshold: probabilityEnv(env, 'JEV_CONTINUE_THRESHOLD', 0.6),
    nudge: switchEnv(env, 'JEV_NUDGE', 'on'),
    mode,
    // How the Codex profile authenticates the main model: the ChatGPT login, OPENAI_API_KEY or
    // OPENROUTER_API_KEY. The proxy picks the upstream from the key the client sends.
    provider: providerEnv(env),
    // Fixed upstream; when unset the auth type picks ChatGPT backend, OpenRouter or API.
    upstream: env.JEV_UPSTREAM || '',
    chatgptUpstream: env.JEV_CHATGPT_UPSTREAM || 'https://chatgpt.com/backend-api/codex',
    apiUpstream: env.JEV_API_UPSTREAM || 'https://api.openai.com/v1',
    openrouterUpstream: env.JEV_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api/v1',
    judgeModel: env.JEV_JUDGE_MODEL || '',
    judgeEffort: env.JEV_JUDGE_EFFORT || 'low',
    judgeTimeoutMs: intEnv(env, 'JEV_JUDGE_TIMEOUT_MS', 2500),
    openrouterKey,
    decisionModel: env.JEV_DECISION_MODEL || 'typesafe/jev-1.14',
    decisionUrl: env.JEV_DECISION_URL || 'https://openrouter.ai/api/alpha/decisions',
    minConfidence: probabilityEnv(env, 'JEV_MIN_CONFIDENCE', 0.3),
    home,
    logFile: path.join(home, 'decisions.jsonl'),
    quiet: env.JEV_QUIET === '1',
  });
}
