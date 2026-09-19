const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const {
  jobIdentityKey,
  sameJob,
  findMatchingApplication
} = require("./lib/job-identity");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");
const APPLICATIONS_PATH = path.join(ROOT, "data", "applications.json");
const COMPANY_SOURCES_PATH = path.join(ROOT, "company-sources.json");
const DISCOVERED_COMPANIES_PATH = path.join(ROOT, "data", "discovered-companies.json");
const COMPANY_MONITOR_PATH = path.join(ROOT, "data", "company-monitor.json");
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

const BA_BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs";
const BA_KEY = "jobboerse-jobsuche";
const BA_DETAILS_BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails";

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  res.writeHead(200, {"Content-Type": types[ext] || "application/octet-stream"});
  fs.createReadStream(filePath).pipe(res);
}

function normalizeJob(job, searchName, category = "tech") {
  const place = job.arbeitsort || job.arbeitsorte?.[0] || job.location || {};
  const title = job.beruf || job.stellenangebotsTitel || job.titel || job.title || "Untitled job";
  const ref = job.referenznummer || job.refnr || job.referenceNumber || "";
  const externalUrl = job.externeUrl || null;
  const baUrl = ref
    ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`
    : "https://www.arbeitsagentur.de/jobsuche/";

  return {
    id: ref || job.hashId || `${title}-${job.arbeitgeber || ""}-${place.ort || ""}`,
    title,
    company:
      job.arbeitgeber ||
      job.arbeitgeberName ||
      job.firma ||
      job.unternehmen ||
      job.company ||
      job.kundennamen ||
      "Unknown employer",
    location: [place.ort || place.city, place.plz || place.postalCode].filter(Boolean).join(" "),
    published: job.aktuelleVeroeffentlichungsdatum || job.veroeffentlichungsdatum || job.veroeffentlichtAm || job.published || null,
    startDate: job.eintrittsdatum || null,
    source: "Bundesagentur für Arbeit",
    sourceSearch: searchName,
    category,
    url: externalUrl || baUrl,
    externalUrl,
    raw: job,
    sourcePresence: {baListed: true, checkedAt: new Date().toISOString()}
  };
}

function scoreJob(job, prefs) {
  const text = `${job.title} ${job.company} ${job.location}`.toLowerCase();
  let score = 35;
  const reasons = [];

  if (job.category === "delivery") {
    let deliveryScore = 45;
    const matched = [];
    for (const kw of (prefs.deliveryKeywords || [])) {
      if (text.includes(String(kw).toLowerCase())) {
        deliveryScore += 8;
        matched.push(kw);
      }
    }
    if (/fahrrad|bike|bicycle|rad/i.test(text)) {
      deliveryScore += 15;
      matched.push("bike");
    }
    if (/auto|führerschein|fuehrerschein|pkw|lkw/i.test(text) && !/fahrrad|bike|rad/i.test(text)) {
      deliveryScore -= 20;
      reasons.push("- يبدو أنها تحتاج سيارة/رخصة");
    }
    if (matched.length) reasons.push(`Delivery: ${[...new Set(matched)].slice(0,6).join(", ")}`);
    return {score: Math.max(0, Math.min(100, deliveryScore)), reasons};
  }

  let cvProfile = {skills: [], targetKeywords: []};
  try {
    cvProfile = readJSON(path.join(ROOT, "cv-profile.json"));
  } catch (_) {}

  const cvTerms = [...(cvProfile.skills || []), ...(cvProfile.targetKeywords || [])];
  const matchedCvTerms = [];
  for (const term of cvTerms) {
    if (text.includes(String(term).toLowerCase())) {
      if (!matchedCvTerms.includes(term)) matchedCvTerms.push(term);
    }
  }

  if (matchedCvTerms.length) {
    score += Math.min(35, matchedCvTerms.length * 7);
    reasons.push(`CV: ${matchedCvTerms.slice(0, 6).join(", ")}`);
  }

  for (const kw of prefs.preferredKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score += 8;
      reasons.push(`+ ${kw}`);
    }
  }
  for (const kw of prefs.excludeKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score -= 25;
      reasons.push(`- ${kw}`);
    }
  }
  for (const kw of prefs.includeKeywords || []) {
    if (text.includes(kw.toLowerCase())) {
      score += 4;
    }
  }
  score = Math.max(0, Math.min(100, score));
  return {score, reasons};
}

async function searchBA(search, prefs) {
  const url = new URL(BA_BASE);
  url.searchParams.set("was", search.query);
  url.searchParams.set("wo", search.location);
  url.searchParams.set("umkreis", String(search.radiusKm || 25));
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "50");
  url.searchParams.set("angebotsart", "1");
  if (search.publishedWithinDays) {
    url.searchParams.set("veroeffentlichtseit", String(search.publishedWithinDays));
  }

  const response = await fetch(url, {
    headers: {
      "X-API-Key": BA_KEY,
      "Accept": "application/json",
      "User-Agent": "personal-job-agent/0.1"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bundesagentur API ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();

  // BA has used different response shapes across endpoint versions.
  // Detect the first plausible array instead of assuming one field name.
  const candidates = [
    data.stellenangebote,
    data.jobs,
    data.jobangebote,
    data.ergebnisse,
    data.results,
    data.items,
    data._embedded?.jobs,
    data._embedded?.stellenangebote
  ];
  let offers = candidates.find(Array.isArray);

  if (!offers) {
    const firstArrayKey = Object.keys(data).find(k => Array.isArray(data[k]));
    offers = firstArrayKey ? data[firstArrayKey] : [];
  }

  const mapped = offers.map(j => {
    const normalized = normalizeJob(j, search.name, search.category || "tech");
    return {...normalized, ...scoreJob(normalized, prefs)};
  });

  mapped._rawCount = offers.length;
  mapped._responseKeys = Object.keys(data).slice(0, 20);
  return mapped;
}


function flattenText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (typeof value === "object") return Object.values(value).map(flattenText).join(" ");
  return "";
}

function classifyGermanRequirement(detail) {
  const text = flattenText(detail).replace(/\s+/g, " ").toLowerCase();

  const hardHigh = [
    /\bdeutsch.{0,35}\bb2\b/i,
    /\bb2.{0,35}\bdeutsch/i,
    /\bdeutsch.{0,35}\bc1\b/i,
    /\bc1.{0,35}\bdeutsch/i,
    /\bdeutsch.{0,35}\bc2\b/i,
    /\bc2.{0,35}\bdeutsch/i,
    /sehr gute deutschkenntnisse/i,
    /fließende deutschkenntnisse/i,
    /fliessende deutschkenntnisse/i,
    /fließend deutsch/i,
    /fliessend deutsch/i,
    /verhandlungssicher.{0,20}deutsch/i,
    /deutsch.{0,20}verhandlungssicher/i
  ];

  const optionalGerman = [
    /deutsch.{0,30}(von vorteil|wünschenswert|wuenschenswert|nice to have|optional)/i,
    /(von vorteil|wünschenswert|wuenschenswert|nice to have|optional).{0,30}deutsch/i,
    /german.{0,30}(plus|advantage|preferred|optional|nice to have)/i
  ];

  const noGerman = [
    /keine deutschkenntnisse erforderlich/i,
    /deutschkenntnisse nicht erforderlich/i,
    /no german required/i,
    /german not required/i
  ];

  const english = /\benglish\b|englisch/i.test(text);

  if (noGerman.some(r => r.test(text))) {
    return {code:"no_german", label:"لا تشترط الألمانية", penalty:0, bonus:20, englishFriendly:true};
  }
  if (hardHigh.some(r => r.test(text))) {
    return {code:"b2_plus", label:"ألمانية قوية / B2+ محتملة", penalty:30, bonus:0, englishFriendly:false};
  }
  if (optionalGerman.some(r => r.test(text))) {
    return {code:"optional", label:"الألمانية ميزة إضافية", penalty:0, bonus:15, englishFriendly:true};
  }

  const requiresGerman = /deutschkenntnisse.{0,25}(erforderlich|vorausgesetzt|notwendig)|gute deutschkenntnisse/i.test(text);
  if (requiresGerman) {
    return {code:"required_unspecified", label:"الألمانية مطلوبة (المستوى غير واضح)", penalty:10, bonus:0, englishFriendly:false};
  }

  if (english) {
    return {code:"english_present", label:"الإنجليزية مذكورة ولا يوجد B2+ واضح", penalty:0, bonus:7, englishFriendly:true};
  }
  return {code:"unknown", label:"متطلب اللغة غير واضح", penalty:0, bonus:0, englishFriendly:false};
}

async function fetchJobDetails(ref) {
  if (!ref) return null;
  const encoded = Buffer.from(String(ref), "utf8").toString("base64");
  const url = `${BA_DETAILS_BASE}/${encodeURIComponent(encoded)}`;
  let response = await fetch(url, {
    headers: {
      "X-API-Key": BA_KEY,
      "Accept": "application/json",
      "User-Agent": "personal-job-agent/0.8"
    }
  });

  if (!response.ok) {
    const v3 = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v3/jobdetails/${encodeURIComponent(encoded)}`;
    response = await fetch(v3, {
      headers: {
        "X-API-Key": BA_KEY,
        "Accept": "application/json",
        "User-Agent": "personal-job-agent/0.8"
      }
    });
  }
  if (!response.ok) return null;
  return await response.json();
}

