import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles, envFileCandidates } from '../src/envfile.js';
import { authLine } from '../src/envfile.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-env-'));
}

test('env files: the project folder first, then JEV_HOME; .env.local before .env', () => {
  const root = tempDir();
  const home = tempDir();
  try {
    assert.deepEqual(envFileCandidates({ JEV_HOME: home }, root), [
      path.join(root, '.env.local'), path.join(root, '.env'), path.join(home, '.env.local'), path.join(home, '.env'),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('env files fill only unset variables, and the first file wins', () => {
  const dir = tempDir();
  try {
    const local = path.join(dir, '.env.local');
    const plain = path.join(dir, '.env');
    fs.writeFileSync(local, '# keys\nOPENAI_API_KEY=sk-local\nOPENROUTER_API_KEY="sk-or-local"\nJEV_GPT_MODEL=\n');
    fs.writeFileSync(plain, 'OPENAI_API_KEY=sk-plain\nJEV_GPT_MODEL=gpt-6.1-sol\nJEV_PORT=9000\n');
    const env = { JEV_PORT: '8789', JEV_GPT_MODEL: '' };
    const loaded = loadEnvFiles(env, [local, plain, path.join(dir, 'missing.env')]);
    assert.equal(env.OPENAI_API_KEY, 'sk-local');
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-local');
    // An empty value in an earlier file does not block a later one, and the shell's value wins.
    assert.equal(env.JEV_GPT_MODEL, 'gpt-6.1-sol');
    assert.equal(env.JEV_PORT, '8789');
    assert.deepEqual(loaded.map((l) => path.basename(l.file)), ['.env.local', '.env']);
    assert.deepEqual(loaded[1].keys, ['JEV_GPT_MODEL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider sets how Codex authenticates: login, OPENAI_API_KEY or OPENROUTER_API_KEY', () => {
  assert.equal(authLine(), 'requires_openai_auth = true');
  assert.equal(authLine('openai'), 'env_key = "OPENAI_API_KEY"');
  assert.equal(authLine('openrouter'), 'env_key = "OPENROUTER_API_KEY"');
  assert.throws(() => authLine('azure'), /unknown provider/);
});

test('env files: a UTF-8 BOM is ignored, only this tool\'s variables are taken, read errors are reported', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, '.env.local');
    fs.writeFileSync(file, '\uFEFFOPENAI_API_KEY=sk-bom\nGITHUB_TOKEN=ghp-secret\nJEV_PORT=9001\n');
    const env = {};
    const [loaded, broken] = loadEnvFiles(env, [file, dir]);
    assert.equal(env.OPENAI_API_KEY, 'sk-bom');
    assert.equal(env.JEV_PORT, '9001');
    // Other secrets in a shared .env never reach codex or its tools.
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.deepEqual(loaded.keys.sort(), ['JEV_PORT', 'OPENAI_API_KEY']);
    // A directory where a file should be is reported instead of aborting every command.
    assert.equal(broken.file, dir);
    assert.ok(broken.error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
