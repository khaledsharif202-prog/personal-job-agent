# Learning Guide

The goal of this repository is not only to show working code. You should be able to explain *why* it works and *why* certain decisions were made.

## Module 1 — Node.js without a framework

Study how `server.js` creates an HTTP server, parses URLs, returns JSON, serves static files, and reads/writes local files.

Be able to explain:

- What `http.createServer()` does.
- The difference between a route and a static file request.
- Why `Content-Type` matters.
- Why `Cache-Control: no-store` can be useful for fresh local API data.
- Why `fs.createReadStream()` is preferable to loading a large static file entirely into memory.

## Module 2 — Async JavaScript and network requests

Study the search functions and `fetch()` calls.

Be able to explain:

- `async` / `await`.
- What happens when `response.ok` is false.
- Why timeouts use `AbortController`.
- Why discovery/search work is sometimes batched or run with `Promise.all()` / `Promise.allSettled()`.
- The difference between failing one source and failing the entire search.

## Module 3 — Normalization

Study `normalizeJob()`.

Challenge: write down three different source field names that can mean “job title” and explain why the app should normalize them once instead of handling every variant throughout the UI.

## Module 4 — Scoring as a heuristic

Study `scoreJob()` and external-job adjustments.

Be able to explain:

- Why a score starts from a base value.
- Why keyword-count-only scoring can be misleading.
- Why delivery and tech jobs need separate models.
- Why a score should be accompanied by reasons/evidence.
- Why this score is not a statistical probability.

## Module 5 — Regular expressions and language requirements

Study `classifyGermanRequirement()`.

Practice explaining patterns that distinguish:

- “Deutsch B2 erforderlich”
- “Deutsch von Vorteil”
- “No German required”
- English mentioned with no explicit B2+ condition

Then identify one wording the current regexes might miss and propose a test for it.

## Module 6 — Precision vs recall

This is one of the strongest interview topics in the project.

Earlier behavior could treat a broken external apply link as proof that a vacancy was expired. That produced a **false negative**: a potentially valid job could disappear from useful results.

v1.9 changed the logic so that source presence, external-link status, and conflicting evidence are considered separately.

Learn these terms:

- **Precision:** among items classified as relevant/open, how many really are?
- **Recall:** among all relevant/open items, how many did the system find/keep?
- **False positive:** system says open/relevant when it is not.
- **False negative:** system rejects/hides something that actually is open/relevant.

## Module 7 — Local persistence

Study how JSON files store saved/applied/ignored states.

Think about:

- Advantages: simple, inspectable, no database setup.
- Weaknesses: concurrent writes, corruption risk, no schema migration, poor multi-user scaling.
- When SQLite would become a better choice.

## Module 8 — Frontend state and filtering

Study `public/app.js` and the HTML template.

Be able to explain how the UI:

- fetches data from local API routes;
- filters and sorts results;
- updates application status;
- opens the analysis/application modal;
- keeps the server as the source of persistent state.

## Module 9 — Refactoring exercise

Do not refactor everything at once. Start by extracting one pure function, for example language classification or scoring, into its own module and add tests.

Suggested sequence:

1. `src/scoring/language.js`
2. `src/scoring/tech.js`
3. `src/scoring/delivery.js`
4. `src/normalize/bundesagentur.js`
5. source adapters
6. persistence
7. HTTP routes

## Technical English to practice

- normalize heterogeneous data
- deduplicate results
- source adapter
- evidence trail
- conflicting signals
- false positive / false negative
- heuristic scoring
- deterministic rule
- graceful failure
- retry / timeout
- local persistence
- human-in-the-loop review
- backward-compatible change

## Mini interview exercise

Explain the project in 60 seconds without reading the README. Your answer should cover:

1. the problem;
2. the architecture;
3. one difficult bug/assumption;
4. the precision-first fix;
5. what you would improve next.
