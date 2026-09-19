function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function jobIdentityKey(job) {
  const title = normalizeText(job.title);
  const company = normalizeText(job.company);
  const location = normalizeText(job.location);

  return `${title}|${company}|${location}`;
}

function sameJob(jobA, jobB) {
  if (!jobA || !jobB) return false;

  if (jobA.id && jobB.id && jobA.id === jobB.id) {
    return true;
  }

  return jobIdentityKey(jobA) === jobIdentityKey(jobB);
}


function findMatchingApplication(job, applications) {
  return applications.find(application =>
    sameJob(job, application)
  );
}

module.exports = {
  normalizeText,
  jobIdentityKey,
  sameJob,
  findMatchingApplication
};