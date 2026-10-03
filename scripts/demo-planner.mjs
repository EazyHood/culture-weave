import { readFile } from 'node:fs/promises';
import { planCycle, replanCycle } from '../src/planner.mjs';

const read = async name => JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const catalog = await read('catalog.json');
const scenario = await read('planning-scenario.json');
const input = { catalog, constraints: scenario.constraints, ranking: scenario.ranking };
const initial = planCycle(input);
const replanned = replanCycle({ ...input, previousPlan: initial, unavailableItemIds: scenario.removeForReplan });
const impossible = replanCycle({ ...input, previousPlan: initial, unavailableItemIds: scenario.removeForReplan,
  constraints: { ...input.constraints, totalBudgetMinor: '1' } });
console.log(JSON.stringify({ mode: 'synthetic-planning-demo', notice: scenario.provenance, initial, replanned, impossible }, null, 2));