async function enrichLanguage(jobs, limit = 60) {
  const target = jobs.slice(0, limit);
  const results = await runInBatches(target, 4, async job => {
    const detail = await fetchJobDetails(job.id);
    if (!detail) return {...job, language: {code:"unknown", label:"تعذر تحليل اللغة", penalty:0, bonus:0, englishFriendly:false}};
    const language = classifyGermanRequirement(detail);
    const newScore = Math.max(0, Math.min(100, (job.score || 0) - language.penalty + language.bonus));
    return {...job, score: newScore, language};
  });

  const enriched = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : target[i]
  );
  return [...enriched, ...jobs.slice(limit)];
}


function findEmails(text) {
  const matches = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches)];
}

function findUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return [...new Set(matches.map(x => x.replace(/[),.;]+$/, "")))];
}

function extractApplicationInfo(detail) {
  const text = flattenText(detail).replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const emails = findEmails(text);
  const urls = findUrls(text).filter(u => !u.includes("arbeitsagentur.de"));

  let method = "unknown";
  if (emails.length && /(bewerbung|bewerben|application|apply|per e-mail|per email|e-mail)/i.test(text)) {
    method = "email";
  } else if (urls.length && /(bewerben|karriere|career|apply|application)/i.test(text)) {
    method = "website";
  } else if (emails.length) {
    method = "email_possible";
  } else if (urls.length) {
    method = "website_possible";
  }

  const requestedDocs = [];
  if (/anschreiben|cover letter/i.test(text)) requestedDocs.push("Anschreiben");
  if (/lebenslauf|curriculum vitae|\bcv\b/i.test(text)) requestedDocs.push("Lebenslauf");
  if (/zeugnis|zeugnisse|certificate/i.test(text)) requestedDocs.push("Zeugnisse");

  return {
    method,
    emails: emails.slice(0, 5),
    urls: urls.slice(0, 5),
    requestedDocs: [...new Set(requestedDocs)],
    language: classifyGermanRequirement(detail)
  };
}

function makeApplicationDraft(job, detail, profile, info) {
  const skills = profile.skills || [];
  const detailTextRaw = flattenText(detail).replace(/\s+/g, " ");
  const detailText = detailTextRaw.toLowerCase();
  const matchedSkills = skills.filter(s => detailText.includes(String(s).toLowerCase()));
  const strongest = matchedSkills.slice(0, 4);

  const isDelivery = job.category === "delivery" ||
    /ausliefer|lieferfahrer|kurier|fahrradkurier|rider|delivery|zustell/i.test(`${job.title} ${detailTextRaw}`);
  const isTech = !isDelivery && /frontend|react|javascript|typescript|webentwick|software|developer|entwickler|mobile/i.test(`${job.title} ${detailTextRaw}`);

  const facts = {
    bicycle: /\bfahrrad\b|e-bike|ebike|bike courier|mit dem rad/i.test(detailText),
    partTime: /teilzeit|part[- ]?time/i.test(detailText),
    flexible: /flexib|schichten|arbeitszeiten/i.test(detailText),
    careerChanger: /quereinsteiger|career changer|keine vorerfahrung|no experience/i.test(detailText),
    customer: /kunden|kundenfreund|customer/i.test(detailText),
    immediate: /ab sofort|sofortiger eintritt|immediately/i.test(detailText),
    teamwork: /teamorient|teamfähig|teamfaehig|teamwork/i.test(detailText),
    independent: /eigenständig|eigenstaendig|selbstständig|selbststaendig|independent/i.test(detailText),
    remote: /remote|homeoffice|home office/i.test(detailText)
  };

  let paragraphs = [];

  if (isDelivery) {
    let why = [];
    if (facts.bicycle) why.push("die Möglichkeit, die Auslieferungen mit dem Fahrrad durchzuführen");
    if (facts.partTime) why.push("die angebotene Teilzeitbeschäftigung");
    if (facts.flexible) why.push("die flexiblen Arbeitszeiten");
    if (facts.careerChanger) why.push("die Möglichkeit zum Quereinstieg");

    paragraphs.push(
      `mit Interesse habe ich Ihre Stellenausschreibung als ${job.title} gelesen und möchte mich gerne auf diese Position bewerben.`
    );

    if (why.length) {
      paragraphs.push(`Besonders ansprechend finde ich ${why.slice(0,3).join(", ")}.`);
    }

    let fit = [];
    if (facts.customer) fit.push("kundenfreundlich");
    fit.push("zuverlässig");
    if (facts.independent) fit.push("eigenständig");
    paragraphs.push(`Ich bin motiviert, ${fit.join(", ")} zu arbeiten und die Bestellungen bzw. Waren sicher an die Kunden auszuliefern.`);

  } else if (isTech) {
    paragraphs.push(
      `mit Interesse habe ich Ihre Stellenausschreibung als ${job.title} gelesen und möchte mich gerne auf diese Position bewerben.`
    );

    if (strongest.length) {
      paragraphs.push(
        `Besonders passend zu der ausgeschriebenen Position sind meine Kenntnisse in ${strongest.join(", ")}. Diese Kenntnisse möchte ich gerne praktisch einbringen und weiter vertiefen.`
      );
    } else {
      paragraphs.push(
        "Die ausgeschriebene Position spricht mich besonders an, weil ich meine bisherigen Kenntnisse in der Software- und Webentwicklung praktisch einsetzen und gezielt weiterentwickeln möchte."
      );
    }

    let interest = [];
    if (facts.remote) interest.push("die angebotene Remote-/Homeoffice-Möglichkeit");
    if (facts.partTime) interest.push("die Möglichkeit einer Teilzeitbeschäftigung");
    if (interest.length) paragraphs.push(`Zusätzlich finde ich ${interest.join(" und ")} besonders interessant.`);

  } else {
    paragraphs.push(
      `mit Interesse habe ich Ihre Stellenausschreibung als ${job.title} gelesen und möchte mich gerne auf diese Position bewerben.`
    );
    paragraphs.push(
      "Die beschriebenen Aufgaben sprechen mich an, und ich bin motiviert, mich zuverlässig einzuarbeiten und meine bisherigen Erfahrungen sinnvoll einzubringen."
    );
  }

  const docs = info.requestedDocs || [];
  let closing;
  if (docs.includes("Lebenslauf")) {
    closing = "Meinen Lebenslauf finden Sie im Anhang. Über eine Rückmeldung und die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.";
  } else {
    closing = "Gerne sende ich Ihnen meinen Lebenslauf und weitere Unterlagen zu. Über eine Rückmeldung und die Gelegenheit zu einem persönlichen Gespräch freue ich mich sehr.";
  }

  const subject = `Bewerbung als ${job.title}`;
  const body = [
    "Sehr geehrte Damen und Herren,",
    "",
    ...paragraphs.flatMap(p => [p, ""]),
    closing,
    "",
    "Mit freundlichen Grüßen",
    profile.name || "Example Developer"
  ].join("\n");

  const usedFacts = [];
  if (facts.bicycle) usedFacts.push("Fahrrad");
  if (facts.partTime) usedFacts.push("Teilzeit");
  if (facts.flexible) usedFacts.push("flexible Arbeitszeiten");
  if (facts.careerChanger) usedFacts.push("Quereinstieg");
  if (facts.remote) usedFacts.push("Remote/Homeoffice");

  return {
    subject,
    body,
    matchedSkills: strongest,
    usedJobFacts: usedFacts,
    detectedCategory: isDelivery ? "delivery" : (isTech ? "tech" : "general"),
    attachment: profile.sourceFile || "cv/example-cv.pdf",
    note: "Entwurf aus der konkreten Stellenbeschreibung. Bitte vor dem Senden prüfen."
  };
}

async function analyzeApplication(job) {
  let detail = null;
  if (String(job.id || "").startsWith("gh:") || String(job.id || "").startsWith("lever:") || String(job.id || "").startsWith("startup:")) {
    detail = {description: job.description || "", url: job.url || "", externalUrl: job.externalUrl || ""};
  } else {
    detail = await fetchJobDetails(job.id);
  }
  if (!detail) {
    return {
      ok: false,
      error: "تعذر جلب تفاصيل الإعلان من المصدر.",
      job
    };
  }
  const profile = readJSON(path.join(ROOT, "cv-profile.json"));
  const info = extractApplicationInfo(detail);
  const applicationStatus = await checkApplicationUrl(job.externalUrl || job.url || "");
  const fit = assessJobFit(job, detail, profile);
  const draft = makeApplicationDraft(job, detail, profile, info);
  return {ok:true, job, info, draft, applicationStatus, fit};
}


