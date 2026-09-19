async function loadCvProfile() {
  try {
    const res = await fetch("/api/cv-profile");
    const profile = await res.json();
    document.querySelector("#cvName").textContent = profile.name || "CV";
    document.querySelector("#cvSkills").textContent =
      `المهارات: ${(profile.skills || []).join(" • ")}`;
  } catch (_) {
    document.querySelector("#cvName").textContent = "تعذر تحميل ملف CV";
  }
}

let jobs = [];
let applications = {};

const jobsEl = document.querySelector("#jobs");
const template = document.querySelector("#jobTemplate");
const filterEl = document.querySelector("#filter");
const statusFilterEl = document.querySelector("#statusFilter");
const minScoreEl = document.querySelector("#minScore");
const languageFilterEl = document.querySelector("#languageFilter");
const categoryFilterEl = document.querySelector("#categoryFilter");
const sourceFilterEl = document.querySelector("#sourceFilter");
const availabilityFilterEl = document.querySelector("#availabilityFilter");
const countEl = document.querySelector("#count");
const updatedEl = document.querySelector("#updated");
const errorBox = document.querySelector("#errorBox");

async function loadApplications() {
  const res = await fetch("/api/applications");
  const items = await res.json();
  applications = Object.fromEntries(items.map(x => [x.id, x]));
}

async function searchJobs() {
  document.querySelector("#refreshBtn").disabled = true;
  updatedEl.textContent = "جاري البحث...";
  errorBox.classList.add("hidden");
  try {
    await loadApplications();
    const res = await fetch("/api/jobs");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    jobs = data.jobs || [];
    if (data.errors?.length) {
      const hardErrors = data.errors.filter(e => e.severity !== "warning");
      const warnings = data.errors.filter(e => e.severity === "warning");

      const formatIssue = e =>
        `${e.source || e.search || "مصدر غير معروف"}: ${e.error || "خطأ غير معروف"}`;

      if (hardErrors.length) {
        errorBox.textContent = hardErrors.map(formatIssue).join(" | ");
        errorBox.classList.remove("hidden");
      } else if (warnings.length) {
        // Career-page 404s are expected occasionally; show a concise note,
        // not a red failure that makes the user think the whole search failed.
        errorBox.textContent =
          `ملاحظة: ${warnings.length} صفحة توظيف لم يمكن فحصها أو أصبحت قديمة. ` +
          warnings.slice(0, 3).map(formatIssue).join(" | ") +
          (warnings.length > 3 ? ` | +${warnings.length - 3} أخرى` : "");
        errorBox.classList.remove("hidden");
      }
    }
    updatedEl.textContent = `الإصدار ${data.version || "?"} • آخر بحث: ${new Date(data.generatedAt).toLocaleString("ar")} • ${data.successfulSearches ?? "?"}/${data.searchesRun ?? "?"} عمليات بحث نجحت • ${data.rawCount ?? "?"} نتيجة خام • ${data.externalJobs ?? 0} من المصادر الإضافية • ${data.validatedCareerJobs ?? 0} وظائف Career مؤكدة • مراقبة ${data.monitoredCompanies ?? 0} شركة، ${data.monitoredWithMatches ?? 0} لديها وظائف مناسبة، ${data.newCompanyJobs ?? 0} جديدة${data.responseKeys?.length ? " • مفاتيح الاستجابة: " + data.responseKeys.join(", ") : ""}`;
    render();
  } catch (e) {
    errorBox.textContent = e.message;
    errorBox.classList.remove("hidden");
    updatedEl.textContent = "فشل البحث";
  } finally {
    document.querySelector("#refreshBtn").disabled = false;
  }
}
function currentStatus(job) {
   return applications[job.id]?.status || job.trackedStatus || "new";
  }

