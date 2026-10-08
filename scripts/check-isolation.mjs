#!/usr/bin/env node
// Exp-1 isolation guard. Fails (exit 1) if this repository's deployment configuration could reach the original
// Wisedo infrastructure. Run by the tests (test/isolation.test.js) and as the first step of every deploy job.
//
//   node scripts/check-isolation.mjs [--env production|staging]
//
// Checks wrangler.jsonc (every environment) and the GitHub workflows:
//   - Worker names must start with "wisedo-engine-exp-1"; forbidden names are rejected anywhere in the config
//   - D1 ids must be on the Exp-1 allowlist; known original ids are rejected anywhere in the repo's deploy files
//   - workflows may only run wrangler against the Exp-1 database names
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Original / unrelated production resources this repository must never touch. */
export const FORBIDDEN = {
  names: ['wisedo-engine-demo', 'wisedo-catalog', 'wisedo-catalog-staging', 'wisedo-catalog-pilot', 'wisedo-catalog-v04-staging', 'wisedo-engine'],
  d1Ids: [
    '1855c8d1-7165-4627-90b5-03ccb7d7f2f7', // wisedo-engine-demo (original engine D1)
    '9a986f78-5bce-4d5a-9aeb-ca7ca84265ca', // wisedo-catalog
    '2e849aae-392c-4bdc-ac0e-f5bf1d9b5bb1', // wisedo-catalog-staging
    '51ef1e55-1712-4dbf-9c4d-3bfbad75ed9e', // wisedo-catalog-v04-staging
  ],
};

/** The only resources Exp-1 may use. */
export const ALLOWED = {
  workers: { production: 'wisedo-engine-exp-1', staging: 'wisedo-engine-exp-1-staging' },
  d1: {
    production: { name: 'wisedo-engine-exp-1', id: 'f749d540-7fc7-43a2-abbd-abf3e320831e' },
    staging: { name: 'wisedo-engine-exp-1-staging', id: '4bdf73d9-18ba-4b9a-837d-d63bf223ee37' },
  },
};

/** JSONC -> JSON (line and block comments outside strings, trailing commas). */
export function parseJsonc(text) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * @param {{wranglerText: string, workflows: Record<string, string>}} files
 * @returns {string[]} problems (empty = isolated)
 */
export function checkIsolation(files) {
  const problems = [];
  let cfg;
  try { cfg = parseJsonc(files.wranglerText); } catch (e) { return [`wrangler.jsonc does not parse: ${e.message}`]; }
  const envs = { production: cfg, ...Object.fromEntries(Object.entries(cfg.env || {}).map(([k, v]) => [k, v])) };
  for (const [envName, e] of Object.entries(envs)) {
    const want = ALLOWED.workers[envName];
    if (!want) { problems.push(`unknown environment "${envName}" (allowed: ${Object.keys(ALLOWED.workers).join(', ')})`); continue; }
    if (e.name !== want) problems.push(`${envName}: Worker name "${e.name}" must be "${want}"`);
    const dbs = e.d1_databases || [];
    if (dbs.length !== 1) problems.push(`${envName}: expected exactly one D1 binding, found ${dbs.length}`);
    for (const db of dbs) {
      const allowed = ALLOWED.d1[envName];
      if (db.database_id !== allowed.id || db.database_name !== allowed.name) problems.push(`${envName}: D1 ${db.database_name} (${db.database_id}) is not the Exp-1 ${envName} database ${allowed.name} (${allowed.id})`);
    }
    for (const k of ['kv_namespaces', 'r2_buckets', 'services', 'durable_objects', 'queues', 'routes', 'route']) {
      if (e[k] && (!Array.isArray(e[k]) || e[k].length)) problems.push(`${envName}: "${k}" bindings are not part of Exp-1; add them to the allowlist first`);
    }
  }
  const all = { 'wrangler.jsonc': files.wranglerText, ...files.workflows };
  for (const [file, text] of Object.entries(all)) {
    for (const id of FORBIDDEN.d1Ids) if (text.includes(id)) problems.push(`${file}: contains the original database id ${id}`);
    for (const name of FORBIDDEN.names) {
      const re = new RegExp(`(^|[^\\w-])${name.replace(/-/g, '\\-')}(?![\\w-])`);
      // Comment lines may name the original resources (to forbid them); code and config lines may not.
      const hit = text.split('\n').find((l) => re.test(l) && !/^\s*(\/\/|#|\*)/.test(l));
      if (hit) problems.push(`${file}: references "${name}": ${hit.trim().slice(0, 120)}`);
    }
  }
  for (const [file, text] of Object.entries(files.workflows)) {
    for (const m of text.matchAll(/wrangler\s+d1\s+[\w\s-]*?\s(wisedo[\w-]*)/g)) {
      const ok = Object.values(ALLOWED.d1).some((d) => d.name === m[1]);
      if (!ok) problems.push(`${file}: wrangler d1 command targets "${m[1]}"`);
    }
  }
  return problems;
}

export function loadFiles(root = ROOT) {
  const wfDir = join(root, '.github', 'workflows');
  const workflows = Object.fromEntries(readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [`.github/workflows/${f}`, readFileSync(join(wfDir, f), 'utf8')]));
  return { wranglerText: readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), workflows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkIsolation(loadFiles());
  const envArg = process.argv.indexOf('--env');
  const env = envArg > 0 ? process.argv[envArg + 1] : null;
  if (env && !ALLOWED.workers[env]) problems.push(`--env ${env} is not an Exp-1 environment`);
  if (problems.length) {
    for (const p of problems) console.error(`ISOLATION FAILURE: ${p}`);
    process.exit(1);
  }
  const t = env || 'production';
  console.log(`isolation ok: ${t} -> Worker ${ALLOWED.workers[t]}, D1 ${ALLOWED.d1[t].name} (${ALLOWED.d1[t].id})`);
}
