/**
 * src/analytics/tickets.js — ticket key extraction (branch name / PR title),
 * URL building, and the cost-per-ticket rollup over buildReceipts() output.
 * Also covers the view module's export contract (id/label/order/css/view).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTicket, costPerTicket, renderTicketsTable } from '../src/analytics/tickets.js';
import { buildReceipts } from '../src/analytics/receipt.js';
import { buildPriceBook, estimateCost } from '../src/core/pricing.js';
import * as ticketsView from '../src/ui/views/tickets.js';
import { buildReceiptsForStore } from '../src/core/bundle.js';
import { Store, encodeRecord } from '../src/core/store.js';

const book = buildPriceBook({});

/** A priced record; override anything. */
function rec(o = {}) {
  const base = /** @type {any} */ ({
    measurement: 'primary', provider: 'anthropic', model: 'claude-opus-5', model_family: 'Claude Opus 5',
    source: 'anthropic', category: 'main', session_id: 's1', git_branch: 'feat/x',
    timestamp: '2026-08-01T10:00:00.000Z', service_tier: null, cost_basis: 'estimated',
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, cache_refresh_tokens: null,
    metadata: {}, repository: 'repo', project: 'repo',
    ...o,
  });
  if (base.estimated_cost === undefined) base.estimated_cost = estimateCost(base, base.model, base.provider, book).cost;
  return base;
}

// ------------------------------------------------------------ extractTicket

test('extractTicket: jira/linear shape, config decides the reported system', () => {
  assert.deepEqual(extractTicket('feat/ENG-1234-add-thing', { system: 'jira' }), {
    system: 'jira', key: 'ENG-1234', url: null,
  });
  assert.deepEqual(extractTicket('feat/eng-1234-add-thing', { system: 'linear' }), {
    system: 'linear', key: 'ENG-1234', url: null,
  });
});

test('extractTicket: github shapes, each of the four aliases', () => {
  assert.deepEqual(extractTicket('fix/#42-crash', { system: 'github' }), { system: 'github', key: '#42', url: null });
  assert.deepEqual(extractTicket('fix/gh-42-crash', { system: 'github' }), { system: 'github', key: '#42', url: null });
  assert.deepEqual(extractTicket('fix/issue-42-crash', { system: 'github' }), { system: 'github', key: '#42', url: null });
  assert.deepEqual(extractTicket('fix/issues/42-crash', { system: 'github' }), { system: 'github', key: '#42', url: null });
});

test('extractTicket: github aliases canonicalize to the same key, so they group as one ticket', () => {
  const a = extractTicket('gh-42-crash', { system: 'github' });
  const b = extractTicket('issue-42-crash', { system: 'github' });
  assert.equal(a.key, b.key);
});

test('extractTicket: with no system configured, a github reference is unambiguous and still labelled github', () => {
  assert.deepEqual(extractTicket('fix/issue-42-crash', {}), { system: 'github', key: '#42', url: null });
});

test('extractTicket: with no system configured, a letters-digits key is reported as "other" (jira vs linear is unknowable)', () => {
  assert.deepEqual(extractTicket('feat/ENG-1234-add-thing', {}), { system: 'other', key: 'ENG-1234', url: null });
});

test('extractTicket: no false positive on a tech acronym with a single trailing digit (UTF-8)', () => {
  assert.equal(extractTicket('docs/support-utf-8-encoding', {}), null);
  assert.equal(extractTicket('docs/support-UTF-8-encoding', { system: 'jira' }), null);
  assert.equal(extractTicket('Add UTF-8 support to the parser', { system: 'jira' }), null); // PR title case
});

test('extractTicket: a single-letter prefix is not a valid project key', () => {
  assert.equal(extractTicket('feat/A-123-thing', { system: 'jira' }), null);
});

