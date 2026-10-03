# Culture Weave

A programme desk for a small library: build three discussions from a finite catalogue, check practical constraints, and repair the sequence when a resource becomes unavailable.

**Current evidence:** the example works end to end; the automated test suite passes. The real Qloo transport is implemented but has not yet been run with an issued key. Example priorities, availability, costs, durations and permission states are authored scenario data, never claimed as Qloo responses or real library holdings. Do not describe this version as an eligible completed hackathon entry until live integration and public access are verified.

## Run

Node.js 22 or newer. No dependencies, install step or build is needed locally.

```sh
npm test
npm start
```

Open `http://127.0.0.1:4313`. An initial three-session example loads. Remove the film to replace it while retaining the book and music discussion. Change the budget to see an honest infeasible result. Export includes the plan, provenance, decisions, Qloo evidence where available and catalogue.

## Real Qloo connection

Set `QLOO_API_KEY` in the server environment using your host's secret manager. Restart the server. The application never accepts the key in a browser field, query string or repository. Local `.env` files are ignored but **not automatically loaded**.

1. Choose **Live Qloo**. Search public cultural references and explicitly select the matching title or artist after reviewing returned metadata.
2. Under each catalogue resource, choose **Connect Qloo identity**. Confirm the returned identity. Unresolved resources are not eligible for live ranking.
3. Build a programme. The agent requests a fixed shortlist per medium, rejects results outside that shortlist and leaves missing results out.
4. Remove a resource. The agent excludes it from its next ranking, solves the full constraints again, and preserves earlier assignments where feasible.
5. Inspect **Decisions & evidence**. Returned ranking order is shown with Qloo UUIDs. There is no invented Qloo explanation, cross-media affinity probability or simulated live fallback.

The bounded planning agent is deterministic, not an LLM. It chooses ranking tools for media with resolved resources, solves a finite assignment problem, validates budget/duration/language/permission/diversity, and repairs on an availability event. It does not schedule, purchase or send anything. Qloo order is interleaved between book, film and artist domains; it is not treated as a comparable numeric score across domains.

## HTTP endpoints

- `GET /api/status`: credential presence only.
- `POST /api/search`: `{query, medium}` with medium `book`, `movie` or `artist`.
- `POST /api/plan`: `{catalog, constraints, mode, references, previousPlan?, unavailableItemIds?}`.

Only `https://hackathon.api.qloo.com/search` and `/v2/insights` are used. Requests have 15-second timeouts, no redirects, no retry and no alternate host. Authentication is `X-Api-Key`. Responses are reduced to public identity fields; arbitrary metadata and credentials are not echoed. The demo permits two concurrent live runs and twenty live operations per minute **per running instance/isolate**. This is a modest demo safeguard, not a distributed billing quota; a larger launch needs durable rate limiting.

## Build / host

```sh
npm run build
```

Produces a dependency-free Cloudflare module Worker at `dist/server/index.js`, including its relative `src` modules and embedded static assets. The Worker exposes the same API as local Node. Configure `QLOO_API_KEY` only as a runtime secret. `dist` is ignored because it is reproducible.

## Test coverage and limits

Tests cover exact monetary arithmetic, all practical constraints, unknown data, search identity validation, repair stability, immutability, no API requests without credentials, request host/header/parameter construction, rejection of provider shortlist violations, credential echo filtering, cross-origin writes and provider failure without fallback. Provider tests use explicit test doubles; these are not live Qloo evidence.

The browser initially shows six real cultural titles with invented planning facts. The full 13-item fixture includes negative controls used by tests. All plans still require an organiser's real availability and rights review. No library partnership, audience research, attendance improvement or validated time saving is claimed. State is held in the page; export before refreshing.

## Provenance and license

Continues the original Culture Weave project prepared 1 October 2026 in Colombia (2 October UTC), including its preflight and planner. The working UI, server and bounded agent were added 3 October 2026. AI assistance was used for implementation, tests, design and documentation. Human review and real API validation remain part of completion.

MIT, see [LICENSE](LICENSE). The license covers this code and authored fixtures, not Qloo's data, trademarks or third-party works named in examples.

Official references checked 3 October 2026:

- [Qloo hackathon API guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)
- [Search API](https://docs.qloo.com/reference/get-search)
- [Parameter reference](https://docs.qloo.com/reference/parameters)
- [Hackathon rules](https://qloo.devpost.com/rules)
