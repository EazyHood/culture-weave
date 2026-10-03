import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planCycle, replanCycle } from '../src/planner.mjs';

const catalog = JSON.parse(await readFile(new URL('../fixtures/catalog.json', import.meta.url), 'utf8'));
const scenario = JSON.parse(await readFile(new URL('../fixtures/planning-scenario.json', import.meta.url), 'utf8'));
const input = () => structuredClone({ catalog, constraints: scenario.constraints, ranking: scenario.ranking });
const codesFor = (plan, id) => plan.itemDecisions.find(item => item.itemId === id).reasons.map(reason => reason.code);
const ids = plan => plan.sessions.map(session => session.itemId);
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};

test('three-session demo respects budget, duration, language and media without claiming real execution', () => {
  const plan = planCycle(input());
  assert.equal(plan.status, 'feasible');
  assert.deepEqual(ids(plan), ['local:book:solitude', 'local:movie:spirited-away', 'local:artist:toto']);
  assert.equal(new Set(ids(plan)).size, 3);
  assert.deepEqual(plan.totals, { costMinor: '900', remainingBudgetMinor: '600', currency: 'USD', activityMinutes: 155, distinctMedia: 3 });
  assert.equal(plan.provenance.kind, 'synthetic-plan');
  assert.equal(plan.provenance.ranking.kind, 'synthetic-ranking');
  assert.equal(plan.executableInRealWorld, false);
  assert.ok(plan.sessions.every(session => session.durationMinutes >= session.minMinutes && session.durationMinutes <= session.maxMinutes && session.language === 'es'));
  assert.equal(plan.search.minimumBudgetShortfallForDiverseAssignmentMinor, null);
});

test('exclusion reasons distinguish missing facts, unsupported language, unavailable and unranked materials', () => {
  const plan = planCycle(input());
  for (const [id, code] of [
    ['local:movie:long-workshop', 'NO_FITTING_SLOT'], ['local:book:unknown-cost', 'COST_UNKNOWN'],
    ['local:artist:unavailable', 'UNAVAILABLE'], ['local:book:english-only', 'LANGUAGE_UNSUPPORTED'],
    ['local:movie:unknown-permission', 'PERMISSION_UNKNOWN'], ['local:artist:unknown-duration', 'DURATION_UNKNOWN'],
    ['local:book:unranked', 'NOT_RANKED']
  ]) assert.ok(codesFor(plan, id).includes(code), `${id} must include ${code}`);
  const long = plan.itemDecisions.find(item => item.itemId === 'local:movie:long-workshop');
  assert.ok(long.slotFit.every(slot => slot.reasons.some(reason => reason.code === 'TOO_LONG')));
  assert.ok(codesFor(plan, 'local:book:little-prince').includes('NOT_SELECTED'));
});

test('removing the selected film produces a supported replacement and preserves the other two slots', () => {
  const data = input();
  const before = planCycle(data);
  const after = replanCycle({ ...data, previousPlan: before, unavailableItemIds: ['local:movie:spirited-away'] });
  assert.equal(after.status, 'feasible');
  assert.deepEqual(ids(after), ['local:book:solitude', 'local:movie:serpent', 'local:artist:toto']);
  assert.equal(after.objective.preservedSessionCount, 2);
  assert.equal(after.totals.costMinor, '1200');
  assert.deepEqual(after.changes, [{ slotId: 'session-2', previousItemId: 'local:movie:spirited-away', replacementItemId: 'local:movie:serpent', reason: 'PREVIOUS_RESOURCE_REMOVED' }]);
  assert.ok(codesFor(after, 'local:movie:spirited-away').includes('REMOVED_FOR_REPLAN'));
});

test('a tighter budget can require changing a second session; preserving old choices never overrides feasibility', () => {
  const data = input(), before = planCycle(data);
  const after = replanCycle({ ...data, constraints: { ...data.constraints, totalBudgetMinor: '1000' }, previousPlan: before, unavailableItemIds: ['local:movie:spirited-away'] });
  assert.equal(after.status, 'feasible');
  assert.equal(after.totals.costMinor, '1000');
  assert.equal(after.objective.preservedSessionCount, 1);
  assert.equal(after.changes.length, 2);
  assert.ok(ids(after).includes('local:book:little-prince'));
  assert.ok(!ids(after).includes('local:book:solitude'));
});