test('extractTicket: the key must sit at a boundary, not inside a longer alphanumeric run', () => {
  assert.equal(extractTicket('feat/1234ENG-5678-thing', { system: 'jira' }), null);
  // an underscore is a legitimate separator, not part of the run
  assert.deepEqual(extractTicket('feat/x_ENG-1234_y', { system: 'jira' }), { system: 'jira', key: 'ENG-1234', url: null });
});

test('extractTicket: "issues/" is not matched when it is the tail of a longer word', () => {
  assert.equal(extractTicket('myissues/123', { system: 'github' }), null);
  assert.deepEqual(extractTicket('repo/issues/123', { system: 'github' }), { system: 'github', key: '#123', url: null });
});

test('extractTicket: custom pattern wins when set, with or without a capture group', () => {
  assert.deepEqual(extractTicket('task/TASK.42/fix', { system: 'jira', pattern: 'TASK\\.(\\d+)' }), {
    system: 'jira', key: '42', url: null,
  });
  assert.deepEqual(extractTicket('task/TASK.42/fix', { pattern: 'TASK\\.\\d+' }), {
    system: 'other', key: 'TASK.42', url: null,
  });
});

test('extractTicket: no match anywhere returns null', () => {
  assert.equal(extractTicket('feat/rename-helper', {}), null);
  assert.equal(extractTicket('main', { system: 'jira' }), null);
});

test('extractTicket: non-string / empty input returns null rather than throwing', () => {
  assert.equal(extractTicket('', { system: 'jira' }), null);
  assert.equal(extractTicket(null, { system: 'jira' }), null);
  assert.equal(extractTicket(undefined, { system: 'jira' }), null);
});

// ---------------------------------------------------------------- URL building

test('extractTicket: builds the documented URL shape per system, null with no baseUrl', () => {
  assert.equal(extractTicket('ENG-1234', { system: 'jira' }).url, null);
  assert.equal(
    extractTicket('ENG-1234', { system: 'jira', baseUrl: 'https://acme.atlassian.net' }).url,
    'https://acme.atlassian.net/browse/ENG-1234',
  );
  assert.equal(
    extractTicket('ENG-1234', { system: 'linear', baseUrl: 'https://linear.app/acme/' }).url,
    'https://linear.app/acme/issue/ENG-1234',
  );
  assert.equal(
    extractTicket('issue-42', { system: 'github', baseUrl: 'https://github.com/acme/repo' }).url,
    'https://github.com/acme/repo/issues/42',
  );
});

// ---------------------------------------------------------- costPerTicket ---

test('costPerTicket: groups the same ticket across repos and branches, sums equal receipts totals', () => {
  const records = [
    ...[1, 2, 3].map((i) => rec({ repository: 'api', project: 'api', git_branch: 'feat/ENG-100-thing', session_id: `api-s${i}` })),
    rec({ repository: 'web', project: 'web', git_branch: 'feat/eng-100-other-side', session_id: 'web-s1' }),
    rec({ repository: 'api', project: 'api', git_branch: 'feat/unrelated-cleanup', session_id: 'api-s4' }),
    rec({ repository: 'api', project: 'api', git_branch: null, session_id: 'api-s5' }), // unattributed: no branch
  ];
  const receipts = buildReceipts(records, { book, tickets: { system: 'linear' } });
  const result = costPerTicket(receipts);

  assert.equal(result.tickets.length, 1);
  const t = result.tickets[0];
  assert.equal(t.key, 'ENG-100');
  assert.equal(t.system, 'linear');
  assert.deepEqual(t.repos, ['api', 'web']);
  assert.deepEqual(t.branches, ['api#feat/ENG-100-thing', 'web#feat/eng-100-other-side']);
  assert.equal(t.turns, 4);

  // sum(tickets) + unattributed === receipts.totals.cost (the same total the Receipts tab shows)
  const sumTickets = result.tickets.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  const total = sumTickets + (result.unattributed.costUsd ?? 0);
  assert.ok(Math.abs(total - (receipts.totals.cost ?? 0)) < 1e-9);
  assert.ok(Math.abs((result.totals.costUsd ?? 0) - (receipts.totals.cost ?? 0)) < 1e-9);

  // the unattributed bucket folds in both the unmatched branch and the detached-HEAD turn
  assert.equal(result.unattributed.turns, 2);
  assert.ok(result.unattributed.branches.includes('api#feat/unrelated-cleanup'));
});

