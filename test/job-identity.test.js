const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeText,
  jobIdentityKey,
  sameJob,
  findMatchingApplication
} = require("../lib/job-identity");

test("normalizeText normalizes case and whitespace", () => {
  assert.equal(
    normalizeText("  STAMPAY   GmbH  "),
    "stampay gmbh"
  );
});

test("jobIdentityKey matches the same job even when source IDs differ", () => {
  const jobA = {
    id: "source-a-123",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  const jobB = {
    id: "source-b-999",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  assert.equal(
    jobIdentityKey(jobA),
    jobIdentityKey(jobB)
  );
});

test("jobIdentityKey keeps jobs in different locations separate", () => {
  const jobA = {
    id: "source-a-123",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  const jobB = {
    id: "source-b-999",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "München"
  };

  assert.notEqual(
    jobIdentityKey(jobA),
    jobIdentityKey(jobB)
  );
});

test("sameJob matches an applied job even when IDs differ", () => {
  const appliedJob = {
    id: "old-source-123",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  const discoveredJob = {
    id: "new-source-999",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  assert.equal(
    sameJob(appliedJob, discoveredJob),
    true
  );
});

test("sameJob does not match jobs in different locations", () => {
  const jobA = {
    id: "source-a-123",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  const jobB = {
    id: "source-b-999",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "München"
  };

  assert.equal(
    sameJob(jobA, jobB),
    false
  );
});


test("findMatchingApplication finds an applied job when the source ID changes", () => {
  const applications = [
    {
      id: "old-source-123",
      status: "applied",
      title: "Junior Frontend Developer",
      company: "Stampay GmbH",
      location: "Augsburg"
    }
  ];

  const discoveredJob = {
    id: "new-source-999",
    title: "Junior Frontend Developer",
    company: "Stampay GmbH",
    location: "Augsburg"
  };

  const match = findMatchingApplication(discoveredJob, applications);

  assert.equal(match.status, "applied");
  assert.equal(match.id, "old-source-123");
});