function render() {
  const q = filterEl.value.trim().toLowerCase();
  const wantedStatus = statusFilterEl.value;
  const minScore = Number(minScoreEl.value || 0);
  const languageMode = languageFilterEl.value;
  const categoryMode = categoryFilterEl.value;
  const sourceMode = sourceFilterEl.value;
  const availabilityMode = availabilityFilterEl.value;

  const filtered = jobs.filter(job => {
    const blob = `${job.title} ${job.company} ${job.location} ${job.sourceSearch}`.toLowerCase();
    const availabilityOk =
      !availabilityMode ||
      (availabilityMode === "open_only" && ["open","open_source"].includes(job.applicationStatus?.code)) ||
      job.applicationStatus?.code === availabilityMode;

    const languageOk =
      !languageMode ||
      (languageMode === "avoid_b2" && job.language?.code !== "b2_plus") ||
      (languageMode === "english_friendly" && job.language?.englishFriendly === true) ||
      (languageMode === "optional" && ["optional","no_german"].includes(job.language?.code));

    return (!q || blob.includes(q)) &&
      (!wantedStatus || currentStatus(job) === wantedStatus) &&
      (!categoryMode || job.category === categoryMode) &&
      (!sourceMode || String(job.source || "").includes(sourceMode)) &&
      availabilityOk &&
      (job.score || 0) >= minScore &&
      languageOk;
  });

  countEl.textContent = `${filtered.length} وظيفة`;
  jobsEl.innerHTML = "";

  for (const job of filtered) {
    const node = template.content.cloneNode(true);
    node.querySelector(".title").textContent = job.title;
    node.querySelector(".company").textContent = job.company;
    node.querySelector(".score").textContent = `${job.score || 0}%`;
    if (job.fit?.recommendation) {
      node.querySelector(".score").title = job.fit.recommendation;
    }

    const statusLabel = job.applicationStatus?.label || "غير مفحوص";
    const meta = [
      job.category === "delivery" ? "توصيل/كورير" : "تقنية",
      job.validationConfidence ? `تحقق الرابط: ${job.validationConfidence}` : null,
      `التقديم: ${statusLabel}`,
      job.location,
      job.published ? `نشر: ${job.published}` : null,
      job.sourceSearch,
      job.source
    ].filter(Boolean);
    if (job.language?.label) meta.push(`اللغة: ${job.language.label}`);
    node.querySelector(".meta").textContent = meta.join(" • ");

    const reasonParts = [];
    if (job.fit) {
      if (job.fit.type === "delivery") {
        if (job.fit.positives?.length) reasonParts.push(`✓ ${job.fit.positives.join("، ")}`);
        if (job.fit.warnings?.length) reasonParts.push(`△ ${job.fit.warnings.join("، ")}`);
        if (job.fit.blockers?.length) reasonParts.push(`⚠ ${job.fit.blockers.join("، ")}`);
      } else if (job.fit.breakdown) {
        reasonParts.push(`تقني ${job.fit.breakdown.technical}%`, `خبرة ${job.fit.breakdown.experience}%`, `تعليم ${job.fit.breakdown.education}%`, `لغة ${job.fit.breakdown.language}%`);
        if (job.fit.positiveSignals?.length) reasonParts.push(`✓ إشارات دخول: ${job.fit.positiveSignals.join("، ")}`);
        if (job.fit.cautionSignals?.length) reasonParts.push(`△ تنبيه مستوى: ${job.fit.cautionSignals.join("، ")}`);
        if (job.fit.hardGaps?.length) reasonParts.push(`فجوات: ${job.fit.hardGaps.join("، ")}`);
      }
      if (job.precision?.evidence?.length) reasonParts.push(`دليل: ${job.precision.evidence.join("، ")}`);
    } else if (job.reasons?.length) {
      reasonParts.push(`CV: ${job.reasons.join("، ")}`);
    }
    if (job.language?.code === "b2_plus") reasonParts.push("خفض الترتيب بسبب شرط ألمانية قوي");
    if (job.language?.englishFriendly) reasonParts.push("مناسبة أكثر من ناحية اللغة");
    node.querySelector(".reasons").textContent = reasonParts.join(" • ");

    const link = node.querySelector(".open");
    link.href = job.url;

    const state = node.querySelector(".state");
    state.textContent = `الحالة: ${labelStatus(currentStatus(job))}`;

    node.querySelectorAll("button[data-status]").forEach(btn => {
      btn.addEventListener("click", () => saveStatus(job, btn.dataset.status));
    });

    node.querySelector('button[data-action="analyze"]').addEventListener("click", () => analyzeJob(job));

    jobsEl.appendChild(node);
  }
}