test('costPerTicket: no receipts / no tickets degrades to an empty, null-safe result', () => {
  const empty = costPerTicket(null);
  assert.deepEqual(empty.tickets, []);
  assert.equal(empty.unattributed.turns, 0);
  assert.equal(empty.totals.costUsd, null);

  const receipts = buildReceipts([rec({ git_branch: 'feat/no-ticket-here' })], { book });
  const result = costPerTicket(receipts);
  assert.equal(result.tickets.length, 0);
  assert.ok(result.unattributed.turns > 0);
});

test('renderTicketsTable: runs on an empty result without throwing', () => {
  const text = renderTicketsTable(costPerTicket(null));
  assert.equal(typeof text, 'string');
});

// -------------------------------------------------------------- view module

/**
 * A fresh TOKENFLOW_HOME holding one priced turn on `branch`. `lastRefresh` is
 * unique per call because buildReceiptsForStore() caches on it (src/core/bundle.js).
 */
function homeWithBranch(branch, tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-tickets-home-'));
  process.env.TOKENFLOW_HOME = home;
  const store = new Store();
  store.writer('2026-08-01').write(encodeRecord({
    timestamp: '2026-08-01T10:00:00.000Z', date: '2026-08-01', hour: 10, dow: 6,
    provider: 'anthropic', model: 'claude-opus-5', model_family: 'Claude Opus 5',
    client: 'claude-code', interface: 'CLI',
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 1000, cache_write_tokens: 0,
    session_id: 's1', request_id: 'req1', project: 'demo', repository: 'demo',
    git_branch: branch, category: 'main', estimated_cost: 1.5, cost_basis: 'estimated',
    source: 'anthropic', measurement: 'primary', id: `r-${tag}`,
  }));
  store.closeWriters();
  const state = new Store().state;
  state.lastRefresh = `tickets-${tag}-${process.hrtime.bigint()}`;
  fs.writeFileSync(path.join(home, 'data', 'state.json'), JSON.stringify(state));
  return home;
}

test('the dashboard\'s store receipts carry the ticket the user\'s own tickets config resolves', () => {
  const prev = process.env.TOKENFLOW_HOME;
  const home = homeWithBranch('feat/ENG-42-widget', 'cfg');
  try {
    const configured = buildReceiptsForStore(new Store(), {}, { system: 'jira', baseUrl: 'https://acme.atlassian.net' });
    const b = configured.repos[0].branches.find((x) => x.key === 'feat/ENG-42-widget');
    assert.deepEqual(b.ticket, { system: 'jira', key: 'ENG-42', url: 'https://acme.atlassian.net/browse/ENG-42' });

    // The same store with a different tickets config must not be served the
    // cached answer above: the config is part of the cache key.
    const bare = buildReceiptsForStore(new Store(), {}, {});
    const b2 = bare.repos[0].branches.find((x) => x.key === 'feat/ENG-42-widget');
    assert.deepEqual(b2.ticket, { system: 'other', key: 'ENG-42', url: null });
  } finally {
    if (prev === undefined) delete process.env.TOKENFLOW_HOME; else process.env.TOKENFLOW_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the tickets view module exports the registered-view contract', () => {
  assert.equal(ticketsView.id, 'tickets');
  assert.equal(typeof ticketsView.label, 'string');
  assert.equal(ticketsView.order, 128);
  assert.equal(ticketsView.css, './styles/tickets.css');
  assert.equal(typeof ticketsView.view, 'function');
});