test('infeasible replans return no partial programme and an exact minimum shortfall where calculable', () => {
  const data = input(), before = planCycle(data);
  const after = replanCycle({ ...data, constraints: { ...data.constraints, totalBudgetMinor: '999' }, previousPlan: before, unavailableItemIds: ['local:movie:spirited-away'] });
  assert.equal(after.status, 'infeasible');
  assert.deepEqual(after.sessions, []);
  assert.equal(after.totals, null);
  assert.deepEqual(after.changes, []);
  assert.equal(after.search.minimumBudgetShortfallForDiverseAssignmentMinor, '1');
  assert.ok(after.failures.some(reason => reason.code === 'BUDGET_CONSTRAINT'));
});

test('unknown costs are not zero and cross-currency prices are never converted', () => {
  const data = input();
  data.catalog.items = data.catalog.items.slice(0, 3);
  data.ranking.orderedItemIds = data.catalog.items.map(item => item.id);
  data.catalog.items[0].costMinor = null;
  data.catalog.items[1].currency = 'EUR';
  const plan = planCycle(data);
  assert.equal(plan.status, 'infeasible');
  assert.ok(codesFor(plan, data.catalog.items[0].id).includes('COST_UNKNOWN'));
  assert.ok(codesFor(plan, data.catalog.items[1].id).includes('CURRENCY_MISMATCH'));
  assert.ok(plan.failures.some(reason => reason.code === 'INSUFFICIENT_DISTINCT_RESOURCES'));
});

test('slot matching searches all assignments instead of greedily consuming the only long-slot candidate', () => {
  const data = input();
  data.catalog.items = data.catalog.items.slice(0, 3);
  data.ranking.orderedItemIds = data.catalog.items.map(item => item.id);
  data.constraints.slots = [
    { id: 'first', minMinutes: 40, maxMinutes: 60 },
    { id: 'second', minMinutes: 44, maxMinutes: 46 },
    { id: 'third', minMinutes: 49, maxMinutes: 51 }
  ];
  const plan = planCycle(data);
  assert.equal(plan.status, 'feasible');
  assert.deepEqual(ids(plan), ['local:movie:spirited-away', 'local:book:solitude', 'local:artist:toto']);
});

test('individually viable slots can still fail the no-resource-reuse constraint', () => {
  const data = input();
  data.catalog.items = data.catalog.items.slice(0, 3);
  data.ranking.orderedItemIds = data.catalog.items.map(item => item.id);
  data.constraints.slots = [
    { id: 'first', minMinutes: 44, maxMinutes: 46 },
    { id: 'second', minMinutes: 44, maxMinutes: 46 },
    { id: 'third', minMinutes: 49, maxMinutes: 60 }
  ];
  const plan = planCycle(data);
  assert.equal(plan.status, 'infeasible');
  assert.ok(plan.failures.some(reason => reason.code === 'NO_DISTINCT_ASSIGNMENT'));
});

test('empty catalogue and ranking fail honestly without selecting fabricated entries', () => {
  const data = input();
  data.catalog.items = [];
  data.ranking.orderedItemIds = [];
  const plan = planCycle(data);
  assert.equal(plan.status, 'infeasible');
  assert.equal(plan.sessions.length, 0);
  assert.equal(plan.failures.filter(reason => reason.code === 'NO_CANDIDATE_FOR_SLOT').length, 3);
});