function labelStatus(s) {
  return ({new:"جديدة", saved:"محفوظة", applied:"تم التقديم", ignore:"متجاهلة"})[s] || s;
}

async function saveStatus(job, status) {
  const payload = {
    id: job.id,
    status,
    title: job.title,
    company: job.company,
    url: job.url,
    location: job.location
  };
  const res = await fetch("/api/applications", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
  });
  const saved = await res.json();
  applications[job.id] = saved;
  render();
}

document.querySelector("#refreshBtn").addEventListener("click", searchJobs);
[filterEl, statusFilterEl, minScoreEl, languageFilterEl, categoryFilterEl, sourceFilterEl, availabilityFilterEl].forEach(el => el.addEventListener("input", render));


async function analyzeJob(job) {
  const modal = document.querySelector("#applicationModal");
  const status = document.querySelector("#analysisStatus");
  const content = document.querySelector("#analysisContent");
  modal.classList.remove("hidden");
  content.classList.add("hidden");
  status.textContent = "جاري قراءة تفاصيل الإعلان وتجهيز التقديم...";

  try {
    const res = await fetch("/api/analyze-application", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(job)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "تعذر التحليل");

    const info = data.info;
    const draft = data.draft;
    const fit = data.fit || null;
    const applicationStatus = data.applicationStatus || {code:"unknown", label:"غير واضح"};
    const methodLabels = {
      email: "البريد الإلكتروني",
      email_possible: "يوجد بريد إلكتروني في الإعلان — راجع أنه مخصص للتقديم",
      website: "صفحة تقديم / موقع الشركة",
      website_possible: "يوجد رابط خارجي — راجع أنه صفحة التقديم",
      unknown: "لم أستطع تحديد طريقة التقديم تلقائيًا"
    };

    document.querySelector("#applyMethod").textContent =
      `${methodLabels[info.method] || info.method} • حالة الرابط: ${applicationStatus.label}`;
    document.querySelector("#applyDestinations").textContent =
      [...(info.emails || []), ...(info.urls || [])].join(" • ") || "لا توجد وجهة واضحة مستخرجة";
    document.querySelector("#requestedDocs").textContent =
      info.requestedDocs?.length ? info.requestedDocs.join(" • ") : "لم تُكتشف مستندات محددة بوضوح";
    const used = draft.usedJobFacts?.length ? ` • استُخدم من الإعلان: ${draft.usedJobFacts.join("، ")}` : "";
    document.querySelector("#analysisLanguage").textContent =
      `${info.language?.label || "غير واضح"} • نوع الرسالة: ${draft.detectedCategory || "general"}${used}`;

    if (fit) {
      document.querySelector("#fitRecommendation").textContent =
        `${fit.finalScore}% — ${fit.recommendation}`;

      const parts = [
        ["التقني", fit.breakdown.technical],
        ["الخبرة", fit.breakdown.experience],
        ["التعليم", fit.breakdown.education],
        ["اللغة", fit.breakdown.language]
      ];
      document.querySelector("#fitBreakdown").innerHTML = parts.map(([label, value]) =>
        `<div class="fit-item"><span>${label}</span><strong>${value}%</strong></div>`
      ).join("");

      const gaps = [];
      if (fit.matchedTech?.length) gaps.push(`✓ موجود: ${fit.matchedTech.join("، ")}`);
      if (fit.missingTech?.length) gaps.push(`△ غير موجود في CV: ${fit.missingTech.join("، ")}`);
      if (fit.positiveSignals?.length) gaps.push(`✓ إشارات مناسبة للمستوى: ${fit.positiveSignals.join("، ")}`);
      if (fit.cautionSignals?.length) gaps.push(`△ تنبيهات: ${fit.cautionSignals.join("، ")}`);
      if (fit.hardGaps?.length) gaps.push(`⚠ فجوات مهمة: ${fit.hardGaps.join("، ")}`);
      document.querySelector("#fitGaps").textContent = gaps.join(" • ");
    } else {
      document.querySelector("#fitRecommendation").textContent = "لم يتوفر تقييم تفصيلي.";
      document.querySelector("#fitBreakdown").innerHTML = "";
      document.querySelector("#fitGaps").textContent = "";
    }
    document.querySelector("#draftSubject").value = draft.subject || "";
    document.querySelector("#draftBody").value = draft.body || "";

    const emailLink = document.querySelector("#openEmail");
    const siteLink = document.querySelector("#openApplySite");
    emailLink.classList.add("hidden");
    siteLink.classList.add("hidden");

    if (applicationStatus.code === "closed") {
      status.textContent = "⚠️ يبدو أن صفحة التقديم الأصلية مغلقة أو منتهية. راجع الإعلان قبل إرسال أي طلب.";
    } else {
      status.textContent = "";
    }

    if (info.emails?.length) {
      const to = info.emails[0];
      emailLink.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
      emailLink.classList.remove("hidden");
    }
    if (info.urls?.length) {
      siteLink.href = info.urls[0];
      siteLink.classList.remove("hidden");
    }

    content.classList.remove("hidden");
  } catch (e) {
    status.textContent = `خطأ: ${e.message}`;
  }
}

