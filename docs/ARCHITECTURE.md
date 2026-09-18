# Architecture

## 1. Request flow

The browser calls the local Node.js server through endpoints such as `/api/jobs`, `/api/config`, `/api/cv-profile`, `/api/discovered-companies`, `/api/company-monitor`, `/api/discover-companies`, `/api/analyze-application`, and `/api/applications`.

The backend then coordinates source retrieval, normalization, scoring, vacancy validation, application analysis, and local JSON persistence.

## 2. Source adapters

The code integrates several source types:

- German Federal Employment Agency search/details endpoints.
- Greenhouse job boards.
- Lever postings.
- Startup Jobs RSS.
- Generic discovered company career pages.
- OpenStreetMap/Overpass-based company discovery, followed by career-page and ATS detection.

Each source has a different payload or page structure. The important architectural idea is to convert source-specific data into a shared internal job representation before ranking and displaying it.

## 3. Normalization

`normalizeJob()` converts several possible Federal Employment Agency field names into a common object containing fields such as:

- `id`
- `title`
- `company`
- `location`
- `published`
- `source`
- `category`
- `url`
- `externalUrl`
- `sourcePresence`

This protects the rest of the application from source-schema differences.

## 4. Scoring

The system intentionally separates **tech** and **delivery** scoring.

Tech scoring combines configured preferences and CV/profile terms. Delivery scoring uses signals relevant to bicycle/E-bike delivery and penalizes car/license-only signals. External tech listings also receive adjustments for seniority terms such as Senior/Lead versus Junior/Entry.

The score is a heuristic, not a probability. The UI should therefore show evidence/reasons rather than present the score as objective truth.

## 5. Language analysis

`classifyGermanRequirement()` flattens job-detail data into text and applies explicit patterns for signals such as:

- German B2/C1/C2 or strong/fluent German.
- German optional / nice-to-have.
- No German required.
- English present without an explicit high-German requirement.

This is explainable and easy to inspect, but it can miss unusual wording and should not replace reading the original listing.

## 6. Vacancy validation

A key v1.9 design correction is that an external application URL returning 404/410 is not treated as conclusive evidence that the source listing is expired.

The validator combines multiple pieces of evidence. Current source presence can outweigh a broken external link, and conflicting signals are surfaced for manual review. This reduces false “expired” classifications.

## 7. Application preparation

The backend can inspect a job description, detect application methods and requested documents, compare details against the configured profile, and produce a draft. The draft is never sent automatically.

This separation is intentional: the system assists a human decision instead of silently applying on the user's behalf.

## 8. Persistence

Application state and discovery state are stored in local JSON files. This keeps the project simple and private for a single-user local workflow, but it also creates scaling and concurrency limitations.

## 9. Current architectural debt

The main backend is still concentrated in `server.js`. A production-oriented next step is to split it into modules such as:

```text
src/
  sources/
    bundesagentur.js
    greenhouse.js
    lever.js
    startupJobs.js
  discovery/
  normalize/
  scoring/
  validation/
  applications/
  persistence/
  http/
```

That refactor would make automated testing and future source additions substantially easier.
