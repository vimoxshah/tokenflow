#!/usr/bin/env node
/**
 * A dependency-free linter for this project's own invariants.
 *
 * It is deliberately small and opinionated: it checks the things that would
 * actually break the product (a syntax error, a `|| 0` on a token field, an
 * `innerHTML` built from data, an unguarded localStorage call) rather than
 * re-litigating formatting.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'bin')),
  ...walk(path.join(ROOT, 'scripts')),
  ...walk(path.join(ROOT, 'test')),
];

const TOKEN_FIELDS = /(input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|cache_refresh_tokens|reasoning_tokens)/;

const SELF = path.relative(ROOT, url.fileURLToPath(import.meta.url));

for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  // The linter's own rule patterns would otherwise trip its own rules.
  const isSelf = rel === SELF || rel.endsWith('scripts/lint.js');

  // 1. it must parse
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${rel}: syntax error\n${String(err.stderr || err.message).split('\n').slice(0, 4).join('\n')}`);
    continue;
  }

  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (isSelf && i > 30) return;
    if (/\t/.test(line)) problems.push(`${at}: tab character`);
    if (/[ \t]+$/.test(line)) problems.push(`${at}: trailing whitespace`);

    // 2. the null contract: a token field must never be coerced to 0
    if (TOKEN_FIELDS.test(line) && /\|\|\s*0\b/.test(line) && !/^\s*\*/.test(line)) {
      problems.push(`${at}: "|| 0" on a token field — a missing value must stay null`);
    }

    // 3. untrusted labels must never be concatenated into HTML
    if (/\.innerHTML\s*(\+?=)/.test(line) && /[`+]/.test(line.split('innerHTML')[1] || '')) {
      if (!/html:/.test(line)) problems.push(`${at}: innerHTML built from an expression — use textContent`);
    }

    // 4. browser storage must be guarded, because a snapshot may run from file://
    if (/localStorage|sessionStorage/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      const window = lines.slice(Math.max(0, i - 6), i + 6).join('\n');
      if (!/try\s*\{/.test(window)) problems.push(`${at}: unguarded ${/local/.test(line) ? 'localStorage' : 'sessionStorage'} — wrap in try/catch`);
    }

    // 5. no stray debugging
    if (/\bdebugger\b/.test(line)) problems.push(`${at}: stray debugger statement`);
    if (/console\.(log|debug)\(/.test(line) && rel.startsWith('src/') && !rel.startsWith('src/ui/')) {
      warnings.push(`${at}: console.${/debug/.test(line) ? 'debug' : 'log'} in library code`);
    }

    // 6. an empty catch should say why it is empty
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}\s*$/.test(line)) {
      problems.push(`${at}: silent empty catch — add a comment explaining what is being ignored`);
    }
  });

  if (!src.endsWith('\n')) problems.push(`${rel}: missing trailing newline`);
  if (src.includes('\r\n')) problems.push(`${rel}: CRLF line endings`);
}

// 7. every provider directory must export a valid provider
const provDir = path.join(ROOT, 'src', 'providers');
for (const d of fs.readdirSync(provDir)) {
  const idx = path.join(provDir, d, 'index.js');
  if (!fs.existsSync(idx)) problems.push(`src/providers/${d}: missing index.js`);
}

const ok = problems.length === 0;
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 30)) console.log(`  ! ${w}`);
}
if (!ok) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 60)) console.error(`  ✗ ${p}`);
  if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
  process.exit(1);
}
console.log(`\n✓ lint clean — ${files.length} files checked`);
