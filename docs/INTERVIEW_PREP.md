# Interview Preparation

## 60-second project explanation

> Personal Job Agent is a local Node.js application I built to make my job search more accurate and manageable. It combines listings from several sources, normalizes them into one format, removes duplicates, scores them with separate rules for tech and delivery roles, and stores application states locally. One important improvement came from a real failure mode: an earlier version could interpret a broken external application link as an expired vacancy. I changed the validation logic to combine source presence with external-link evidence and surface conflicts instead of silently deleting the job. The next technical step is to modularize the backend and add automated tests around scoring, normalization, and vacancy validation.

Adapt the wording to your own speaking style; do not memorize it mechanically.

## Questions you should be ready to answer

### Why Node.js?

The project already needed asynchronous HTTP requests, JSON processing, and a small local web server. Node.js allowed the backend and browser-side code to stay in the JavaScript ecosystem. The current version also works without third-party npm dependencies, which keeps setup small.

### Why not use React?

The first goal was validating the workflow and search logic rather than building a complex component system. Vanilla JavaScript was enough for the current UI. If the interface grows, moving to a component framework could improve maintainability.

### What was the hardest engineering lesson?

Treating one signal as absolute truth. A 404/410 from an external apply URL can conflict with the source that still lists the vacancy. The improved version represents that uncertainty explicitly instead of collapsing it into “expired”.

### How do you handle different job sources?

Source-specific functions retrieve data, then listings are normalized into a common shape. Downstream filtering and scoring can work on that internal format rather than knowing every external schema.

### Is the fit score AI?

No. It is currently an explainable heuristic based on configured terms and explicit rules. Calling it AI would overstate what the code does. A future semantic model could be added, but evidence and explainability should remain visible.

### Why separate tech and delivery scoring?

The meaning of “fit” is different. React/TypeScript and seniority matter for tech roles, while bicycle/E-bike compatibility, part-time availability, shift flexibility, and car/license restrictions matter for delivery roles. A single keyword model would mix unrelated signals.

### How would you test it?

Start with pure functions: language classification, scoring, deduplication keys, normalization, and validation decisions. Use fixed fixtures for source responses. Then add route-level integration tests with mocked network calls.

### What would you change if you started again?

I would modularize earlier, create fixtures/tests around source adapters from the beginning, keep user-specific preferences outside tracked source files, and define a formal validation result schema before adding many sources.

## Questions to ask yourself while reading code

- What inputs does this function assume?
- Which part is source-specific and which part is domain logic?
- Can this function be pure?
- What happens when the network fails?
- What happens when a source changes its schema?
- Is a score/reason visible to the user?
- Which assumptions came from real usage rather than theory?