test('decimal costs, negative budgets, duplicate or missing IDs, real-catalogue claims and malformed slots fail validation', () => {
  const mutations = [
    data => { data.catalog.items[0].costMinor = '3.00'; },
    data => { data.constraints.totalBudgetMinor = '-1'; },
    data => { data.catalog.items[1].id = data.catalog.items[0].id; },
    data => { data.ranking.orderedItemIds.push('local:missing'); },
    data => { data.ranking.orderedItemIds.push(data.ranking.orderedItemIds[0]); },
    data => { data.catalog.items[0].id = '11111111-1111-4111-8111-111111111111'; },
    data => { data.catalog.provenance.kind = 'verified-library-catalog'; },
    data => { data.constraints.slots.pop(); },
    data => { data.constraints.slots[0].minMinutes = 100; },
    data => { data.constraints.maxFacilitators = 1; },
    data => { data.constraints.slots[0].scheduledAt = 'unverified-date'; },
    data => { data.ranking.provenance.kind = 'qloo-verified'; }
  ];
  for (const mutate of mutations) { const data = input(); mutate(data); assert.throws(() => planCycle(data), TypeError); }
});

test('large minor-unit amounts remain exact beyond JavaScript safe integer range', () => {
  const data = input();
  data.catalog.items = data.catalog.items.slice(0, 3);
  data.ranking.orderedItemIds = data.catalog.items.map(item => item.id);
  data.catalog.items.forEach(item => { item.costMinor = '9007199254740993'; });
  data.constraints.totalBudgetMinor = '27021597764222980';
  const plan = planCycle(data);
  assert.equal(plan.totals.costMinor, '27021597764222979');
  assert.equal(plan.totals.remainingBudgetMinor, '1');
});

test('array-shaped IDs cannot bypass duplicate resource checks through string coercion', () => {
  const data = input();
  data.catalog.items = data.catalog.items.slice(0, 3);
  data.catalog.items.forEach(item => { item.id = ['local:same-resource']; });
  data.ranking.orderedItemIds = data.catalog.items.map(item => item.id);
  assert.throws(() => planCycle(data), TypeError);
  const clean = input(), previousPlan = planCycle(clean);
  previousPlan.sessions[0].itemId = [previousPlan.sessions[0].itemId];
  assert.throws(() => replanCycle({ ...clean, previousPlan }), TypeError);
});

test('replan prioritises valid existing assignments even when the supplied ranking changes', () => {
  const data = input(), before = planCycle(data);
  data.ranking.orderedItemIds.reverse();
  const after = replanCycle({ ...data, previousPlan: before });
  assert.equal(after.objective.preservedSessionCount, 3);
  assert.deepEqual(ids(after), ids(before));
  assert.deepEqual(after.changes, []);
});

test('replan never trusts previous totals or durations and rejects foreign/duplicate slot mappings', () => {
  const data = input(), before = planCycle(data);
  before.totals.costMinor = '-100000';
  before.sessions[0].durationMinutes = -99;
  const after = replanCycle({ ...data, previousPlan: before });
  assert.equal(after.totals.costMinor, '900');
  assert.equal(after.sessions[0].durationMinutes, 45);
  before.sessions[1].slotId = before.sessions[0].slotId;
  assert.throws(() => replanCycle({ ...data, previousPlan: before }), TypeError);
  assert.throws(() => replanCycle({ ...data, previousPlan: planCycle(data), unavailableItemIds: ['local:foreign'] }), TypeError);
});

test('externally supplied local ranking requires a separate evidence reference and is never authenticated by this planner', () => {
  const data = input();
  data.ranking.provenance = { kind: 'external-order', notice: 'Unit fixture of the boundary only; no Qloo call occurred.' };
  assert.throws(() => planCycle(data), TypeError);
  data.ranking.provenance.evidenceRef = 'fixture-only:ranking-boundary-test';
  const plan = planCycle(data);
  assert.equal(plan.provenance.rankingEvidenceVerifiedByPlanner, false);
  assert.equal(plan.provenance.kind, 'synthetic-plan');
  assert.equal(plan.executableInRealWorld, false);
});

test('planning is deterministic and does not mutate deeply frozen inputs or previous results', () => {
  const data = freeze(input());
  const before = freeze(planCycle(data));
  assert.deepEqual(planCycle(data), before);
  const after = replanCycle({ ...data, previousPlan: before, unavailableItemIds: ['local:movie:spirited-away'] });
  assert.equal(after.status, 'feasible');
  assert.equal(before.sessions[1].itemId, 'local:movie:spirited-away');
  assert.deepEqual(data.catalog, catalog);
});