document.querySelector("#closeModal").addEventListener("click", () => {
  document.querySelector("#applicationModal").classList.add("hidden");
});

document.querySelector("#copyDraft").addEventListener("click", async () => {
  const subject = document.querySelector("#draftSubject").value;
  const body = document.querySelector("#draftBody").value;
  await navigator.clipboard.writeText(`Betreff: ${subject}\\n\\n${body}`);
  document.querySelector("#copyDraft").textContent = "تم النسخ";
  setTimeout(() => document.querySelector("#copyDraft").textContent = "نسخ الرسالة", 1200);
});



async function discoverCompaniesNow() {
  const btn = document.querySelector("#discoverCompaniesBtn");
  const status = document.querySelector("#discoveryStatus");

  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "جاري الاكتشاف...";
  status.textContent = "بدأ الاكتشاف. يتم الآن البحث عن شركات IT وفحص عدد محدود من صفحات التوظيف لكل مدينة...";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch("/api/discover-companies", {
      method:"POST",
      signal: controller.signal
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Discovery failed");

    const parts = (data.stats || []).map(s =>
      s.error
        ? `${s.city}: خطأ`
        : `${s.city}: ${s.found} شركة، فُحص ${s.inspected ?? 0}، ${s.withCareer} Career Page`
    );

    status.textContent =
      `تم الاكتشاف: ${data.total} شركة محفوظة • ${data.withCareer} لديها Career Page • ` +
      `${data.atsAdded} مصدر Greenhouse/Lever أضيف. ${parts.join(" | ")}`;

    // Do not automatically launch the full job search here; keep the button responsive.
    // The user can press "بحث الآن" after reviewing discovered companies.
  } catch (e) {
    status.textContent = e.name === "AbortError"
      ? "توقف الاكتشاف بعد 90 ثانية. تم تحديد مهلة حتى لا تبقى الواجهة معلقة."
      : `فشل الاكتشاف: ${e.message}`;
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

async function showDiscoveredCompanies() {
  const panel = document.querySelector("#companiesPanel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  panel.innerHTML = "جاري التحميل...";
  panel.classList.remove("hidden");
  try {
    const res = await fetch("/api/discovered-companies");
    const companies = await res.json();
    panel.innerHTML = "";
    if (!companies.length) {
      panel.textContent = "لا توجد شركات مكتشفة بعد. اضغط «اكتشاف شركات IT».";
      return;
    }
    for (const c of companies) {
      const row = document.createElement("div");
      row.className = "company-row";
      const name = document.createElement("strong");
      const cls = c.classification?.category || "uncertain";
      const clsLabel = ({
        software_it:"IT/Software",
        technical_adjacent:"تقني قريب",
        non_it:"غير تقني",
        uncertain:"غير واضح"
      })[cls] || cls;
      name.textContent = `${c.name} — ${c.city} • ${clsLabel}`;
      row.appendChild(name);

      const site = document.createElement("a");
      site.href = c.website;
      site.target = "_blank";
      site.rel = "noopener";
      site.textContent = "الموقع";
      row.appendChild(site);

      if (c.careerUrl) {
        const career = document.createElement("a");
        career.href = c.careerUrl;
        career.target = "_blank";
        career.rel = "noopener";
        career.textContent = "Career";
        row.appendChild(career);
      }

      if (c.ats?.type) {
        const ats = document.createElement("span");
        ats.textContent = ` • ${c.ats.type}`;
        row.appendChild(ats);
      }
      panel.appendChild(row);
    }
  } catch (e) {
    panel.textContent = `خطأ: ${e.message}`;
  }
}

document.querySelector("#discoverCompaniesBtn").addEventListener("click", discoverCompaniesNow);
document.querySelector("#showCompaniesBtn").addEventListener("click", showDiscoveredCompanies);



async function showCompanyMonitor() {
  const panel = document.querySelector("#companyMonitorPanel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  panel.textContent = "جاري تحميل حالة الشركات...";

  try {
    const res = await fetch("/api/company-monitor");
    const rowsRaw = await res.json();
    const rows = rowsRaw.filter(x => x.classification?.category !== "non_it");
    panel.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "monitor-summary";
    const total = rows.length;
    const active = rows.filter(x => (x.currentMatches || 0) > 0).length;
    const fresh = rows.reduce((n,x) => n + (x.newMatches || 0), 0);
    heading.textContent = `الشركات المراقبة: ${total} • لديها وظائف مناسبة الآن: ${active} • وظائف جديدة منذ آخر بحث: ${fresh}`;
    panel.appendChild(heading);

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.textContent = "لا توجد بيانات مراقبة بعد. شغّل «اكتشاف شركات IT» ثم «بحث الآن».";
      panel.appendChild(empty);
      return;
    }

    for (const c of rows) {
      const row = document.createElement("div");
      row.className = "company-monitor-row";

      const title = document.createElement("strong");
      title.textContent = `${c.name}${c.city ? " — " + c.city : ""}`;
      row.appendChild(title);

      const state = document.createElement("span");
      if ((c.currentMatches || 0) > 0) {
        state.textContent = ` • ${c.currentMatches} وظيفة مناسبة حاليًا`;
      } else {
        state.textContent = " • لا توجد وظائف مناسبة حاليًا";
      }
      row.appendChild(state);

      if ((c.newMatches || 0) > 0) {
        const fresh = document.createElement("span");
        fresh.className = "new-jobs-badge";
        fresh.textContent = ` • جديد: ${c.newMatches}`;
        row.appendChild(fresh);
      }

      const meta = document.createElement("div");
      meta.className = "monitor-meta";
      meta.textContent = c.lastChecked
        ? `آخر فحص: ${new Date(c.lastChecked).toLocaleString("ar")}`
        : "لم يتم الفحص بعد";
      row.appendChild(meta);

      if (c.topJobs?.length) {
        const jobs = document.createElement("div");
        jobs.className = "monitor-jobs";
        for (const j of c.topJobs) {
          const a = document.createElement("a");
          a.href = j.url || "#";
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = `${j.title} (${j.score || 0}%)`;
          jobs.appendChild(a);
        }
        row.appendChild(jobs);
      }

      panel.appendChild(row);
    }
  } catch (e) {
    panel.textContent = `تعذر تحميل مراقبة الشركات: ${e.message}`;
  }
}

document.querySelector("#companyMonitorBtn").addEventListener("click", showCompanyMonitor);

loadCvProfile();
searchJobs();
