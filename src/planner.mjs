const MEDIA = new Set(['book', 'movie', 'artist']);
const LOCAL_ID = /^local:[a-z0-9][a-z0-9:-]{0,95}$/;
const MINOR = /^(0|[1-9][0-9]{0,17})$/;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}
function nonempty(value, max = 500) {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
function integer(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
function issue(code, message) { return { code, message }; }
function knownFields(value, fields, name) {
  assert(Object.keys(value).every(key => fields.includes(key)), `${name} contains an unsupported field. No extra constraints are silently ignored.`);
}
function minor(value, name) {
  assert(typeof value === 'string' && MINOR.test(value), `${name} must be a non-negative integer string of at most 18 digits.`);
  return BigInt(value);
}

function validateInputs(catalog, constraints, ranking) {
  assert(catalog?.schemaVersion === '1.0' && catalog.provenance?.kind === 'synthetic-catalog' && nonempty(catalog.provenance.notice), 'This planner version requires an explicitly synthetic catalogue.');
  assert(Array.isArray(catalog.items) && catalog.items.length <= 60, 'Catalogue items must be an array with at most 60 entries.');
  const ids = new Set();
  for (const item of catalog.items) {
    assert(item && typeof item.id === 'string' && LOCAL_ID.test(item.id) && !ids.has(item.id), 'Catalogue IDs must be unique local: identifier strings, never Qloo UUIDs.');
    ids.add(item.id);
    assert(nonempty(item.name, 180) && nonempty(item.activity, 300), `Name and activity required for ${item.id}.`);
    assert(MEDIA.has(item.medium), `Unsupported medium for ${item.id}.`);
    assert(['available', 'unavailable', 'unknown'].includes(item.availability), `Explicit availability required for ${item.id}.`);
    assert(item.durationMinutes === null || integer(item.durationMinutes, 1, 600), `Duration for ${item.id} must be 1–600 whole activity minutes or null.`);
    if (item.costMinor !== null) minor(item.costMinor, `${item.id}.costMinor`);
    assert(typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency), `Currency required for ${item.id}.`);
    assert(Array.isArray(item.languages) && item.languages.every(x => typeof x === 'string' && /^[a-z]{2,3}$/.test(x)), `Language codes required for ${item.id}.`);
    assert(['assumed-for-demo', 'not-allowed', 'unknown'].includes(item.permissionStatus), `Explicit demo permission state required for ${item.id}.`);
  }
  assert(Array.isArray(constraints?.slots) && constraints.slots.length === 3, 'Exactly three local session slots are required.');
  knownFields(constraints, ['slots', 'totalBudgetMinor', 'currency', 'language', 'minDistinctMedia'], 'constraints');
  const slotIds = new Set();
  for (const slot of constraints.slots) {
    assert(nonempty(slot?.id, 80) && !slotIds.has(slot.id), 'Session slot IDs must be unique and nonempty.');
    knownFields(slot, ['id', 'minMinutes', 'maxMinutes'], 'slot');
    slotIds.add(slot.id);
    assert(integer(slot.minMinutes, 1, 600) && integer(slot.maxMinutes, slot.minMinutes, 600), 'Each slot needs valid minMinutes and maxMinutes.');
  }
  const budget = minor(constraints.totalBudgetMinor, 'totalBudgetMinor');
  assert(typeof constraints.currency === 'string' && /^[A-Z]{3}$/.test(constraints.currency), 'Constraint currency must be a three-letter code.');
  assert(typeof constraints.language === 'string' && /^[a-z]{2,3}$/.test(constraints.language), 'One explicit session language is required.');
  assert(integer(constraints.minDistinctMedia, 1, 3), 'minDistinctMedia must be between one and three.');
  assert(Array.isArray(ranking?.orderedItemIds), 'An explicit orderedItemIds ranking is required; there is no default or simulated API ranking.');
  assert(['synthetic-ranking', 'external-order'].includes(ranking.provenance?.kind) && nonempty(ranking.provenance.notice), 'Ranking provenance must identify a synthetic ranking or externally supplied order.');
  if (ranking.provenance.kind === 'external-order') assert(nonempty(ranking.provenance.evidenceRef), 'An external order needs a reference to its separately retained evidence. The planner does not verify that evidence.');
  const ranked = new Set();
  for (const id of ranking.orderedItemIds) {
    assert(ids.has(id) && !ranked.has(id), 'Ranking IDs must be unique and present in the local catalogue; resolve external identities separately.');
    ranked.add(id);
  }
  return { ids, budget, ranks: new Map(ranking.orderedItemIds.map((id, i) => [id, i + 1])) };
}

function previousAssignments(previousPlan, slots) {
  if (!previousPlan) return new Map();
  assert(previousPlan.schemaVersion === '1.0' && previousPlan.status === 'feasible' && previousPlan.provenance?.kind === 'synthetic-plan', 'Replanning requires a feasible synthetic previous plan.');
  assert(Array.isArray(previousPlan.sessions) && previousPlan.sessions.length === 3, 'Previous plan must contain three sessions.');
  const expectedSlots = new Set(slots.map(slot => slot.id)), assignments = new Map(), items = new Set();
  for (const session of previousPlan.sessions) {
    assert(expectedSlots.has(session.slotId) && !assignments.has(session.slotId) && typeof session.itemId === 'string' && LOCAL_ID.test(session.itemId) && !items.has(session.itemId), 'Previous sessions must map distinct local item strings to the same three slots.');
    assignments.set(session.slotId, session.itemId);
    items.add(session.itemId);
  }
  // Prior costs, durations and permissions are deliberately not trusted or reused.
  return assignments;
}

function assessItem(item, constraints, ranks, removed) {
  const reasons = [];
  if (removed.has(item.id)) reasons.push(issue('REMOVED_FOR_REPLAN', 'The caller marked this local resource unavailable for this replan.'));
  if (item.availability !== 'available') reasons.push(issue(item.availability === 'unknown' ? 'AVAILABILITY_UNKNOWN' : 'UNAVAILABLE', 'Availability does not support selection in this scenario.'));
  if (item.permissionStatus !== 'assumed-for-demo') reasons.push(issue(item.permissionStatus === 'unknown' ? 'PERMISSION_UNKNOWN' : 'PERMISSION_NOT_ALLOWED', 'Permission must be explicitly assumed for this synthetic exercise; no real licence is inferred.'));
  if (item.durationMinutes === null) reasons.push(issue('DURATION_UNKNOWN', 'Activity duration is missing; the session fit cannot be established.'));
  if (item.costMinor === null) reasons.push(issue('COST_UNKNOWN', 'Cost is missing; the budget cannot be guaranteed.'));
  if (item.currency !== constraints.currency) reasons.push(issue('CURRENCY_MISMATCH', 'No currency conversion or exchange rate is assumed.'));
  if (!item.languages.includes(constraints.language)) reasons.push(issue('LANGUAGE_UNSUPPORTED', 'The requested session language is not listed for this activity.'));
  if (!ranks.has(item.id)) reasons.push(issue('NOT_RANKED', 'The supplied ranking does not include this resource; no priority is invented.'));
  const slotFit = constraints.slots.map(slot => {
    const slotReasons = [];
    if (item.durationMinutes !== null && item.durationMinutes < slot.minMinutes) slotReasons.push(issue('TOO_SHORT', 'The activity is shorter than this slot requires.'));
    if (item.durationMinutes !== null && item.durationMinutes > slot.maxMinutes) slotReasons.push(issue('TOO_LONG', 'The activity exceeds this slot duration.'));
    return { slotId: slot.id, eligible: reasons.length === 0 && slotReasons.length === 0, reasons: slotReasons };
  });
  if (!reasons.length && slotFit.every(slot => !slot.eligible)) reasons.push(issue('NO_FITTING_SLOT', 'This known activity duration fits none of the three slots.'));
  return { itemId: item.id, reasons, slotFit };
}

function compareChoices(a, b) {
  if (!b) return -1;
  if (a.preserved !== b.preserved) return b.preserved - a.preserved;
  if (a.rankSum !== b.rankSum) return a.rankSum - b.rankSum;
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  // Stable slot assignment: prefer the earlier ranking position in earlier slots.
  for (let i = 0; i < a.slotRanks.length; i++) if (a.slotRanks[i] !== b.slotRanks[i]) return a.slotRanks[i] - b.slotRanks[i];
  return 0;
}

function solve({ catalog, constraints, ranking, previousPlan = null, unavailableItemIds = [] }) {
  const { ids, budget, ranks } = validateInputs(catalog, constraints, ranking);
  assert(Array.isArray(unavailableItemIds) && unavailableItemIds.every(id => ids.has(id)) && new Set(unavailableItemIds).size === unavailableItemIds.length, 'Unavailable IDs must be unique IDs in the current local catalogue.');
  const removed = new Set(unavailableItemIds);
  const previous = previousAssignments(previousPlan, constraints.slots);
  const decisions = catalog.items.map(item => assessItem(item, constraints, ranks, removed));
  const decisionById = new Map(decisions.map(value => [value.itemId, value]));
  const candidates = constraints.slots.map(slot => catalog.items.filter(item => decisionById.get(item.id).slotFit.find(fit => fit.slotId === slot.id).eligible));
  const search = { completeAssignmentsChecked: 0, rejectedByBudget: 0, rejectedByDiversity: 0, feasibleAssignments: 0 };
  let best = null, leastShortfall = null;
  function visit(assignment, used) {
    const index = assignment.length;
    if (index < 3) {
      for (const item of candidates[index]) {
        if (used.has(item.id)) continue;
        visit([...assignment, item], new Set([...used, item.id]));
      }
      return;
    }
    search.completeAssignmentsChecked++;
    const cost = assignment.reduce((sum, item) => sum + BigInt(item.costMinor), 0n);
    const enoughMedia = new Set(assignment.map(item => item.medium)).size >= constraints.minDistinctMedia;
    if (cost > budget) search.rejectedByBudget++;
    if (!enoughMedia) search.rejectedByDiversity++;
    if (enoughMedia && cost > budget && (leastShortfall === null || cost - budget < leastShortfall)) leastShortfall = cost - budget;
    if (cost > budget || !enoughMedia) return;
    search.feasibleAssignments++;
    const slotRanks = assignment.map(item => ranks.get(item.id));
    const choice = {
      assignment, cost, slotRanks, rankSum: slotRanks.reduce((sum, rank) => sum + rank, 0),
      preserved: assignment.filter((item, i) => previous.get(constraints.slots[i].id) === item.id).length
    };
    if (compareChoices(choice, best) < 0) best = choice;
  }
  visit([], new Set());
  const failures = [];
  if (!best) {
    for (let i = 0; i < candidates.length; i++) if (!candidates[i].length) failures.push(issue('NO_CANDIDATE_FOR_SLOT', `No fully eligible resource fits ${constraints.slots[i].id}.`));
    if (new Set(candidates.flat().map(item => item.id)).size < 3) failures.push(issue('INSUFFICIENT_DISTINCT_RESOURCES', 'Fewer than three distinct resources pass the item and slot checks.'));
    if (!search.completeAssignmentsChecked && !failures.length) failures.push(issue('NO_DISTINCT_ASSIGNMENT', 'Individual slot options exist but cannot fill all three slots without reusing a resource.'));
    if (search.rejectedByDiversity) failures.push(issue('DIVERSITY_CONSTRAINT', 'Some complete assignments failed the required number of distinct media.'));
    if (search.rejectedByBudget) failures.push(issue('BUDGET_CONSTRAINT', 'Some complete assignments exceeded the scenario budget.'));
    failures.push(issue('NO_FEASIBLE_CYCLE', 'No complete three-session cycle satisfies all supplied constraints. No partial plan is returned.'));
  }
  const sessions = best ? best.assignment.map((item, i) => ({
    slotId: constraints.slots[i].id, itemId: item.id, name: item.name, activity: item.activity, medium: item.medium,
    durationMinutes: item.durationMinutes, minMinutes: constraints.slots[i].minMinutes, maxMinutes: constraints.slots[i].maxMinutes,
    unusedMinutes: constraints.slots[i].maxMinutes - item.durationMinutes,
    costMinor: item.costMinor, currency: item.currency, language: constraints.language,
    rankingPosition: ranks.get(item.id), preservedFromPrevious: previous.get(constraints.slots[i].id) === item.id,
    permission: 'Assumed only for this synthetic exercise; real permissions remain unverified.'
  })) : [];
  const selected = new Map(sessions.map(session => [session.itemId, session.slotId]));
  const itemDecisions = decisions.map(decision => ({ ...decision,
    status: selected.has(decision.itemId) ? 'selected' : decision.reasons.length ? 'excluded' : 'eligible-not-selected',
    selectedSlot: selected.get(decision.itemId) ?? null,
    reasons: !selected.has(decision.itemId) && !decision.reasons.length ? [issue('NOT_SELECTED', best ? 'Passed item checks; not selected by the complete-plan constraints and documented objective.' : 'Passed item checks; no complete feasible cycle exists.')] : decision.reasons
  }));
  const changes = previousPlan && best ? sessions.filter(session => previous.get(session.slotId) !== session.itemId).map(session => ({
    slotId: session.slotId, previousItemId: previous.get(session.slotId), replacementItemId: session.itemId,
    reason: removed.has(previous.get(session.slotId)) ? 'PREVIOUS_RESOURCE_REMOVED' : 'REASSIGNED_TO_SATISFY_CURRENT_CONSTRAINTS_OR_PREFERENCES'
  })) : [];
  return {
    schemaVersion: '1.0', status: best ? 'feasible' : 'infeasible',
    provenance: {
      kind: 'synthetic-plan', catalogueNotice: catalog.provenance.notice,
      ranking: structuredClone(ranking.provenance), rankingEvidenceVerifiedByPlanner: false,
      notice: 'Deterministic planning of hand-authored scenario data. Not a Qloo execution, model inference, scheduled event, real budget or verified library programme.'
    },
    executableInRealWorld: false, constraints: structuredClone(constraints), sessions, changes,
    totals: best ? { costMinor: String(best.cost), remainingBudgetMinor: String(budget - best.cost), currency: constraints.currency,
      activityMinutes: sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
      distinctMedia: new Set(sessions.map(session => session.medium)).size } : null,
    objective: {
      rule: 'First preserve as many prior item-to-slot assignments as possible; then minimise the sum of supplied ordinal ranking positions; then minimise cost; then favour earlier ranking positions in earlier slots. Ordinal priority is not cultural quality or probability.',
      preservedSessionCount: best?.preserved ?? null, rankingPositionSum: best?.rankSum ?? null
    },
    unavailableItemIds: [...unavailableItemIds], itemDecisions, failures,
    search: { ...search, minimumBudgetShortfallForDiverseAssignmentMinor: best || leastShortfall === null ? null : String(leastShortfall) }
  };
}

/** Pure deterministic synthetic planning. Makes no network, file, model or payment calls. */
export function planCycle({ catalog, constraints, ranking }) {
  return solve({ catalog, constraints, ranking });
}

/** Recompute every current constraint. A prior plan only supplies a preference for unchanged assignments. */
export function replanCycle({ catalog, constraints, ranking, previousPlan, unavailableItemIds = [] }) {
  assert(previousPlan, 'previousPlan is required for replanning.');
  return solve({ catalog, constraints, ranking, previousPlan, unavailableItemIds });
}
