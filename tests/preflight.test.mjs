import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_URL, requestUrl, entitiesFrom, compareRankings, createClient, selectedGroups } from '../scripts/preflight.mjs';

// All payloads below are authored unit fixtures, never fetched Qloo data.
const first = { entity_id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic Book A', types: ['urn:entity:book'] };
const second = { entity_id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic Film B', types: ['urn:entity:movie'] };
const fixtureResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('request construction uses the event origin, correct query encoding and documented parameters', () => {
  const url = requestUrl('/search', { query: 'Cien años & memoria', types: 'urn:entity:book', take: 5 });
  assert.equal(url.origin, BASE_URL);
  assert.equal(url.searchParams.get('query'), 'Cien años & memoria');
  assert.equal(url.searchParams.has('X-Api-Key'), false);
  assert.throws(() => requestUrl('/recs', { take: 5 }));
  assert.throws(() => requestUrl('/v2/insights', { 'filter.type': 'urn:entity:book', invented: true, take: 5 }));
  assert.throws(() => requestUrl('/search', { query: 'x', types: 'urn:entity:music', take: 5 }));
  assert.throws(() => requestUrl('/v2/insights', { 'filter.type': 'urn:entity:book', 'signal.interests.entities': 'invented-id', take: 5 }));
});

test('unknown envelopes and malformed identities fail instead of becoming empty results', () => {
  assert.deepEqual(entitiesFrom({ results: [] }, '/search'), []);
  assert.deepEqual(entitiesFrom({ results: { entities: [first] } }, '/v2/insights'), [first]);
  assert.throws(() => entitiesFrom({ items: [] }, '/search'));
  assert.throws(() => entitiesFrom({ results: [first] }, '/v2/insights'));
  assert.throws(() => entitiesFrom({ results: [{ name: 'Looks plausible' }] }, '/search'));
  assert.throws(() => entitiesFrom({ success: false, results: [] }, '/search'));
});

test('empty rankings remain undefined evidence; order and set overlap are separate', () => {
  assert.equal(compareRankings([], []).jaccard, null);
  const comparison = compareRankings([first, second], [second, first]);
  assert.equal(comparison.jaccard, 1);
  assert.equal(comparison.sameOrder, false);
  assert.equal(comparison.commonRankChanges[0].rightRank, 2);
});

test('missing credentials and exhausted request budget cause no extra network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return fixtureResponse({ results: [] }); };
  assert.throws(() => createClient({ apiKey: '', fetchImpl }));
  const client = createClient({ apiKey: 'fixture-secret', maxRequests: 1, fetchImpl });
  const params = { query: 'Synthetic', types: 'urn:entity:book', take: 5 };
  await client.get('/search', params);
  await assert.rejects(client.get('/search', params), /budget/);
  assert.equal(called, 1);
});

test('authentication stays in header, redirects are disabled, echoed key is redacted from receipts', async () => {
  const receipts = [];
  const client = createClient({ apiKey: 'fixture-secret', record: async r => receipts.push(r), fetchImpl: async (url, options) => {
    assert.equal(url.origin, BASE_URL);
    assert.equal(options.headers['X-Api-Key'], 'fixture-secret');
    assert.equal(options.redirect, 'error');
    return fixtureResponse({ results: [], echoed: 'fixture-secret' });
  } });
  const result = await client.get('/search', { query: 'Synthetic', types: 'urn:entity:book', take: 5 });
  assert.equal(result.echoed, '[REDACTED]');
  assert.equal(JSON.stringify(receipts).includes('fixture-secret'), false);
});

test('401 and 429 stop without retry or alternate endpoint; search 404 is the documented empty case', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const client = createClient({ apiKey: 'fixture-secret', fetchImpl: async () => { calls++; return fixtureResponse({ error: 'fixture' }, status); } });
    await assert.rejects(client.get('/search', { query: 'Synthetic', types: 'urn:entity:book', take: 5 }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
  const missing = createClient({ apiKey: 'fixture-secret', fetchImpl: async () => fixtureResponse({}, 404) });
  assert.deepEqual(entitiesFrom(await missing.get('/search', { query: 'Synthetic', types: 'urn:entity:book', take: 5 }), '/search'), []);
});

test('identity selection requires source evidence and never converts controls into audience signals', () => {
  const probes = { groups: [{ id: 'g' }], queries: [{ id: 'a', group: 'g', type: 'urn:entity:book' }, { id: 'b', group: 'g', type: 'urn:entity:movie' }, { id: 'control', control: 'nonexistent' }] };
  const search = { mode: 'live', baseUrl: BASE_URL, results: [{ probe: { id: 'a' }, entities: [first] }, { probe: { id: 'b' }, entities: [second] }] };
  const decisions = { selections: { a: { entityId: first.entity_id, reason: 'Authored fixture identity justification A.' }, b: { entityId: second.entity_id, reason: 'Authored fixture identity justification B.' } } };
  assert.equal(selectedGroups(probes, search, decisions)[0].selected.length, 2);
  assert.throws(() => selectedGroups(probes, { ...search, mode: 'synthetic' }, decisions));
  assert.throws(() => selectedGroups(probes, search, { selections: { a: { entityId: second.entity_id, reason: 'Wrong result identity despite lengthy prose.' } } }));
  assert.throws(() => selectedGroups(probes, search, { selections: { ...decisions.selections, control: { entityId: first.entity_id } } }));
});
