import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BASE_URL = 'https://hackathon.api.qloo.com';
export const TYPES = ['urn:entity:book', 'urn:entity:movie', 'urn:entity:artist'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_KEYS = new Set(['query', 'types', 'take']);
const INSIGHT_KEYS = new Set(['filter.type', 'signal.interests.entities', 'filter.results.entities', 'filter.exclude.entities', 'take', 'feature.explainability']);

export function requestUrl(endpoint, params) {
  const allowed = endpoint === '/search' ? SEARCH_KEYS : endpoint === '/v2/insights' ? INSIGHT_KEYS : null;
  if (!allowed) throw new Error('Only documented search and insights endpoints are allowed.');
  for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`Unsupported parameter: ${key}`);
  const take = Number(params.take);
  if (!Number.isInteger(take) || take < 1 || take > 10) throw new Error('take must be an integer from 1 to 10.');
  if (endpoint === '/search') {
    if (!TYPES.includes(params.types)) throw new Error('Unsupported search type.');
    if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 200) throw new Error('A short public cultural query is required.');
  } else {
    if (!TYPES.includes(params['filter.type'])) throw new Error('Unsupported insights type.');
    for (const key of ['signal.interests.entities', 'filter.results.entities', 'filter.exclude.entities']) {
      if (params[key] !== undefined && (!params[key].split(',').every(id => UUID.test(id)) || params[key].split(',').length > 20)) {
        throw new Error(`Invalid entity IDs: ${key}`);
      }
    }
    if (params['feature.explainability'] !== undefined && params['feature.explainability'] !== true) throw new Error('Explainability must be true when supplied.');
  }
  const url = new URL(endpoint, BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

export function entitiesFrom(payload, endpoint) {
  if (payload?.success === false) throw new Error('Qloo returned success=false.');
  const entities = endpoint === '/search' ? payload?.results : payload?.results?.entities;
  if (!Array.isArray(entities)) throw new Error(`Unexpected response shape for ${endpoint}; inspect the recorded response.`);
  return entities.map(entity => {
    if (!UUID.test(entity?.entity_id ?? '') || typeof entity.name !== 'string' || !Array.isArray(entity.types)) {
      throw new Error('Entity lacks the documented UUID, name, or types; do not infer identity.');
    }
    return entity;
  });
}

function compactEntity(entity) {
  return {
    entity_id: entity.entity_id,
    name: entity.name,
    types: entity.types,
    disambiguation: entity.disambiguation ?? null,
    akas: Array.isArray(entity.akas) ? entity.akas.slice(0, 10) : [],
    properties: entity.properties ?? null,
    popularity: entity.popularity ?? null,
    query: entity.query ?? null
  };
}

export function compareRankings(left, right) {
  const a = left.map(e => e.entity_id);
  const b = right.map(e => e.entity_id);
  const setA = new Set(a), setB = new Set(b);
  const union = new Set([...a, ...b]);
  const intersection = [...setA].filter(id => setB.has(id));
  return {
    leftCount: a.length, rightCount: b.length,
    jaccard: union.size ? intersection.length / union.size : null,
    sameOrder: a.length === b.length && a.every((id, i) => id === b[i]),
    commonRankChanges: intersection.map(id => ({ entity_id: id, leftRank: a.indexOf(id) + 1, rightRank: b.indexOf(id) + 1 }))
  };
}

export function selectedGroups(probes, searchReport, decisions) {
  if (searchReport.mode !== 'live' || searchReport.baseUrl !== BASE_URL) throw new Error('Probe requires evidence from a live hackathon search, not a fixture.');
  const byQuery = new Map(searchReport.results.map(result => [result.probe.id, result]));
  const expected = new Set(probes.queries.filter(query => query.group).map(query => query.id));
  for (const key of Object.keys(decisions.selections ?? {})) if (!expected.has(key)) throw new Error('Controls and unknown query IDs cannot be selected as taste signals.');
  return probes.groups.map(group => {
    const members = probes.queries.filter(query => query.group === group.id);
    const chosen = members.flatMap(query => {
      const selection = decisions.selections?.[query.id];
      if (!selection?.entityId) return [];
      if (typeof selection.reason !== 'string' || selection.reason.trim().length < 20) throw new Error(`Record identity evidence for ${query.id}.`);
      const evidence = byQuery.get(query.id);
      const entity = evidence?.entities?.find(candidate => candidate.entity_id === selection.entityId);
      if (!entity || !entity.types.includes(query.type)) throw new Error(`Selected ID for ${query.id} is absent from its typed search evidence.`);
      return [{ queryId: query.id, entity, reason: selection.reason }];
    });
    if (chosen.length < 2 || new Set(chosen.map(x => x.entity.entity_id)).size !== chosen.length) throw new Error(`Group ${group.id} requires at least two distinct verified entities. Record missing coverage; do not guess.`);
    if (new Set(chosen.flatMap(x => x.entity.types.filter(type => TYPES.includes(type)))).size < 2) throw new Error(`Group ${group.id} requires at least two cultural domains.`);
    return { ...group, selected: chosen, missing: members.filter(q => !chosen.some(c => c.queryId === q.id)).map(q => q.id) };
  });
}

function scrub(value, apiKey) {
  return JSON.parse(JSON.stringify(value).split(apiKey).join('[REDACTED]'));
}

export function createClient({ apiKey, maxRequests = 12, fetchImpl = fetch, record = async () => {} }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('QLOO_API_KEY is missing. No live request sent.');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 12) throw new Error('Maximum request budget is 12 per stage.');
  let calls = 0;
  return {
    get calls() { return calls; },
    async get(endpoint, params) {
      const url = requestUrl(endpoint, params);
      if (calls >= maxRequests) throw new Error('Local request budget exhausted; no automatic retry.');
      calls += 1;
      const start = performance.now();
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET', headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(20000)
        });
      } catch {
        await record({ index: calls, url: url.href, timestamp: new Date().toISOString(), status: null, error: 'network-or-timeout', elapsedMs: Math.round(performance.now() - start) });
        throw new Error('Network or timeout error. No retry and no fallback endpoint were used.');
      }
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      const receipt = {
        index: calls, url: url.href, timestamp: new Date().toISOString(), status: response.status,
        elapsedMs: Math.round(performance.now() - start),
        retryAfter: response.headers.get('retry-after'),
        bodySha256: createHash('sha256').update(raw).digest('hex'),
        response: payload === null ? { unparsed: true, bytes: raw.length } : scrub(payload, apiKey)
      };
      await record(receipt);
      if (response.status === 404 && endpoint === '/search') return { results: [], _searchNoResults: true };
      if (!response.ok) throw new Error(`Qloo HTTP ${response.status}; inspect receipt ${calls}. No retry or endpoint fallback.`);
      if (payload === null) throw new Error('Expected JSON; response was recorded as unparsed.');
      return scrub(payload, apiKey);
    }
  };
}

