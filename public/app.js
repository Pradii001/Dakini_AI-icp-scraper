const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 15;
let activeIcpId;
let allCompanies = [];
let currentPage = 1;
let googleConnected = false;
let spreadsheetUrl = "";
let crawlPollTimer;
let discoveryPollTimer;
let technologyPollTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

$("icpForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/icps", {
      method: "POST",
      body: JSON.stringify({
        name: $("icpName").value,
        industries: $("industries").value.split(",").map(value => value.trim()).filter(Boolean),
        locations: $("locations").value.split(",").map(value => value.trim()).filter(Boolean),
        useCases: $("useCases").value.split(",").map(value => value.trim()).filter(Boolean)
      })
    });
    activeIcpId = data.id;
    $("icpResult").textContent = `Target profile saved: ${data.name}`;
  } catch (error) {
    $("icpResult").textContent = error.message;
  }
});

$("sourceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({
        name: $("sourceName").value,
        url: $("sourceUrl").value,
        approved: $("approved").checked
      })
    });
    $("sourceResult").textContent = `Approved source added: ${data.name} (${data.domain})`;
  } catch (error) {
    $("sourceResult").textContent = error.message;
  }
});

$("crawlBtn").addEventListener("click", async () => {
  const button = $("crawlBtn");
  button.disabled = true;
  $("jobResult").textContent = "Starting crawl...";
  try {
    const sourceList = await api("/api/sources");
    const approvedSources = sourceList.filter(source => source.approved);
    if (!approvedSources.length) {
      $("jobResult").textContent = "Add at least one approved source first.";
      button.disabled = false;
      return;
    }

    const job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        sourceIds: approvedSources.map(source => source.id),
        maxPagesPerCompany: 8,
        ...(activeIcpId ? { icpId: activeIcpId } : {})
      })
    });
    pollJob(job.id);
  } catch (error) {
    $("jobResult").textContent = error.message;
  }
});

$("runDiscoveryBtn").addEventListener("click", async () => {
  const button = $("runDiscoveryBtn");
  button.disabled = true;
  $("discoveryStatus").textContent = "Starting cross-industry web search...";
  try {
    const job = await api("/api/discovery/run-now", { method: "POST" });
    pollDiscovery(job.id);
  } catch (error) {
    $("discoveryStatus").textContent = error.message;
    button.disabled = false;
  }
});

$("refreshTechBtn").addEventListener("click", async () => {
  const button = $("refreshTechBtn");
  button.disabled = true;
  $("techUpdatesStatus").textContent = "Searching recent technology-release news…";
  try {
    await api("/api/technology-updates/refresh", { method: "POST" });
    pollTechnologyDigest();
  } catch (error) {
    $("techUpdatesStatus").textContent = error.message;
    button.disabled = false;
  }
});