const TARGET_CITIES = ["ingolstadt", "münchen", "munich", "nürnberg", "nuremberg", "augsburg"];
const TECH_TERMS = [
  "frontend", "front-end", "react", "react native", "javascript", "typescript",
  "web developer", "webentwickler", "ui developer", "ui engineer",
  "mobile developer", "software engineer", "software developer"
];

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isRelevantExternalJob(title, location, description = "") {
  const t = `${title} ${description}`.toLowerCase();
  const loc = String(location || "").toLowerCase();
  const tech = TECH_TERMS.some(x => t.includes(x));
  const city = TARGET_CITIES.some(x => loc.includes(x));
  const remoteGermany = /remote/i.test(loc) && /germany|deutschland|europe|eu/i.test(`${loc} ${t}`);
  return tech && (city || remoteGermany);
}

function scoreExternalJob(job, prefs, description = "") {
  let base = scoreJob(job, prefs);
  const text = `${job.title} ${description}`.toLowerCase();
  if (/\bsenior\b|\bstaff\b|\blead\b|\bprincipal\b|\bhead\b/.test(text)) base.score -= 25;
  if (/\bjunior\b|\bentry\b|working student|werkstudent/.test(text)) base.score += 12;
  base.score = Math.max(0, Math.min(100, base.score));
  return base;
}

async function searchGreenhouseBoards(prefs) {
  let cfg = {greenhouse:[]};
  try { cfg = readJSON(COMPANY_SOURCES_PATH); } catch (_) {}
  const jobs = [];
  const errors = [];

  for (const board of (cfg.greenhouse || []).filter(x => x.enabled !== false)) {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
      const response = await fetch(url, {headers: {"Accept":"application/json","User-Agent":"personal-job-agent/1.1"}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const j of (data.jobs || [])) {
        const location = j.location?.name || "";
        const description = htmlToText(j.content || "");
        if (!isRelevantExternalJob(j.title, location, description)) continue;
        const job = {
          id: `gh:${board.token}:${j.id}`,
          title: j.title || "Untitled job",
          company: board.name,
          location,
          published: j.updated_at || null,
          source: `Career Page · Greenhouse`,
          sourceSearch: board.name,
          category: "tech",
          url: j.absolute_url || `https://boards.greenhouse.io/${board.token}/jobs/${j.id}`,
          externalUrl: j.absolute_url || null,
          description
        };
        jobs.push({...job, ...scoreExternalJob(job, prefs, description),
          language: classifyGermanRequirement({description})});
      }
    } catch (e) {
      errors.push({source:`Greenhouse · ${board.name}`, error:e.message});
    }
  }
  return {jobs, errors};
}

async function searchLeverBoards(prefs) {
  let cfg = {lever:[]};
  try { cfg = readJSON(COMPANY_SOURCES_PATH); } catch (_) {}
  const jobs = [];
  const errors = [];

  for (const board of (cfg.lever || []).filter(x => x.enabled !== false)) {
    try {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board.site)}?mode=json`;
      const response = await fetch(url, {headers: {"Accept":"application/json","User-Agent":"personal-job-agent/1.1"}});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const j of (Array.isArray(data) ? data : [])) {
        const location = j.categories?.location || "";
        const description = htmlToText(`${j.description || ""} ${j.additional || ""} ${j.descriptionPlain || ""}`);
        if (!isRelevantExternalJob(j.text, location, description)) continue;
        const job = {
          id: `lever:${board.site}:${j.id}`,
          title: j.text || "Untitled job",
          company: board.name,
          location,
          published: j.createdAt ? new Date(j.createdAt).toISOString() : null,
          source: `Career Page · Lever`,
          sourceSearch: board.name,
          category: "tech",
          url: j.hostedUrl || j.applyUrl || j.urls?.show || `https://jobs.lever.co/${board.site}/${j.id}`,
          externalUrl: j.applyUrl || j.urls?.apply || null,
          description,
          commitment: j.categories?.commitment || null,
          workplaceType: j.workplaceType || null
        };
        jobs.push({...job, ...scoreExternalJob(job, prefs, description),
          language: classifyGermanRequirement({description})});
      }
    } catch (e) {
      errors.push({source:`Lever · ${board.name}`, error:e.message});
    }
  }
  return {jobs, errors};
}

function extractXmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return htmlToText(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

async function searchStartupJobsRss(prefs) {
  let cfg = {};
  try { cfg = readJSON(COMPANY_SOURCES_PATH); } catch (_) {}
  const rss = cfg.startupJobsRss || {};
  if (rss.enabled === false || !rss.url) return {jobs:[], errors:[]};
  try {
    const response = await fetch(rss.url, {headers: {"User-Agent":"personal-job-agent/1.1"}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    const jobs = [];
    for (const item of items) {
      const title = extractXmlTag(item, "title");
      const link = extractXmlTag(item, "link");
      const description = extractXmlTag(item, "description");
      const location = extractXmlTag(item, "location") || extractXmlTag(item, "job_location") || description;
      if (!isRelevantExternalJob(title, location, description)) continue;
      const company = extractXmlTag(item, "author") || extractXmlTag(item, "company") || "Startup";
      const guid = extractXmlTag(item, "guid") || link || title;
      const job = {
        id: `startup:${guid}`,
        title, company, location: location.slice(0, 140),
        published: extractXmlTag(item, "pubDate") || null,
        source: "Startup Jobs",
        sourceSearch: "Startup Jobs · Engineering",
        category: "tech",
        url: link,
        externalUrl: link,
        description
      };
      jobs.push({...job, ...scoreExternalJob(job, prefs, description),
        language: classifyGermanRequirement({description})});
    }
    return {jobs, errors:[]};
  } catch (e) {
    return {jobs:[], errors:[{source:"Startup Jobs RSS", error:e.message}]};
  }
}

async function searchExternalSources(prefs) {
  const [gh, lever, startup, generic] = await Promise.all([
    searchGreenhouseBoards(prefs),
    searchLeverBoards(prefs),
    searchStartupJobsRss(prefs),
    searchGenericDiscoveredCareerPages(prefs)
  ]);
  return {
    jobs: [...gh.jobs, ...lever.jobs, ...startup.jobs, ...generic.jobs],
    errors: [...gh.errors, ...lever.errors, ...startup.errors, ...generic.errors]
  };
}


const DISCOVERY_CITIES = ["Ingolstadt", "München", "Nürnberg", "Augsburg"];
const CAREER_WORDS = ["career", "careers", "karriere", "jobs", "stellenangebote", "stellen", "vacancies", "join-us", "joinus", "join us", "work with us", "offene stellen", "job openings", "jobangebote", "jobportal"];
const IT_NAME_WORDS = [
  "software", "digital", "tech", "technology", "it ", " it", "informatik", "systems",
  "solutions", "developer", "development", "web", "data", "cloud", "cyber", "engineering"
];

function normalizeWebsite(url) {
  if (!url) return null;
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function sameHost(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, "");
    const hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`);
  } catch (_) {
    return false;
  }
}

function decodeBasicEntities(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function extractAnchors(html, baseUrl) {
  const anchors = [];
  const rx = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(String(html || "")))) {
    try {
      const href = new URL(decodeBasicEntities(m[1]), baseUrl).toString();
      const text = htmlToText(decodeBasicEntities(m[2]));
      anchors.push({href, text});
    } catch (_) {}
  }
  return anchors;
}

function looksLikeCareerLink(anchor) {
  const s = `${anchor.text} ${anchor.href}`.toLowerCase();
  return CAREER_WORDS.some(w => s.includes(w));
}

function looksLikeTechCompany(tags) {
  const blob = `${tags.name || ""} ${tags.company || ""} ${tags.office || ""} ${tags.description || ""} ${tags["computer:software"] || ""} ${tags.consulting || ""}`.toLowerCase();
  return tags.office === "it" ||
    ["it","software","software_development","startup"].includes(tags.company) ||
    IT_NAME_WORDS.some(w => blob.includes(w));
}

function parseKnownAts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);

    if (host.includes("greenhouse.io") || host.includes("greenhouse.com")) {
      // Common forms: boards.greenhouse.io/<token>, job-boards.greenhouse.io/<token>
      const token = parts[0];
      if (token) return {type:"greenhouse", key:token};
    }
    if (host === "jobs.lever.co" || host.endsWith(".lever.co")) {
      const site = parts[0];
      if (site) return {type:"lever", key:site};
    }
    if (host.includes("teamtailor.com")) return {type:"teamtailor", key:host};
    if (host.includes("personio.") || host.includes("jobs.personio.")) return {type:"personio", key:host};
    if (host.includes("workdayjobs.com") || host.includes("myworkdayjobs.com")) return {type:"workday", key:host};
    if (host.includes("smartrecruiters.com")) return {type:"smartrecruiters", key:host};
    if (host.includes("recruitee.com")) return {type:"recruitee", key:host};
    if (host.includes("softgarden.io") || host.includes("softgarden.de")) return {type:"softgarden", key:host};
  } catch (_) {}
  return null;
}

async function fetchTextSafe(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 PersonalJobAgent/1.2",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    if (!r.ok) return {ok:false, status:r.status, url:r.url || url, text:""};
    const type = r.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      return {ok:false, status:r.status, url:r.url || url, text:""};
    }
    const text = await r.text();
    return {ok:true, status:r.status, url:r.url || url, text:text.slice(0, 2_000_000)};
  } catch (e) {
    return {ok:false, status:0, url, text:"", error:e.message};
  } finally {
    clearTimeout(timer);
  }
}

async function discoverCareerPage(website) {
  const home = await fetchTextSafe(website, 4500);
  if (!home.ok) return {careerUrl:null, ats:null, reason:"homepage_unreachable"};

  const anchors = extractAnchors(home.text, home.url);
  const candidates = anchors.filter(looksLikeCareerLink);

  for (const a of candidates) {
    const ats = parseKnownAts(a.href);
    if (ats) return {careerUrl:a.href, ats, reason:"ats_link"};
  }

  const same = candidates.find(a => sameHost(a.href, home.url));
  if (same) return {careerUrl:same.href, ats:parseKnownAts(same.href), reason:"same_domain"};

  // Probe only the most common paths, concurrently, to keep discovery responsive.
  const guesses = ["/karriere", "/jobs", "/careers", "/stellenangebote", "/jobs-und-karriere", "/unternehmen/karriere", "/de/karriere", "/career"].map(p => {
    try { return new URL(p, home.url).toString(); } catch (_) { return null; }
  }).filter(Boolean);

  const probes = await Promise.allSettled(
    guesses.map(url => fetchTextSafe(url, 3500))
  );

  for (const p of probes) {
    if (p.status !== "fulfilled") continue;
    const r = p.value;
    if (r.ok && /job|karriere|career|stellen|vacanc/i.test(htmlToText(r.text))) {
      return {careerUrl:r.url, ats:parseKnownAts(r.url), reason:"common_path"};
    }
  }

  return {careerUrl:null, ats:null, reason:"not_found"};
}

async function discoverCityCompanies(city) {
  const query = `
[out:json][timeout:35];
area["name"="${city}"]["boundary"="administrative"]->.a;
(
  nwr["office"="it"](area.a);
  nwr["company"~"^(it|software|software_development|startup)$"](area.a);
  nwr["office"="company"]["website"](area.a);
);
out center tags;
`;

  let response = null;
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      response = await fetch(endpoint, {
        method:"POST",
        signal: controller.signal,
        headers:{
          "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":"personal-job-agent/1.7"
        },
        body:new URLSearchParams({data:query})
      });
      clearTimeout(timer);
      if (response.ok) break;
      lastError = new Error(`Overpass ${response.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  if (!response || !response.ok) throw (lastError || new Error("Overpass unavailable"));
  const data = await response.json();

  const out = [];
  for (const el of (data.elements || [])) {
    const tags = el.tags || {};
    if (!looksLikeTechCompany(tags)) continue;
    const website = normalizeWebsite(tags.website || tags["contact:website"]);
    if (!website || !tags.name) continue;
    out.push({
      name: tags.name,
      city,
      website,
      osmType: el.type,
      osmId: el.id
    });
  }

  const uniq = new Map();
  for (const x of out) {
    const key = `${x.name}|${x.website}`.toLowerCase();
    if (!uniq.has(key)) uniq.set(key, x);
  }
  return [...uniq.values()];
}



function classifyDiscoveredCompany(company) {
  const blob = `${company.name || ""} ${company.website || ""}`.toLowerCase();

  const software = [
    "software","digital","informatik","it "," it","systems","solutions","data",
    "cloud","cyber","developer","development","web","app","technology","technologies",
    "consulting","engineering","automation","embedded","mobility","semiconductor"
  ];
  const nonIt = [
    "gebäudetechnik","gebaeudetechnik","brandschutz","dental","zahntechnik","fußboden",
    "fussboden","entwässerung","entwaesserung","heiztechnik","kanal","werbetechnik",
    "veranstaltungstechnik","personal training","glasfaser technik","schleiferei",
    "wiegetechnik","sicherheit","fahrten ferne abenteuer","film","autoankauf"
  ];

  let score = 0;
  for (const x of software) if (blob.includes(x)) score += 2;
  for (const x of nonIt) if (blob.includes(x)) score -= 5;

  let category = "uncertain";
  if (score >= 4) category = "software_it";
  else if (score >= 1) category = "technical_adjacent";
  else if (score <= -2) category = "non_it";

  return {score, category};
}

function normalizeCompanyNameForDedupe(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(gmbh|ag|se|ek|e\.k\.|ug|ohg|kg|co\.?\s*kg|gmbh\s*&\s*co\.?\s*kg|mbh)\b/g, " ")
    .replace(/[^a-z0-9äöüß]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDomain(url) {
  try {
    return new URL(normalizeWebsite(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

function discoveredCompanyKey(company) {
  const domain = normalizeDomain(company.website || "");
  const name = normalizeCompanyNameForDedupe(company.name);
  // Prefer domain because names can vary (BG Phoenics / BG-Phoenics).
  return domain ? `domain:${domain}` : `name:${name}|${String(company.city || "").toLowerCase()}`;
}

function mergeDiscoveredCompany(a, b) {
  const scoreCareer = x => x?.careerUrl ? 2 : 0;
  const primary = (scoreCareer(b) > scoreCareer(a)) ? b : a;
  const secondary = primary === a ? b : a;
  return {
    ...secondary,
    ...primary,
    name: primary.name || secondary.name,
    city: primary.city || secondary.city,
    website: primary.website || secondary.website,
    careerUrl: primary.careerUrl || secondary.careerUrl || null,
    ats: primary.ats || secondary.ats || null,
    lastChecked: primary.lastChecked || secondary.lastChecked || null
  };
}

function addAtsSource(company, discovered) {
  if (!discovered.ats) return false;
  let cfg = readJSON(COMPANY_SOURCES_PATH);
  let changed = false;

  if (discovered.ats.type === "greenhouse") {
    if (!Array.isArray(cfg.greenhouse)) cfg.greenhouse = [];
    if (!cfg.greenhouse.some(x => x.token === discovered.ats.key)) {
      cfg.greenhouse.push({name:company.name, token:discovered.ats.key, enabled:true, discovered:true});
      changed = true;
    }
  }
  if (discovered.ats.type === "lever") {
    if (!Array.isArray(cfg.lever)) cfg.lever = [];
    if (!cfg.lever.some(x => x.site === discovered.ats.key)) {
      cfg.lever.push({name:company.name, site:discovered.ats.key, enabled:true, discovered:true});
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(COMPANY_SOURCES_PATH, JSON.stringify(cfg, null, 2), "utf8");
  return changed;
}

async function discoverCompanies() {
  let existing = [];
  try { existing = readJSON(DISCOVERED_COMPANIES_PATH); } catch (_) {}
  const map = new Map(existing.map(x => [`${x.name}|${x.website}`.toLowerCase(), x]));

  const cityStats = [];
  let atsAdded = 0;
  for (const city of DISCOVERY_CITIES) {
    try {
      const companies = await discoverCityCompanies(city);
      let withCareer = 0;

      // Keep each click bounded: inspect up to 18 companies per city per run.
      // Already-known Career Pages are reused without another network crawl.
      const selected = companies.slice(0, 18);
      const pending = [];
      for (const company of selected) {
        const key = `${company.name}|${company.website}`.toLowerCase();
        const old = map.get(key);
        if (old?.careerUrl) {
          map.set(key, {...old, ...company, lastChecked:new Date().toISOString()});
          withCareer++;
        } else {
          pending.push(company);
        }
      }

      const inspected = await runInBatches(pending, 6, async company => {
        const career = await discoverCareerPage(company.website);
        return {company, career};
      });

      inspected.forEach(result => {
        if (result.status !== "fulfilled") return;
        const {company, career} = result.value;
        const key = `${company.name}|${company.website}`.toLowerCase();
        const old = map.get(key);
        const record = {
          ...(old || {}),
          ...company,
          careerUrl: career.careerUrl,
          ats: career.ats,
          discoveryReason: career.reason,
          lastChecked: new Date().toISOString()
        };
        map.set(key, record);
        if (career.careerUrl) withCareer++;
        if (addAtsSource(company, career)) atsAdded++;
      });

      // Save all companies we discovered from OSM, even if they were not crawled yet.
      for (const company of companies) {
        const key = `${company.name}|${company.website}`.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {...company, careerUrl:null, ats:null, discoveryReason:"not_checked_yet"});
        }
      }

      cityStats.push({
        city,
        found:companies.length,
        inspected:selected.length,
        withCareer
      });
    } catch (e) {
      cityStats.push({city, error:e.message, found:0, withCareer:0});
    }
  }

  const deduped = new Map();
  for (const company of map.values()) {
    const key = discoveredCompanyKey(company);
    if (!deduped.has(key)) deduped.set(key, company);
    else deduped.set(key, mergeDiscoveredCompany(deduped.get(key), company));
  }

  for (const [key, company] of deduped.entries()) {
    deduped.set(key, {...company, classification: classifyDiscoveredCompany(company)});
  }

  const all = [...deduped.values()].sort((a,b) =>
    String(a.city).localeCompare(String(b.city)) || String(a.name).localeCompare(String(b.name))
  );
  fs.writeFileSync(DISCOVERED_COMPANIES_PATH, JSON.stringify(all, null, 2), "utf8");

  return {
    companies: all,
    stats: cityStats,
    atsAdded,
    total: all.length,
    withCareer: all.filter(x => x.careerUrl).length
  };
}


function validateCareerJobLink(anchor, company) {
  const text = htmlToText(anchor.text || "").trim();
  const href = String(anchor.href || "");
  const blob = `${text} ${href}`.toLowerCase();

  const rejectText = [
    "return to top", "back to top", "protected email", "e-mail", "email",
    "kontakt", "contact", "über uns", "about us", "services", "leistungen",
    "chancen erkunden", "mehr erfahren", "read more", "learn more",
    "impressum", "datenschutz", "privacy", "newsletter", "social media",
    "home", "startseite", "karriere", "career", "jobs", "stellenangebote"
  ];

  if (!text || text.length < 4) return {ok:false, reason:"empty_or_short"};
  if (/^javascript:/i.test(href)) return {ok:false, reason:"javascript_link"};
  if (rejectText.some(x => text.toLowerCase() === x || text.toLowerCase().includes(x))) {
    return {ok:false, reason:"navigation_or_nonjob"};
  }

  const roleTerms = [
    "developer","entwickler","software","frontend","front-end","backend","fullstack","full-stack",
    "engineer","engineering","react","angular","javascript","typescript","web","mobile",
    "devops","cloud","data","qa","test","ux","ui","architect","administrator","consultant",
    "working student","werkstudent","praktikum","intern","trainee"
  ];
  const actionTerms = ["apply","bewerb","job","stelle","vacan","position","career","karriere"];

  const roleHit = roleTerms.some(t => blob.includes(t));
  const actionHit = actionTerms.some(t => href.toLowerCase().includes(t));

  // Strong signal: explicit role title; medium signal: role + job-like URL.
  if (roleHit && text.split(/\s+/).length >= 2) return {ok:true, confidence:"high"};
  if (roleHit && actionHit) return {ok:true, confidence:"medium"};

  return {ok:false, reason:"not_role_like"};
}

function isLikelyJobDetailPage(html, url) {
  const text = htmlToText(html).toLowerCase();
  const signals = [
    /aufgaben|responsibilities/,
    /anforderungen|requirements/,
    /wir bieten|what we offer/,
    /bewirb dich|jetzt bewerben|apply now/,
    /arbeitsort|location/,
    /vollzeit|teilzeit|full[- ]?time|part[- ]?time/
  ];
  return signals.filter(r => r.test(text)).length >= 2;
}

function genericCareerJobsFromHtml(company, html, baseUrl) {
  const anchors = extractAnchors(html, baseUrl);
  const jobs = [];

  for (const a of anchors) {
    const validation = validateCareerJobLink(a, company);
    if (!validation.ok) continue;

    jobs.push({
      id:`career:${company.name}:${a.href}`,
      title:htmlToText(a.text || "").trim(),
      company:company.name,
      location:company.city,
      published:null,
      source:"Career Page · Direct",
      sourceSearch:company.name,
      category:"tech",
      url:a.href,
      externalUrl:a.href,
      description:a.text || "",
      validationConfidence:validation.confidence || "medium"
    });
  }

  const uniq = new Map();
  for (const j of jobs) {
    const key = j.url.toLowerCase();
    if (!uniq.has(key)) uniq.set(key, j);
  }
  return [...uniq.values()].slice(0, 30);
}

async function searchGenericDiscoveredCareerPages(prefs) {
  let companies = [];
  try { companies = readJSON(DISCOVERED_COMPANIES_PATH); } catch (_) {}
  const jobs = [];
  const errors = [];

  const generic = companies
    .filter(c => c.careerUrl && !c.ats && c.classification?.category !== "non_it")
    .slice(0, 80);
  const results = await runInBatches(generic, 4, async company => {
    const r = await fetchTextSafe(company.careerUrl, 9000);

    if (!r.ok) {
      // A stale Career Page should not make the whole job search look broken.
      // 404/410 mean the saved Career URL is no longer valid.
      return {
        company,
        jobs: [],
        warning: {
          source: `Career Page · ${company.name || "company"}`,
          code: r.status || 0,
          error: [404,410].includes(r.status)
            ? "صفحة التوظيف المحفوظة لم تعد موجودة"
            : `تعذر فحص صفحة التوظيف (HTTP ${r.status || "?"})`
        }
      };
    }

    const candidates = genericCareerJobsFromHtml(company, r.text, r.url).slice(0, 12);
    const validated = [];
    for (const candidate of candidates) {
      const detail = await fetchTextSafe(candidate.url, 6000);
      if (!detail.ok) continue;
      if (!isLikelyJobDetailPage(detail.text, detail.url)) continue;

      const description = htmlToText(detail.text);
      validated.push({
        ...candidate,
        url: detail.url || candidate.url,
        externalUrl: detail.url || candidate.externalUrl,
        description,
        ...scoreExternalJob(candidate, prefs, description),
        language: classifyGermanRequirement({description})
      });
    }

    return {
      company,
      jobs: validated,
      warning: null
    };
  });

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      jobs.push(...(r.value.jobs || []));
      if (r.value.warning) errors.push({...r.value.warning, severity:"warning"});
    } else {
      errors.push({
        source:`Career Page · ${generic[i]?.name || "company"}`,
        error:r.reason?.message || String(r.reason),
        severity:"warning"
      });
    }
  });
  return {jobs, errors};
}


function detectApplicationPageStatus(html, finalUrl = "") {
  const text = htmlToText(html).toLowerCase();

  const closedPatterns = [
    /job ad is no longer active/i,
    /job is no longer active/i,
    /job posting is no longer active/i,
    /this job is no longer available/i,
    /position is no longer available/i,
    /vacancy is no longer available/i,
    /stellenanzeige.{0,40}nicht mehr aktuell/i,
    /stelle.{0,40}nicht mehr verfügbar/i,
    /stellenangebot.{0,40}nicht mehr verfügbar/i,
    /anzeige.{0,40}abgelaufen/i,
    /stellenanzeige.{0,40}abgelaufen/i,
    /job.{0,40}abgelaufen/i,
    /position.{0,40}besetzt/i,
    /stelle.{0,40}besetzt/i,
    /wir haben bereits.{0,40}kandidat/i,
    /we have found.{0,40}candidate/i,
    /application period.{0,40}closed/i,
    /applications.{0,40}closed/i
  ];

  const openPatterns = [
    /jetzt bewerben/i,
    /bewirb dich jetzt/i,
    /apply now/i,
    /submit application/i,
    /bewerbung absenden/i,
    /application form/i
  ];

  if (closedPatterns.some(r => r.test(text))) {
    return {code:"closed", label:"التقديم مغلق", finalUrl};
  }
  if (openPatterns.some(r => r.test(text))) {
    return {code:"open", label:"التقديم مفتوح", finalUrl};
  }
  return {code:"unknown", label:"حالة التقديم غير واضحة", finalUrl};
}

async function checkApplicationUrl(url) {
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return {code:"unknown", label:"لا يوجد رابط تقديم مباشر", confidence:"low", evidence:["no_direct_url"]};
  }
  const r = await fetchTextSafe(url, 8000);
  if (!r.ok) {
    // A dead external URL is not proof that the vacancy itself is closed.
    // It can be a stale redirect, bot protection, or a changed ATS route.
    if ([404, 410].includes(r.status)) {
      return {code:"link_problem", label:`رابط التقديم يحتاج تحقق (HTTP ${r.status})`, confidence:"low", evidence:[`http_${r.status}`], finalUrl:r.url || url};
    }
    return {code:"unknown", label:`تعذر فحص الرابط (HTTP ${r.status || "?"})`, confidence:"low", evidence:["fetch_failed"], finalUrl:r.url || url};
  }
  const detected = detectApplicationPageStatus(r.text, r.url || url);
  return {...detected, confidence: detected.code === "closed" ? "medium" : detected.code === "open" ? "high" : "low", evidence:[`page_text_${detected.code}`]};
}

async function enrichApplicationStatus(jobs, limit = 60) {
  const target = jobs.filter(j => j.externalUrl || j.url).slice(0, limit);
  const checked = await runInBatches(target, 5, async job => {
    const candidateUrl = job.externalUrl || job.url;
    const webStatus = await checkApplicationUrl(candidateUrl);
    const baListed = job.source === "Bundesagentur für Arbeit" || job.sourcePresence?.baListed === true;
    let status = webStatus;

    // Source-of-truth rule: if BA returned the vacancy in THIS search run, do not
    // mark it closed merely because an external application URL is 404/410.
    if (baListed && webStatus.code === "link_problem") {
      status = {
        code:"open_source",
        label:"موجود حاليًا في Bundesagentur • رابط خارجي يحتاج تحقق",
        confidence:"high",
        evidence:["ba_listed_current_run", ...(webStatus.evidence || [])],
        finalUrl:webStatus.finalUrl
      };
    } else if (baListed && webStatus.code === "unknown") {
      status = {
        code:"open_source",
        label:"موجود حاليًا في Bundesagentur",
        confidence:"high",
        evidence:["ba_listed_current_run", ...(webStatus.evidence || [])],
        finalUrl:webStatus.finalUrl
      };
    } else if (baListed && webStatus.code === "closed") {
      // Conflicting evidence must be surfaced, never silently converted to expired.
      status = {
        code:"conflict",
        label:"تعارض: الإعلان موجود في Bundesagentur لكن صفحة التقديم تبدو مغلقة",
        confidence:"medium",
        evidence:["ba_listed_current_run", ...(webStatus.evidence || [])],
        finalUrl:webStatus.finalUrl
      };
    }

    let score = job.score || 0;
    if (status.code === "closed" && !baListed) score = Math.max(0, score - 45);
    if (["open","open_source"].includes(status.code)) score = Math.min(100, score + 4);
    return {...job, applicationStatus:status, validationConfidence:status.confidence, score};
  });

  const byId = new Map();
  checked.forEach((r, i) => { if (r.status === "fulfilled") byId.set(target[i].id, r.value); });
  return jobs.map(job => byId.get(job.id) || {...job, applicationStatus:job.applicationStatus || {code:"unknown", label:"غير مفحوص", confidence:"low"}});
}


function termPresent(text, term) {
  return String(text || "").toLowerCase().includes(String(term || "").toLowerCase());
}

function extractRequirements(detail) {
  const text = flattenText(detail).replace(/\s+/g, " ");
  const lower = text.toLowerCase();

  const techTerms = [
    "react native","react","angular","javascript","typescript","html5","html","css3","css",
    "rest","rest-webservices","sass","less","postcss","git","scrum","kanban","next.js","node.js",
    "aws","azure","kubernetes","docker"
  ];
  const foundTech = techTerms.filter(t => termPresent(lower, t));

  const experience = {
    senior: /\b(senior|lead|principal|staff|tech lead|team lead)\b/i.test(text),
    junior: /\b(junior|entry[- ]?level|berufseinsteiger|graduate|trainee)\b/i.test(text),
    careerChanger: /quereinsteiger|career changer|keine vorerfahrung|no experience|ohne berufserfahrung/i.test(text),
    years: [...text.matchAll(/(\d+)\s*(?:\+?\s*)?(?:jahre|years)/gi)].map(m => Number(m[1])).filter(Boolean),
    firstExperience: /erste.{0,35}erfahrung|erste berufserfahrung|relevante erfahrung|initial experience|erste praktische erfahrung/i.test(text),
    sideProjectsAccepted: /side projects?|private projects?|eigene projekte|persönliche projekte|personal projects?|coursework/i.test(text),
    openSourceAccepted: /open[ -]?source|github contributions?|contributions?/i.test(text),
    learningFocus: /lernbereitschaft|willingness to learn|einarbeitung|mentoring|mentor|weiterentwicklung|entwicklungsbereitschaft/i.test(text)
  };

  const education = {
    completedDegree: /abgeschlossenes studium|abgeschlossenes hochschulstudium|bachelor|master|degree/i.test(text),
    comparableQualification: /vergleichbare qualifikation|comparable qualification|vergleichbare kenntnisse|equivalent experience/i.test(text)
  };

  const language = classifyGermanRequirement(detail);

  return {
    techTerms: foundTech,
    experience,
    education,
    language,
    rawText: text
  };
}

function assessJobFit(job, detail, profile) {
  const req = extractRequirements(detail);
  const cvSkills = (profile.skills || []).map(x => String(x).toLowerCase());
  const cvTargets = (profile.targetKeywords || []).map(x => String(x).toLowerCase());
  const cvTerms = [...new Set([...cvSkills, ...cvTargets])];
  const targetSeniority = String(profile.targetSeniority || "junior").toLowerCase();
  const maxPreferredYears = Number.isFinite(Number(profile.maxPreferredYears)) ? Number(profile.maxPreferredYears) : 2;
  const evidence = Array.isArray(profile.experienceEvidence) ? profile.experienceEvidence : [];
  const hasOpenSource = evidence.some(x => String(x.type || x).toLowerCase().includes("open"));
  const hasProjects = evidence.some(x => /project|course|portfolio|open/i.test(String(x.type || x)));

  const requiredTech = req.techTerms;
  const matchedTech = [];
  const missingTech = [];

  for (const tech of requiredTech) {
    const aliases = {
      "html5":["html5","html"],
      "css3":["css3","css"],
      "react":["react","react native"],
      "rest-webservices":["rest","rest-webservices"],
      "aws":["aws"],
      "azure":["azure"],
      "kubernetes":["kubernetes"],
      "docker":["docker"]
    }[tech] || [tech];

    const matched = aliases.some(a => cvTerms.some(c => c === a || c.includes(a) || a.includes(c)));
    (matched ? matchedTech : missingTech).push(tech);
  }

  const techScore = requiredTech.length
    ? Math.round((matchedTech.length / requiredTech.length) * 100)
    : 60;

  let experienceScore = 70;
  const experienceNotes = [];
  const positiveSignals = [];
  const cautionSignals = [];

  if (req.experience.senior) {
    experienceScore = targetSeniority === "senior" ? 80 : 15;
    experienceNotes.push("Senior/Lead requirement");
    cautionSignals.push("Senior/Lead role");
  } else if (req.experience.years.length) {
    const minYears = Math.min(...req.experience.years);
    if (minYears >= 3 && minYears > maxPreferredYears) {
      experienceScore = 25;
      experienceNotes.push(`${minYears}+ years professional experience mentioned`);
      cautionSignals.push(`${minYears}+ years experience`);
    } else if (minYears > maxPreferredYears) {
      experienceScore = 45;
      experienceNotes.push(`${minYears} years experience mentioned`);
      cautionSignals.push(`${minYears} years experience`);
    } else {
      experienceScore = 65;
      experienceNotes.push(`${minYears} years experience mentioned`);
    }
  } else if (req.experience.firstExperience) {
    experienceScore = hasOpenSource || hasProjects ? 82 : 62;
    experienceNotes.push("erste/relevante Erfahrung");
    if (hasOpenSource) positiveSignals.push("open-source experience can support first-experience requirement");
    else if (hasProjects) positiveSignals.push("project experience can support first-experience requirement");
  } else if (req.experience.junior || req.experience.careerChanger) {
    experienceScore = 90;
    experienceNotes.push(req.experience.junior ? "Junior/Entry-Level signal" : "Quereinsteiger/no-experience signal");
    positiveSignals.push(req.experience.junior ? "Junior/Entry-Level" : "career changer friendly");
  } else {
    experienceScore = 75;
    experienceNotes.push("no strong experience threshold detected");
  }

  if (req.experience.openSourceAccepted && hasOpenSource) {
    experienceScore = Math.min(100, experienceScore + 8);
    positiveSignals.push("open-source explicitly valued");
  }
  if (req.experience.sideProjectsAccepted && hasProjects) {
    experienceScore = Math.min(100, experienceScore + 7);
    positiveSignals.push("side/personal projects accepted");
  }
  if (req.experience.learningFocus) {
    experienceScore = Math.min(100, experienceScore + 5);
    positiveSignals.push("learning/mentoring signal");
  }

  let educationScore = 75;
  const educationNotes = [];
  if (req.education.completedDegree && req.education.comparableQualification) {
    educationScore = 60;
    educationNotes.push("degree or comparable qualification");
  } else if (req.education.completedDegree) {
    educationScore = 35;
    educationNotes.push("completed degree requested");
  } else if (req.education.comparableQualification) {
    educationScore = 70;
    educationNotes.push("comparable qualification accepted");
  } else {
    educationScore = 80;
    educationNotes.push("no strict degree requirement detected");
  }

  let languageScore = 70;
  const languageNotes = [];
  if (req.language.code === "b2_plus") {
    languageScore = 30;
    languageNotes.push(req.language.label);
  } else if (req.language.code === "required_unspecified") {
    languageScore = 50;
    languageNotes.push(req.language.label);
  } else if (["optional","no_german","english_present"].includes(req.language.code)) {
    languageScore = 90;
    languageNotes.push(req.language.label);
  } else {
    languageScore = 65;
    languageNotes.push(req.language.label);
  }

  const hardGaps = [];
  if (missingTech.includes("angular")) hardGaps.push("Angular not found in profile");
  if (req.education.completedDegree && !req.education.comparableQualification) hardGaps.push("completed degree requested");
  if (req.language.code === "b2_plus") hardGaps.push("strong German requirement");
  if (req.experience.senior && targetSeniority !== "senior") hardGaps.push("senior-level requirement");
  if (req.experience.years.some(y => y >= 3 && y > maxPreferredYears)) hardGaps.push("professional-experience threshold above target level");

  const finalScore = Math.max(0, Math.min(100, Math.round(
    techScore * 0.45 +
    experienceScore * 0.25 +
    educationScore * 0.12 +
    languageScore * 0.18 -
    Math.min(22, hardGaps.length * 5)
  )));

  let decision = "APPLY_NOW";
  let recommendation = "قدّم الآن";
  if (req.experience.senior && targetSeniority !== "senior") {
    decision = "SKIP_FOR_NOW";
    recommendation = "تجاوزها حاليًا";
  } else if (req.experience.years.some(y => y >= 3 && y > maxPreferredYears)) {
    decision = finalScore >= 65 ? "SKILL_GAP" : "SKIP_FOR_NOW";
    recommendation = finalScore >= 65 ? "قريب منها — فجوة خبرة" : "تجاوزها حاليًا";
  } else if (finalScore < 45) {
    decision = "SKIP_FOR_NOW";
    recommendation = "تجاوزها حاليًا";
  } else if (finalScore < 65) {
    decision = "SKILL_GAP";
    recommendation = "احتفظ بها وطوّر الفجوات";
  } else if (finalScore < 80) {
    decision = "CONSIDER";
    recommendation = "مناسبة — راجع التفاصيل ثم قدّم";
  }

  return {
    finalScore,
    decision,
    recommendation,
    breakdown: {
      technical: techScore,
      experience: experienceScore,
      education: educationScore,
      language: languageScore
    },
    matchedTech,
    missingTech,
    positiveSignals,
    cautionSignals,
    hardGaps,
    notes: {
      experience: experienceNotes,
      education: educationNotes,
      language: languageNotes
    }
  };
}



function assessDeliveryFit(job, detail) {
  const text = flattenText(detail).replace(/\s+/g," ");
  const lower = text.toLowerCase();
  let score = 55;
  const positives=[], warnings=[], blockers=[];
  const hasBike = /fahrrad|e-bike|ebike|bike|roller/i.test(text);
  const carOnly = /(führerschein|fuehrerschein).{0,40}(zwingend|erforderlich)|eigenes?\s+(pkw|auto).{0,30}(zwingend|erforderlich)/i.test(text) && !hasBike;
  const partTime = /teilzeit|part[- ]?time|\b15\s*(?:std|stunden)|\b20\s*(?:std|stunden)|\b25\s*(?:std|stunden)/i.test(text);
  const noMinijob = /keine\s+minijobs?|kein\s+minijob/i.test(text);
  const flexible = /flexib|schicht|verfügbarkeit|verfuegbarkeit/i.test(text);
  const easyEntry = /quereinsteiger|keine vorerfahrung|no experience|ohne berufserfahrung/i.test(text);
  const engOk = /deutsch\s+oder\s+englisch|german\s+or\s+english|englischkenntnisse/i.test(text);
  const disabilityOnly = /ausschließlich\s+für\s+schwerbehinderte|ausschliesslich\s+für\s+schwerbehinderte|stelle ausschließlich für schwerbehinderte/i.test(text);
  if (hasBike) {score+=14; positives.push("Fahrrad/E-Bike möglich");}
  if (partTime) {score+=12; positives.push("Teilzeit erkannt");}
  if (noMinijob) {score+=5; positives.push("kein Minijob");}
  if (flexible) {score+=5; positives.push("flexible/Schichtzeiten");}
  if (easyEntry) {score+=5; positives.push("Quereinstieg möglich");}
  if (engOk) {score+=4; positives.push("Deutsch/Englisch akzeptiert");}
  if (carOnly) {score-=40; blockers.push("Auto/Führerschein scheint zwingend");}
  if (disabilityOnly) {score-=70; blockers.push("Stelle nur für schwerbehinderte/gleichgestellte Personen");}
  if (/vollzeit/i.test(text) && !partTime) {score-=18; warnings.push("nur/primär Vollzeit erkannt");}
  if (/nachtschicht/i.test(lower)) warnings.push("Nachtschicht erwähnt");
  return {finalScore:Math.max(0,Math.min(100,score)), recommendation:blockers.length?"Nicht passend wegen Ausschlusskriterium":score>=80?"Sehr passend":score>=65?"Gut passend":"Mit Bedingungen prüfen", positives,warnings,blockers, type:"delivery"};
}

function precisionSummary(job, detail, fit) {
  const text=flattenText(detail).replace(/\s+/g," ");
  const evidence=[];
  if (job.sourcePresence?.baListed) evidence.push("Bundesagentur: in aktuellem Suchlauf gefunden");
  if (/teilzeit/i.test(text)) evidence.push("Teilzeit im Anzeigentext");
  if (/homeoffice|remote/i.test(text)) evidence.push("Remote/Homeoffice erwähnt");
  if (/fahrrad|e-bike|ebike/i.test(text)) evidence.push("Fahrrad/E-Bike erwähnt");
  if (/abgeschlossenes studium/i.test(text)) evidence.push("abgeschlossenes Studium erwähnt");
  if (/vergleichbare qualifikation/i.test(text)) evidence.push("vergleichbare Qualifikation akzeptiert");
  return {level:evidence.length>=3?"high":evidence.length>=1?"medium":"low", evidence:evidence.slice(0,6), note:"Bewertung basiert nur auf erkannten Belegen; fehlende Angaben werden nicht als erfüllt angenommen."};
}

async function enrichStructuredFit(jobs, limit = 60) {
  const profile = readJSON(path.join(ROOT, "cv-profile.json"));
  const target = jobs.slice(0, limit);
  const assessed = await runInBatches(target, 4, async job => {
    let detail;
    if (job.description) detail = {description:job.description};
    else if (!String(job.id || "").includes(":")) detail = await fetchJobDetails(job.id);
    else detail = {description:job.description || job.title || ""};
    if (!detail) return job;
    const fit = job.category === "delivery" ? assessDeliveryFit(job, detail) : assessJobFit(job, detail, profile);
    return {...job, score:fit.finalScore, fit, precision:precisionSummary(job, detail, fit)};
  });
  const mapped=assessed.map((r,i)=>r.status==="fulfilled"?r.value:target[i]);
  return [...mapped,...jobs.slice(limit)];
}


function readJsonOr(pathname, fallback) {
  try { return readJSON(pathname); } catch (_) { return fallback; }
}

function companyKey(name, city) {
  return `${String(name || "").trim().toLowerCase()}|${String(city || "").trim().toLowerCase()}`;
}

function updateCompanyMonitor(jobs) {
  const discovered = readJsonOr(DISCOVERED_COMPANIES_PATH, []);
  const old = readJsonOr(COMPANY_MONITOR_PATH, {});
  const now = new Date().toISOString();
  const next = {...old};

  function monitorKey(name, city, website) {
    const domain = normalizeDomain(website || "");
    if (domain) return `domain:${domain}`;
    return `name:${normalizeCompanyNameForDedupe(name)}|${String(city || "").toLowerCase()}`;
  }

  // Ensure every discovered software/IT or uncertain company exists in the watch list.
  for (const company of discovered) {
    if (company.classification?.category === "non_it") continue;
    const key = monitorKey(company.name, company.city, company.website);
    if (!next[key]) {
      next[key] = {
        name: company.name,
        city: company.city,
        website: company.website || null,
        careerUrl: company.careerUrl || null,
        classification: company.classification || null,
        firstSeen: now,
        lastJobIds: []
      };
    } else {
      next[key].name = company.name || next[key].name;
      next[key].city = company.city || next[key].city;
      next[key].website = company.website || next[key].website || null;
      next[key].careerUrl = company.careerUrl || next[key].careerUrl || null;
      next[key].classification = company.classification || next[key].classification || null;
    }
  }

  // Reset current results for this run.
  for (const rec of Object.values(next)) {
    if (!rec || typeof rec !== "object") continue;
    rec._currentJobs = [];
  }

  // Attach jobs to companies primarily by normalized company name.
  for (const job of jobs) {
    const jobNameNorm = normalizeCompanyNameForDedupe(job.company);
    if (!jobNameNorm || jobNameNorm === "unknown employer") continue;
    let key = Object.keys(next).find(k =>
      normalizeCompanyNameForDedupe(next[k].name) === jobNameNorm
    );

    if (!key) {
      key = monitorKey(job.company, job.location, null);
      if (!next[key]) {
        next[key] = {
          name: job.company,
          city: job.location || "",
          website: null,
          careerUrl: null,
          classification: {category:"from_job_source", score:1},
          firstSeen: now,
          lastJobIds: [],
          _currentJobs: []
        };
      }
    }

    // Defensive initialization: old monitor files or newly-created records
    // may not contain the transient _currentJobs array yet.
    if (!next[key]) {
      next[key] = {
        name: job.company || "Unknown company",
        city: job.location || "",
        website: null,
        careerUrl: null,
        classification: {category:"from_job_source", score:1},
        firstSeen: now,
        lastJobIds: [],
        _currentJobs: []
      };
    }
    if (!Array.isArray(next[key]._currentJobs)) {
      next[key]._currentJobs = [];
    }
    next[key]._currentJobs.push(job);
  }

  for (const rec of Object.values(next)) {
    const currentJobs = rec._currentJobs || [];
    const currentIds = currentJobs.map(j => String(j.id || j.url || j.title)).filter(Boolean);
    const previousIds = Array.isArray(rec.lastJobIds) ? rec.lastJobIds : [];
    const newIds = currentIds.filter(id => !previousIds.includes(id));

    rec.previousJobIds = previousIds;
    rec.lastJobIds = currentIds;
    rec.currentMatches = currentJobs.length;
    rec.newMatches = newIds.length;
    rec.lastChecked = now;
    rec.lastNewAt = newIds.length ? now : (rec.lastNewAt || null);
    rec.status = currentJobs.length ? "matching_jobs" : "no_matching_jobs";
    rec.topJobs = currentJobs.slice(0, 5).map(j => ({
      id: j.id,
      title: j.title,
      score: j.score || 0,
      url: j.externalUrl || j.url || null,
      applicationStatus: j.applicationStatus?.code || "unknown"
    }));
    delete rec._currentJobs;
  }

  fs.writeFileSync(COMPANY_MONITOR_PATH, JSON.stringify(next, null, 2), "utf8");
  return Object.values(next).sort((a,b) =>
    (b.newMatches || 0) - (a.newMatches || 0) ||
    (b.currentMatches || 0) - (a.currentMatches || 0) ||
    String(a.name).localeCompare(String(b.name))
  );
}

function dedupe(jobs) {
  const map = new Map();
  for (const job of jobs) {
    const key = jobIdentityKey(job);
    if (!map.has(key) || (map.get(key).score || 0) < (job.score || 0)) {
      map.set(key, job);
    }
  }
  return [...map.values()];
}


async function runInBatches(items, batchSize, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(worker));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  return results;
}

async function handleJobs(res) {
  const config = readJSON(CONFIG_PATH);
  const settled = await runInBatches(
    config.searches,
    4,
    s => searchBA(s, config.preferences || {})
  );

  const jobs = [];
  const errors = [];
  let rawCount = 0;
  const responseKeys = new Set();
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      rawCount += Number(result.value?._rawCount || result.value?.length || 0);
      for (const key of (result.value?._responseKeys || [])) responseKeys.add(key);
      jobs.push(...result.value);
    } else {
      errors.push({
        source: `Bundesagentur · ${config.searches[index]?.name || "بحث"}`,
        error: result.reason?.message || String(result.reason),
        severity:"error"
      });
    }
  });

  const external = await searchExternalSources(config.preferences || {});
  jobs.push(...external.jobs);
  errors.push(...external.errors);

  let unique = dedupe(jobs).sort((a,b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return String(b.published || "").localeCompare(String(a.published || ""));
  });

  unique = await enrichLanguage(unique, 60);
  unique = await enrichApplicationStatus(unique, 45);
  unique = await enrichStructuredFit(unique, 50);
  const trackedApplications = readJSON(APPLICATIONS_PATH);

  unique = unique.map(job => {
    const match = findMatchingApplication(job, trackedApplications);

    return {
      ...job,
      trackedStatus: match?.status || "new"
     };
  });

  unique.sort((a,b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return String(b.published || "").localeCompare(String(a.published || ""));
  });

  const companyMonitor = updateCompanyMonitor(unique);

  sendJSON(res, 200, {
    version: "1.9.0-precision",
    generatedAt: new Date().toISOString(),
    count: unique.length,
    rawCount,
    responseKeys: [...responseKeys],
    externalJobs: external.jobs.length,
    validatedCareerJobs: external.jobs.filter(j => String(j.source || "").includes("Career Page")).length,
    monitoredCompanies: companyMonitor.length,
    monitoredWithMatches: companyMonitor.filter(x => (x.currentMatches || 0) > 0).length,
    newCompanyJobs: companyMonitor.reduce((n,x) => n + (x.newMatches || 0), 0),
    searchesRun: config.searches.length,
    successfulSearches: settled.filter(x => x.status === "fulfilled").length,
    failedSearches: errors.length,
    errors,
    jobs: unique
  });
}

function handleApplications(req, res) {
  if (req.method === "GET") {
    return sendJSON(res, 200, readJSON(APPLICATIONS_PATH));
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const item = JSON.parse(body || "{}");
        const all = readJSON(APPLICATIONS_PATH);
        const idx = all.findIndex(x => sameJob(x, item));
        const record = {
          ...item,
          updatedAt: new Date().toISOString()
        };
        if (idx >= 0) all[idx] = {...all[idx], ...record};
        else all.push(record);
        fs.writeFileSync(APPLICATIONS_PATH, JSON.stringify(all, null, 2), "utf8");
        sendJSON(res, 200, record);
      } catch (e) {
        sendJSON(res, 400, {error: e.message});
      }
    });
    return;
  }
  sendJSON(res, 405, {error: "Method not allowed"});
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === "/api/jobs" && req.method === "GET") {
      return await handleJobs(res);
    }
    if (u.pathname === "/api/config" && req.method === "GET") {
      return sendJSON(res, 200, readJSON(CONFIG_PATH));
    }
    if (u.pathname === "/api/cv-profile" && req.method === "GET") {
      return sendJSON(res, 200, readJSON(path.join(ROOT, "cv-profile.json")));
    }
    if (u.pathname === "/api/discovered-companies" && req.method === "GET") {
      let companies = [];
      try { companies = readJSON(DISCOVERED_COMPANIES_PATH); } catch (_) {}
      return sendJSON(res, 200, companies);
    }
    if (u.pathname === "/api/company-monitor" && req.method === "GET") {
      const monitor = readJsonOr(COMPANY_MONITOR_PATH, {});
      const rows = Object.values(monitor).sort((a,b) =>
        (b.newMatches || 0) - (a.newMatches || 0) ||
        (b.currentMatches || 0) - (a.currentMatches || 0) ||
        String(a.name).localeCompare(String(b.name))
      );
      return sendJSON(res, 200, rows);
    }
    if (u.pathname === "/api/discover-companies" && req.method === "POST") {
      try {
        const result = await discoverCompanies();
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 500, {error:e.message});
      }
    }
    if (u.pathname === "/api/analyze-application" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const job = JSON.parse(body || "{}");
          const result = await analyzeApplication(job);
          sendJSON(res, result.ok ? 200 : 502, result);
        } catch (e) {
          sendJSON(res, 400, {ok:false, error:e.message});
        }
      });
      return;
    }
    if (u.pathname === "/api/applications") {
      return handleApplications(req, res);
    }

    let rel = u.pathname === "/" ? "/index.html" : u.pathname;
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    return serveFile(res, path.join(PUBLIC, rel));
  } catch (e) {
    sendJSON(res, 500, {error: e.message});
  }
});

server.listen(PORT, () => {
  console.log(`Personal Job Agent running at http://localhost:${PORT}`);
});