async function save(file, data) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
}

function runPath(name) {
  if (!/^live-[a-zA-Z0-9_-]+$/.test(name ?? '')) throw new Error('Run name must begin live- and contain only letters, digits, _ or -.');
  return path.join(ROOT, 'artifacts', name);
}

async function main() {
  const [stage = 'plan', ...args] = process.argv.slice(2);
  const probes = JSON.parse(await readFile(path.join(ROOT, 'fixtures/probes.json'), 'utf8'));
  if (stage === 'plan') {
    console.log(JSON.stringify({ mode: 'offline-request-plan', liveApiTested: false, baseUrl: BASE_URL,
      searchRequests: probes.queries.map(probe => ({ id: probe.id, url: requestUrl('/search', { query: probe.query, types: probe.type, take: 5 }).href })),
      requestBudgets: { search: 8, probeMaximum: 12 },
      next: 'After receiving event access and checking the issued quota, run search --live --run live-NAME. Review identities in decisions.json, then run probe with that same run.'
    }, null, 2));
    return;
  }
  if (!['search', 'probe'].includes(stage) || !args.includes('--live')) {
    throw new Error('Usage: preflight.mjs plan | search --live --run live-NAME | probe --live --run live-NAME');
  }
  const runIndex = args.indexOf('--run');
  const folder = runPath(runIndex >= 0 ? args[runIndex + 1] : undefined);
  const apiKey = process.env.QLOO_API_KEY;
  // Validate the key before making a directory or touching prior evidence.
  createClient({ apiKey });
  if (stage === 'search') {
    await mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
    await mkdir(folder); // Never overwrite a previous run.
  } else {
    await stat(folder);
  }
  const stageFolder = stage === 'search' ? folder : path.join(folder, 'probe');
  const client = createClient({ apiKey, maxRequests: stage === 'search' ? 8 : 12,
    record: receipt => save(path.join(stageFolder, `receipt-${String(receipt.index).padStart(2, '0')}.json`), receipt) });
  if (stage === 'search') {
    const report = { mode: 'live', baseUrl: BASE_URL, startedAt: new Date().toISOString(), results: [] };
    for (const probe of probes.queries) {
      const payload = await client.get('/search', { query: probe.query, types: probe.type, take: 5 });
      report.results.push({ probe, entities: entitiesFrom(payload, '/search').map(compactEntity), status: 'identity-review-required' });
    }
    await save(path.join(folder, 'search-report.json'), report);
    await save(path.join(folder, 'decisions.json'), {
      instructions: 'Choose only identities supported by search-report metadata. Keep absent or ambiguous entities null. State title/year/creator evidence; do not accept a fuzzy top result by default. These are operator decisions, not user research.',
      selections: Object.fromEntries(probes.queries.filter(q => q.group).map(q => [q.id, { entityId: null, reason: '' }]))
    });
    console.log(`Saved ${client.calls} live search receipts to ${folder}. Entity identities still require review.`);
    return;
  }
  const search = JSON.parse(await readFile(path.join(folder, 'search-report.json'), 'utf8'));
  const decisions = JSON.parse(await readFile(path.join(folder, 'decisions.json'), 'utf8'));
  const groups = selectedGroups(probes, search, decisions);
  await mkdir(stageFolder); // Validate identities first; preserve any completed/failed network run.
  const discoveries = [];
  for (const group of groups) {
    for (const type of TYPES) {
      const params = { 'filter.type': type, 'signal.interests.entities': group.selected.map(s => s.entity.entity_id).join(','),
        'filter.exclude.entities': groups.flatMap(g => g.selected.map(s => s.entity.entity_id)).join(','),
        'feature.explainability': true, take: 5 };
      const payload = await client.get('/v2/insights', params);
      const entities = entitiesFrom(payload, '/v2/insights');
      if (entities.some(entity => !entity.types.includes(type))) throw new Error('Insights returned an unexpected type; inspect the receipt before continuing.');
      discoveries.push({ group: group.id, type, entities: entities.map(compactEntity), query: payload.query ?? null });
    }
  }
  const comparisons = [];
  for (const type of TYPES) {
    const entries = discoveries.filter(d => d.type === type);
    const candidateIds = [...new Set(entries.flatMap(d => d.entities.map(e => e.entity_id)))];
    if (!candidateIds.length) { comparisons.push({ type, status: 'no-candidates', ablation: null }); continue; }
    const common = { 'filter.type': type, 'filter.results.entities': candidateIds.join(','), take: 10 };
    const withPayload = await client.get('/v2/insights', { ...common, 'signal.interests.entities': groups[0].selected.map(s => s.entity.entity_id).join(','), 'feature.explainability': true });
    const withoutPayload = await client.get('/v2/insights', common);
    const withSignal = entitiesFrom(withPayload, '/v2/insights').map(compactEntity);
    const withoutSignal = entitiesFrom(withoutPayload, '/v2/insights').map(compactEntity);
    if ([...withSignal, ...withoutSignal].some(entity => !candidateIds.includes(entity.entity_id) || !entity.types.includes(type))) throw new Error('Shortlist/type filter did not hold; inspect receipts.');
    comparisons.push({ type, status: 'observed', candidateIds,
      profileSensitivity: compareRankings(entries[0].entities, entries[1].entities),
      withSignal, withoutSignal, ablation: compareRankings(withSignal, withoutSignal),
      limit: 'Candidate pool comes from both discoveries, so this checks API sensitivity, not independent recommendation quality. No-signal results are not an LLM-only baseline.' });
  }
  await save(path.join(stageFolder, 'probe-report.json'), {
    mode: 'live', baseUrl: BASE_URL, completedAt: new Date().toISOString(), requests: client.calls,
    groups, discoveries, comparisons,
    decision: 'manual-review-required',
    limitations: ['No library catalog or real users tested.', 'Affinity is not individual probability or thematic proof.', 'Missing explainability must remain missing.', 'A changed ranking alone does not demonstrate product value.']
  });
  console.log(`Saved ${client.calls} live probe receipts and comparisons to ${stageFolder}. Product viability remains a separate review.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