$("googleSheetsBtn").addEventListener("click", async () => {
  if (!googleConnected) {
    window.location.assign("/auth/google");
    return;
  }

  const button = $("googleSheetsBtn");
  button.disabled = true;
  $("googleStatus").textContent = "Syncing prospects to Google Sheets...";
  try {
    const result = await api("/api/google/sheets", { method: "POST" });
    spreadsheetUrl = result.spreadsheetUrl;
    showGoogleStatus(`Synced ${result.rows} prospects.`, spreadsheetUrl);
  } catch (error) {
    $("googleStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("companySearch").addEventListener("input", () => {
  currentPage = 1;
  renderCompanies();
});
$("tierFilter").addEventListener("change", () => {
  currentPage = 1;
  renderCompanies();
});
$("prevPage").addEventListener("click", () => {
  currentPage = Math.max(1, currentPage - 1);
  renderCompanies();
});
$("nextPage").addEventListener("click", () => {
  currentPage += 1;
  renderCompanies();
});
$("setupNav").addEventListener("click", () => {
  $("setup").open = true;
});

function showGoogleStatus(message, link) {
  $("googleStatus").replaceChildren(document.createTextNode(`${message} `));
  if (link) {
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = "Open spreadsheet";
    $("googleStatus").append(anchor);
  }
}

function showContact(company) {
  const emails = company.contactEmails.slice(0, 3)
    .map(email => `<a href="mailto:${encodeURIComponent(email)}">${escapeHtml(email)}</a>`);
  const phones = company.contactPhones.slice(0, 2)
    .map(phone => `<a href="tel:${encodeURIComponent(phone)}">${escapeHtml(phone)}</a>`);
  const contacts = [...emails, ...phones];
  if (company.contactPages[0]) {
    contacts.push(`<a href="${escapeHtml(company.contactPages[0])}" target="_blank" rel="noopener noreferrer">Contact page</a>`);
  }
  return contacts.length ? contacts.join("<br>") : '<span class="muted">Not found</span>';
}

function renderCompanies() {
  const search = $("companySearch").value.trim().toLowerCase();
  const tier = $("tierFilter").value;
  const filtered = allCompanies.filter(company => {
    if (tier !== "all" && company.score.tier !== tier) return false;
    const searchable = [
      company.companyName,
      company.industry,
      company.score.tier,
      company.detectedUseCases.join(" "),
      company.dakiniRecommendations.join(" "),
      company.contactEmails.join(" "),
      company.contactPhones.join(" ")
    ].join(" ").toLowerCase();
    return searchable.includes(search);
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageCompanies = filtered.slice(start, start + PAGE_SIZE);
  $("resultCount").textContent = filtered.length
    ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} prospects`
    : "No prospects match these filters.";
  $("pageLabel").textContent = `Page ${currentPage} of ${pageCount}`;
  $("prevPage").disabled = currentPage <= 1;
  $("nextPage").disabled = currentPage >= pageCount;

  const scoreLabels = [
    ["Service fit", "serviceFit", 35],
    ["Operating scale", "operatingScale", 20],
    ["India/language fit", "indiaMarketFit", 15],
    ["Integration readiness", "integrationReadiness", 10],
    ["Buying signals", "buyingSignals", 15],
    ["Contactability", "reachability", 5]
  ];
  $("companies").innerHTML = pageCompanies.map((company, index) => {
    const componentBreakdown = scoreLabels
      .map(([label, key, maximum]) => `${label}: ${company.score.components?.[key] || 0}/${maximum}`)
      .join(" · ");
    const vendorExclusion = company.score.components?.aiVendorExclusion || 0;
    const breakdown = vendorExclusion
      ? `${componentBreakdown} · AI vendor exclusion: ${vendorExclusion}`
      : componentBreakdown;
    const evidence = (company.evidence || [])
      .filter(item => item.quote && item.field !== "roleEmail" && item.field !== "phone")
      .slice(0, 8)
      .map(item => `<li><strong>${escapeHtml(item.field.replace(/([A-Z])/g, " $1"))}:</strong> ${escapeHtml(item.quote)} <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></li>`)
      .join("");
    return `
    <tr>
      <td>${start + index + 1}</td>
      <td>
        <strong>${escapeHtml(company.companyName)}</strong>
        <span class="industry-tag">${escapeHtml(company.industry)}</span>
      </td>
      <td><span class="badge ${company.score.tier === "Priority" ? "priority" : ""}">${company.score.score}/100</span><br><small>${company.score.tier === "Priority" ? "High potential" : company.score.tier === "Review" ? "Research" : "Lower fit"}</small></td>
      <td>${escapeHtml(company.score.matchedUseCases.join(", ") || company.detectedUseCases.join(", ") || "Opportunity not clear")}</td>
      <td>${showContact(company)}</td>
      <td>
        <details class="lead-details">
          <summary>View</summary>
          <div class="detail-content">
            <p><strong>What they do:</strong> ${escapeHtml(company.companyActivities.join(" ") || "Not clear from scanned pages.")}</p>
            <p><strong>Dakini AI could help:</strong> ${escapeHtml(company.dakiniRecommendations.join(" ") || "Review company operations to identify a suitable workflow.")}</p>
            ${company.score.exclusionReason ? `<p><strong>Qualification note:</strong> ${escapeHtml(company.score.exclusionReason)}</p>` : ""}
            <p><strong>Score breakdown:</strong> ${escapeHtml(breakdown)}</p>
            ${company.score.dakiniWorkflowMatches?.length ? `<p><strong>Matched Dakini workflows:</strong> ${escapeHtml(company.score.dakiniWorkflowMatches.join(", "))}</p>` : ""}
            ${evidence ? `<details><summary>Evidence behind the score</summary><ul>${evidence}</ul></details>` : ""}
            <p><strong>Pages scanned:</strong> ${company.pagesScanned.length}</p>
            <p><a href="${escapeHtml(company.sourceUrl)}" target="_blank" rel="noopener noreferrer">Company website</a> · <a href="${escapeHtml(company.directoryUrl || company.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a></p>
          </div>
        </details>
      </td>
    </tr>
  `;
  }).join("");
}

async function pollJob(jobId) {
  try {
    const jobs = await api("/api/jobs");
    const job = jobs.find(item => item.id === jobId);
    if (!job) throw new Error("Crawl job was not found.");
    $("jobResult").textContent = `Status: ${job.status}\nCompanies discovered: ${job.discoveredCompanies.length}\nCompanies visited: ${job.companiesVisited}\nPages scanned: ${job.pages}\nFetch errors: ${job.errors.length}`;
    if (job.status === "running" || job.status === "queued") {
      $("crawlBtn").disabled = true;
      crawlPollTimer = setTimeout(() => pollJob(jobId), 2500);
      return;
    }
    $("crawlBtn").disabled = false;
    await loadAll();
  } catch (error) {
    $("crawlBtn").disabled = false;
    $("jobResult").textContent = error.message;
  }
}

async function pollDiscovery(jobId) {
  discoveryPollTimer = null;
  try {
    const status = await api("/api/discovery/status");
    const job = status.activeJob;
    if (!job || job.id !== jobId) {
      $("runDiscoveryBtn").disabled = false;
      await loadAll();
      return;
    }
    $("discoveryStatus").textContent = `Searching ${job.searchesCompleted}/${status.dailySearchQueries} queries · ${job.newQualifiedProspects || 0}/${status.dailyProspectTarget} new qualified prospects · ${job.companiesVisited} sites visited · ${job.pages} pages scanned · ${job.errors} errors${job.rateLimited ? " · provider rate limit reached" : ""}`;
    discoveryPollTimer = setTimeout(() => pollDiscovery(jobId), 4000);
  } catch (error) {
    $("discoveryStatus").textContent = error.message;
    $("runDiscoveryBtn").disabled = false;
  }
}

async function pollTechnologyDigest() {
  technologyPollTimer = null;
  try {
    const updates = await api("/api/technology-updates");
    renderTechnologyUpdates(updates);
    if (updates.refreshing) {
      scheduleTechnologyPoll();
    } else {
      $("refreshTechBtn").disabled = false;
    }
  } catch (error) {
    $("techUpdatesStatus").textContent = error.message;
    $("refreshTechBtn").disabled = false;
  }
}

function scheduleTechnologyPoll() {
  if (!technologyPollTimer) technologyPollTimer = setTimeout(pollTechnologyDigest, 4000);
}

function renderTechnologyUpdates(data) {
  const lastUpdated = data.lastUpdatedAt ? `Updated ${formatDate(data.lastUpdatedAt)}.` : "No daily tech brief has completed yet.";
  const progress = data.refreshing
    ? ` Searching ${data.searchesCompleted}/${data.totalSearches} technology-news queries…`
    : "";
  const error = data.lastError ? ` ${data.lastError}` : "";
  $("techUpdatesStatus").textContent = `${lastUpdated}${progress}${error}`;
  $("refreshTechBtn").disabled = data.refreshing;

  if (!data.items.length) {
    $("techUpdatesList").innerHTML = `<p class="muted">${data.refreshing ? "The technology brief will appear here when the news search finishes." : "No technology release stories are available yet. Refresh the brief or wait for the daily schedule."}</p>`;
    return;
  }

  $("techUpdatesList").innerHTML = data.items.map(item => {
    const parsedUrl = new URL(item.url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("Technology news result contains a non-web URL.");
    }
    const source = parsedUrl.hostname.replace(/^www\./, "");
    const href = parsedUrl.href;
    const published = item.publishedAt || "Date not provided by publisher";
    return `<article class="tech-update">
      <div class="tech-update-meta">
        <span class="tech-update-tag">${escapeHtml(item.category)}</span>
        <span class="tech-update-tag">Dakini relevance: ${escapeHtml(item.relevance)}</span>
      </div>
      <h3><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
      <p>${escapeHtml(item.description || "No summary was provided by the news result.")}</p>
      <p class="tech-update-source">${escapeHtml(source)} · ${escapeHtml(published)}</p>
    </article>`;
  }).join("");
}

async function loadAll() {
  try {
    const [config, googleStatus, discoveryStatus, technologyUpdates, jobs, dashboard, companies] = await Promise.all([
      api("/api/config"),
      api("/api/google/status"),
      api("/api/discovery/status"),
      api("/api/technology-updates"),
      api("/api/jobs"),
      api("/api/dashboard"),
      api("/api/companies")
    ]);
    renderTechnologyUpdates(technologyUpdates);
    if (technologyUpdates.refreshing) scheduleTechnologyPoll();
    $("modeNotice").textContent = config.demoMode
      ? "DEMO MODE · Manual crawls use simulated data; daily web discovery (when configured) visits public company websites."
      : "LIVE MODE · Public approved websites are being used.";

    $("runDiscoveryBtn").disabled = !discoveryStatus.configured ||
      Boolean(discoveryStatus.activeJob) || discoveryStatus.technologyRefreshInProgress;
    if (!discoveryStatus.configured) {
      $("discoveryStatus").textContent = "Web search is temporarily unavailable. Retry shortly.";
      $("discoverySetupStatus").textContent = "The free keyless search provider may be rate-limited. Search coverage is broad, not the entire internet.";
    } else if (discoveryStatus.activeJob) {
      const job = discoveryStatus.activeJob;
      const providerPlan = discoveryStatus.authenticatedSearchConfigured
        ? "Authenticated search is configured; provider quotas still apply."
        : "Keyless search has lower rate limits; add a Firecrawl or Brave API key for higher provider limits.";
      $("discoveryStatus").textContent = `Searching with ${discoveryStatus.provider} · ${job.searchesCompleted}/${discoveryStatus.dailySearchQueries} queries · ${job.newQualifiedProspects || 0}/${discoveryStatus.dailyProspectTarget} new qualified prospects · ${job.companiesVisited}/${job.companiesDiscovered} sites visited · ${job.pages} pages${job.rateLimited ? " · provider rate limit reached" : ""}`;
      $("discoverySetupStatus").textContent = `Daily target: ${discoveryStatus.dailyProspectTarget} new qualified prospects. The system searches ${discoveryStatus.dailySearchQueries} queries and can crawl up to ${discoveryStatus.maxCompanySitesPerRun} sites per run. ${providerPlan} Schedule: ${discoveryStatus.schedule}. Next run: ${formatDate(discoveryStatus.nextRunAt)}.`;
      $("runDiscoveryBtn").disabled = true;
      if (!discoveryPollTimer) discoveryPollTimer = setTimeout(() => pollDiscovery(job.id), 4000);
    } else {
      const lastSummary = discoveryStatus.lastRunSummary
        ? ` Last run: ${discoveryStatus.lastRunSummary.newQualifiedProspects}/${discoveryStatus.lastRunSummary.target} new qualified prospects${discoveryStatus.lastRunSummary.targetMet ? " (target met)" : ""}.`
        : "";
      const lastRun = discoveryStatus.lastRunAt ? `Last run: ${formatDate(discoveryStatus.lastRunAt)}. ` : "No daily discovery run has completed yet. ";
      const lastError = discoveryStatus.lastError ? ` Latest issue: ${discoveryStatus.lastError}` : "";
      const providerPlan = discoveryStatus.authenticatedSearchConfigured
        ? "Authenticated search is configured; provider quotas still apply."
        : "Keyless search has lower rate limits; configure FIRECRAWL_API_KEY or BRAVE_SEARCH_API_KEY for higher provider limits.";
      $("discoveryStatus").textContent = `${discoveryStatus.provider} · ${lastRun}${lastSummary} Next search: ${formatDate(discoveryStatus.nextRunAt)} · ${discoveryStatus.schedule}.${lastError}`;
      $("discoverySetupStatus").textContent = `Daily target: ${discoveryStatus.dailyProspectTarget} new qualified prospects. ${discoveryStatus.dailySearchQueries} searches per run; up to ${discoveryStatus.maxCompanySitesPerRun} sites crawled. ${providerPlan} The server must remain running for scheduled discovery.${lastError}`;
    }

    googleConnected = googleStatus.connected;
    spreadsheetUrl = googleStatus.spreadsheetUrl || "";
    $("googleSheetsBtn").disabled = !googleStatus.configured;
    $("googleSheetsBtn").textContent = !googleStatus.configured
      ? "Google Sheets setup required"
      : googleConnected ? "Sync to Google Sheets" : "Connect Google Sheets";
    if (!googleStatus.configured) {
      $("googleStatus").textContent = "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Sheets sync.";
      $("googleSetupHelp").innerHTML = `Create a Google OAuth Web application client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Credentials</a>, add <code>http://localhost:3000/auth/google/callback</code> as a redirect URI, save the client ID and secret in this app's private <code>.env</code>, then restart the server. See the README for setup steps.`;
    } else if (googleConnected && spreadsheetUrl) {
      showGoogleStatus("Google connected.", spreadsheetUrl);
      $("googleSetupHelp").textContent = "Google Sheets is connected. Sync creates or updates your Dakini AI prospects spreadsheet.";
    } else if (googleConnected) {
      $("googleStatus").textContent = "Google connected. Sync to create your prospect sheet.";
      $("googleSetupHelp").textContent = "Google Sheets is connected. Sync to create your Dakini AI prospects spreadsheet.";
    } else {
      $("googleSetupHelp").textContent = "Connect your Google account, then sync to create a spreadsheet with company name, fit score, opportunities, and public contacts.";
    }

    const dashboardLabels = {
      companies: "Potential clients",
      priority: "High potential",
      review: "Research",
      lowFit: "Lower fit",
      jobs: "Crawls"
    };
    $("dashboard").innerHTML = Object.entries(dashboard)
      .map(([key, value]) => `<div class="stat"><strong>${dashboardLabels[key] || escapeHtml(key)}</strong><br><span>${value}</span></div>`)
      .join("");

    allCompanies = companies.sort((a, b) => b.score.score - a.score.score);
    renderCompanies();

    const activeJob = jobs.slice().reverse().find(job =>
      (job.status === "running" || job.status === "queued") && job.kind !== "daily_web_discovery" && job.kind !== "manual_web_discovery"
    );
    if (activeJob) {
      $("crawlBtn").disabled = true;
      $("jobResult").textContent = `Status: ${activeJob.status}\nCompanies discovered: ${activeJob.discoveredCompanies.length}\nCompanies visited: ${activeJob.companiesVisited}\nPages scanned: ${activeJob.pages}\nFetch errors: ${activeJob.errors.length}`;
      if (!crawlPollTimer) crawlPollTimer = setTimeout(() => pollJob(activeJob.id), 2500);
    } else if (!jobs.length) {
      $("jobResult").textContent = "No crawl running.";
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      showGoogleStatus("Google account connected. Sync to create your prospect sheet.", spreadsheetUrl);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.has("googleError")) {
      $("googleStatus").textContent = params.get("googleError");
      window.history.replaceState({}, "", window.location.pathname);
    }
  } catch (error) {
    $("modeNotice").textContent = `App connection error: ${error.message}`;
  }
}

function formatDate(value) {
  if (!value) return "not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadAll();
setInterval(async () => {
  try {
    const updates = await api("/api/technology-updates");
    renderTechnologyUpdates(updates);
    if (updates.refreshing) scheduleTechnologyPoll();
  } catch (error) {
    $("techUpdatesStatus").textContent = error.message;
  }
}, 60000);
