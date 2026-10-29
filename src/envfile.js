// Loads keys from env files so they need not live in the shell: `.env.local`, then `.env`, in
// the project folder and in JEV_HOME. Variables already set (non-empty) in the environment
// win, and the first file that sets a variable wins over later ones. Only this tool's own
// variables are taken, so other secrets in a shared .env do not reach `codex` and its tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILES = ['.env.local', '.env'];
const OWN_VARIABLE = /^(?:JEV_|OPENAI_|OPENROUTER_)/;

/** The env files looked at, in order: the project folder first, then JEV_HOME. */
export function envFileCandidates(env = process.env, root = ROOT) {
  const home = env.JEV_HOME || path.join(os.homedir(), '.jev-gpt');
  const dirs = [...new Set([root, home].map((d) => path.resolve(d)))];
  return dirs.flatMap((dir) => ENV_FILES.map((f) => path.join(dir, f)));
}

/**
 * Copies this tool's variables from the env files into `env` without replacing any that are
 * set. A file that exists but cannot be read is reported, not fatal.
 * @returns {{file:string, keys:string[], error?:string}[]} the files read and the variables each one set
 */
export function loadEnvFiles(env = process.env, files = envFileCandidates(env)) {
  const loaded = [];
  for (const file of files) {
    let text;
    try {
      // Windows editors often save UTF-8 with a BOM, which would hide the first variable.
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      if (err.code !== 'ENOENT') loaded.push({ file, keys: [], error: err.message });
      continue;
    }
    const keys = [];
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (!OWN_VARIABLE.test(key) || (env[key] != null && env[key] !== '')) continue;
      env[key] = value;
      keys.push(key);
    }
    loaded.push({ file, keys });
  }
  return loaded;
}

// How Codex authenticates to the proxy, which forwards it upstream: the ChatGPT login, or an
// API key Codex reads from the named environment variable (sk- -> OpenAI, sk-or- -> OpenRouter).
const AUTH = {
  chatgpt: 'requires_openai_auth = true',
  openai: 'env_key = "OPENAI_API_KEY"',
  openrouter: 'env_key = "OPENROUTER_API_KEY"',
};

/** The Codex provider-table line that sets how Codex authenticates for `provider`. */
export function authLine(provider = 'chatgpt') {
  const line = AUTH[provider];
  if (!line) throw new Error(`unknown provider "${provider}"; use ${Object.keys(AUTH).join('|')}`);
  return line;
}
