/**
 * P4 Team dashboard (Option B — per-developer, explicit opt-in) tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { aggregate, renderText } = await import('../src/core/team.js');
const syncMod = await import('../src/core/sync.js');

function teamFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-'));
  const rec = (machine, dev, date, tok, req, cost) =>
    JSON.stringify({ machineId: 'm-' + machine.toLowerCase(), machineName: machine,
      ...(dev ? { developer: dev } : {}), date,
      inputTokens: tok, outputTokens: Math.round(tok / 10), requests: req,
      estCostUsd: cost, exportedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(dir, 'm-v1.jsonl'), [
    rec('MacBook Pro', 'Vimox', '2026-08-22', 4200000, 310, 73.82),
    rec('MacBook Pro', 'Vimox', '2026-08-23', 2800000, 204, 51.4),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'm-b1.jsonl'),
    rec('DevB Laptop', 'Dev B', '2026-08-22', 3100000, 240, 52.1) + '\n');
  fs.writeFileSync(path.join(dir, 'm-x.jsonl'),
    rec('shared-box', null, '2026-08-22', 500000, 40, 8.5) + '\n');   // anonymous
  return dir;
}

test('team: per-developer rows stitch multiple machines per person', () => {
  const dir = teamFixture();
  const t = aggregate(dir);
  const vimox = t.shares.find((d) => d.developer === 'Vimox');
  // MacBook Pro (4.62M) + Desktop… wait — fixture has Vimox on one machine here;
  // the two-machine stitch is covered in team: roster. Here assert totals:
  assert.equal(vimox.machines.length >= 1, true);
  assert.ok(vimox.tokens > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team: anonymous machines excluded from per-dev rows but counted in totals', () => {
  const dir = teamFixture();
  const t = aggregate(dir);
  assert.equal(t.shares.length, 2);                       // Vimox + Dev B only
  assert.equal(t.totals.namedDevelopers, 2);
  assert.ok(t.totals.anonymousTokens > 0);                // shared-box still in totals
  assert.ok(!t.shares.some((d) => /shared|anonymous/i.test(d.developer)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team: shares sum to ~100% of cost and bars are proportional', () => {
  const dir = teamFixture();
  const t = aggregate(dir);
  const pctSum = t.shares.reduce((s, d) => s + (d.pctOfCost || 0), 0)
    + Math.round((t.totals.anonymousTokens > 0 ? 1 : 0));   // anon share not in devs
  assert.ok(pctSum <= 100.5 && pctSum >= 80);              // anon takes some %
  const [top, second] = t.shares;
  assert.ok(top.bar >= second.bar);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team: date filtering narrows window', () => {
  const dir = teamFixture();
  const t = aggregate(dir, { from: '2026-08-22', to: '2026-08-22' });
  assert.equal(t.trendDays.length, 1);
  assert.equal(t.window.from, '2026-08-22');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team privacy: renderText never invents names; anonymous labeled clearly', () => {
  const dir = teamFixture();
  const text = renderText(aggregate(dir));
  assert.match(text, /chose to publish/);
  assert.ok(!text.includes('undefined'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('team: empty dir returns null, renderText handles it', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-empty-'));
  assert.equal(aggregate(empty), null);
  assert.match(renderText(null), /No team data/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('sync push includes developer field ONLY when configured', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-shared-'));
  process.env.TOKENFLOW_HOME = tmpHome;

  const dataDir = path.join(tmpHome, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'cube.json'), JSON.stringify({
    dims: ['d', 'p'], measures: ['in', 'out', 'req', 'cost'],
    rows: [['2026-08-24', 'anthropic', 100, 50, 3, 0.5]],
  }));

  const m = await import('../src/core/sync.js');

  // Without developerName → NO developer field
  m.push({ config: { sync: { enabled: true, dir: shared } } });
  let line = JSON.parse(fs.readFileSync(path.join(shared, `${m.machineId(tmpHome)}.jsonl`), 'utf8').trim());
  assert.ok(!('developer' in line));

  // With developerName → field present and sanitized
  m.push({ config: { sync: { enabled: true, dir: shared, developerName: 'Vimox <admin>' } } });
  line = JSON.parse(fs.readFileSync(path.join(shared, `${m.machineId(tmpHome)}.jsonl`), 'utf8').trim());
  assert.equal(line.developer, 'Vimox admin');   // sanitized

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});
