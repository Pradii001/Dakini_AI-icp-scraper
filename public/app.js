const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 15;
let activeIcpId;
let allCompanies = [];
let currentPage = 1;
let googleConnected = false;
let spreadsheetUrl = "";
let crawlPollTimer;
let discoveryPollTimer;
let sourceDiscoveryPollTimer;

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

$("publicSourceList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-source-id]");
  if (!button) return;
  button.disabled = true;
  $("publicSourceResult").textContent = "Adding official source...";
  try {
    const source = await api(`/api/public-sources/${encodeURIComponent(button.dataset.sourceId)}`, {
      method: "POST"
    });
    $("publicSourceResult").textContent = source.alreadyAdded
      ? `${source.name} is already in your approved sources.`
      : `Added ${source.name} as an approved source.`;
    renderPublicSources(await api("/api/public-sources"));
  } catch (error) {
    $("publicSourceResult").textContent = error.message;
    button.disabled = false;
  }
});

$("findSourcesBtn").addEventListener("click", async () => {
  const button = $("findSourcesBtn");
  button.disabled = true;
  $("sourceDiscoveryStatus").textContent = "Searching for public registries and directories...";
  try {
    await api("/api/source-discovery/run-now", { method: "POST" });
    pollSourceDiscovery();
  } catch (error) {
    $("sourceDiscoveryStatus").textContent = error.message;
    button.disabled = false;
  }
});

$("sourceCandidateList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-source-action]");
  if (!button) return;
  button.disabled = true;
  const candidateId = encodeURIComponent(button.dataset.candidateId);
  const action = button.dataset.sourceAction;
  try {
    await api(`/api/source-candidates/${candidateId}/${action}`, { method: "POST" });
    $("sourceDiscoveryStatus").textContent = action === "approve"
      ? "Source approved. It is ready for ICP crawls and scheduled retrieval."
      : "Source dismissed; it will no longer appear in the candidate queue.";
    renderSourceCandidates(await api("/api/source-candidates"));
    renderPublicSources(await api("/api/public-sources"));
  } catch (error) {
    $("sourceDiscoveryStatus").textContent = error.message;
    button.disabled = false;
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

function renderPublicSources(publicSources) {
  const list = $("publicSourceList");
  list.replaceChildren();
  for (const source of publicSources) {
    const item = document.createElement("div");
    item.className = "public-source-item";
    const details = document.createElement("div");
    const name = document.createElement("a");
    name.href = source.url;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    name.className = "public-source-name";
    name.textContent = source.name;
    const description = document.createElement("span");
    description.textContent = source.description;
    details.append(name, description);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button";
    button.dataset.sourceId = source.id;
    button.disabled = source.added;
    button.textContent = source.added ? "Added" : "Add source";
    item.append(details, button);
    list.append(item);
  }
}

function renderSourceCandidates(candidates) {
  const list = $("sourceCandidateList");
  list.replaceChildren();
  const pending = candidates.filter(candidate => candidate.status === "pending");
  if (!pending.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No pending sources. Run a search or wait for the daily source scan.";
    list.append(empty);
    return;
  }
  for (const candidate of pending) {
    const item = document.createElement("article");
    item.className = "public-source-item source-candidate";
    const details = document.createElement("div");
    const name = document.createElement("a");
    name.href = candidate.url;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
    name.className = "public-source-name";
    name.textContent = candidate.name;
    const description = document.createElement("span");
    description.textContent = `${candidate.authorityDomain} · ${candidate.listedCompanyLinks} linked company sites · ${candidate.confidence}% confidence`;
    const evidence = document.createElement("small");
    evidence.textContent = candidate.description || "Public company directory validated.";
    details.append(name, description, evidence);
    const actions = document.createElement("div");
    actions.className = "source-candidate-actions";
    for (const [action, label] of [["approve", "Approve"], ["dismiss", "Dismiss"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "approve" ? "secondary-button" : "secondary-button";
      button.dataset.sourceAction = action;
      button.dataset.candidateId = candidate.id;
      button.textContent = label;
      actions.append(button);
    }
    item.append(details, actions);
    list.append(item);
  }
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
    $("discoveryStatus").textContent = `Searching ${job.searchesCompleted}/${status.dailySearchQueries} queries · ${job.qualifiedProspectsAdded || 0} qualified prospects added · ${job.companiesVisited} sites visited · ${job.pages} pages scanned · ${job.errors} errors${job.rateLimited ? " · provider rate limit reached" : ""}`;
    discoveryPollTimer = setTimeout(() => pollDiscovery(jobId), 4000);
  } catch (error) {
    $("discoveryStatus").textContent = error.message;
    $("runDiscoveryBtn").disabled = false;
  }
}

async function pollSourceDiscovery() {
  sourceDiscoveryPollTimer = null;
  try {
    const [status, candidates] = await Promise.all([
      api("/api/discovery/status"),
      api("/api/source-candidates")
    ]);
    renderSourceCandidates(candidates);
    const job = status.activeSourceDiscovery;
    if (!job) {
      $("findSourcesBtn").disabled = false;
      const summary = status.lastSourceDiscoverySummary;
      $("sourceDiscoveryStatus").textContent = summary
        ? `Source search complete: ${summary.candidatesDiscovered} candidates found across ${summary.searchesCompleted} searches.${status.lastSourceDiscoveryError ? ` ${status.lastSourceDiscoveryError}` : ""}`
        : "Source search complete.";
      return;
    }
    $("sourceDiscoveryStatus").textContent = `Searching ${job.searchesCompleted}/${job.totalSearchQueries} queries · ${job.candidatesChecked} possible directories checked · ${job.candidatesDiscovered} candidates validated · ${job.errors} errors`;
    sourceDiscoveryPollTimer = setTimeout(pollSourceDiscovery, 3000);
  } catch (error) {
    $("sourceDiscoveryStatus").textContent = error.message;
    $("findSourcesBtn").disabled = false;
  }
}

async function loadAll() {
  try {
    const [config, googleStatus, discoveryStatus, jobs, dashboard, companies, publicSources, sourceCandidates] = await Promise.all([
      api("/api/config"),
      api("/api/google/status"),
      api("/api/discovery/status"),
      api("/api/jobs"),
      api("/api/dashboard"),
      api("/api/companies"),
      api("/api/public-sources"),
      api("/api/source-candidates")
    ]);
    renderPublicSources(publicSources);
    renderSourceCandidates(sourceCandidates);
    $("modeNotice").textContent = config.demoMode
      ? "DEMO MODE · Manual crawls use simulated data; daily web discovery (when configured) visits public company websites."
      : "LIVE MODE · Public approved websites are being used.";

    const activeCompanyCrawl = jobs.some(job =>
      ["running", "queued"].includes(job.status) &&
      job.kind !== "daily_web_discovery" &&
      job.kind !== "manual_web_discovery"
    );
    $("runDiscoveryBtn").disabled = !discoveryStatus.configured ||
      Boolean(discoveryStatus.activeJob || discoveryStatus.activePublicDirectoryRetrieval || activeCompanyCrawl);
    $("findSourcesBtn").disabled = Boolean(
      discoveryStatus.activeSourceDiscovery || discoveryStatus.activeJob ||
      discoveryStatus.activePublicDirectoryRetrieval || activeCompanyCrawl
    );
    if (discoveryStatus.activeSourceDiscovery) {
      const job = discoveryStatus.activeSourceDiscovery;
      $("sourceDiscoveryStatus").textContent = `Searching ${job.searchesCompleted}/${job.totalSearchQueries} queries · ${job.candidatesChecked} possible directories checked · ${job.candidatesDiscovered} candidates validated · ${job.errors} errors`;
      if (!sourceDiscoveryPollTimer) sourceDiscoveryPollTimer = setTimeout(pollSourceDiscovery, 3000);
    } else if (discoveryStatus.lastSourceDiscoveryAt) {
      const summary = discoveryStatus.lastSourceDiscoverySummary;
      $("sourceDiscoveryStatus").textContent = `Last source search: ${formatDate(discoveryStatus.lastSourceDiscoveryAt)} · ${summary?.candidatesDiscovered || 0} candidates from ${summary?.searchesCompleted || 0} searches.${discoveryStatus.lastSourceDiscoveryError ? ` ${discoveryStatus.lastSourceDiscoveryError}` : ""}`;
    } else {
      $("sourceDiscoveryStatus").textContent = "No source search has run yet. Candidates require approval before crawling.";
    }
    if (!discoveryStatus.configured) {
      $("discoveryStatus").textContent = "Web search is temporarily unavailable. Retry shortly.";
      $("discoverySetupStatus").textContent = "The free keyless search provider may be rate-limited. Search coverage is broad, not the entire internet.";
    } else if (discoveryStatus.activePublicDirectoryRetrieval) {
      const job = discoveryStatus.activePublicDirectoryRetrieval;
      $("discoveryStatus").textContent = `Retrieving official public directories · ${job.companiesVisited}/${job.companiesDiscovered} companies visited · ${job.qualifiedProspectsAdded || 0} qualified prospects added · ${job.pages} pages · ${job.errors} errors`;
      $("discoverySetupStatus").textContent = `Daily web discovery is complete. The scheduled retrieval is processing newly listed company websites from the approved public directories. Previously captured companies are skipped; only Priority and Research-tier candidates are retained.`;
      $("runDiscoveryBtn").disabled = true;
    } else if (discoveryStatus.activeJob) {
      const job = discoveryStatus.activeJob;
      const providerPlan = discoveryStatus.authenticatedSearchConfigured
        ? "Authenticated search is configured; provider quotas still apply."
        : "Keyless search has lower rate limits; add a Firecrawl or Brave API key for higher provider limits.";
      const directorySources = discoveryStatus.publicDirectorySources
        .filter(source => source.approved)
        .map(source => source.name);
      const directorySchedule = directorySources.length
        ? ` Approved public directories are automatically retrieved after daily web discovery: ${directorySources.join(", ")}.`
        : " Add an official directory in Configuration to include it in daily retrieval.";
      $("discoveryStatus").textContent = `Searching with ${discoveryStatus.provider} · ${job.searchesCompleted}/${discoveryStatus.dailySearchQueries} queries · ${job.qualifiedProspectsAdded || 0} qualified prospects added · ${job.companiesVisited}/${job.companiesDiscovered} sites visited · ${job.pages} pages${job.rateLimited ? " · provider rate limit reached" : ""}`;
      $("discoverySetupStatus").textContent = `No daily lead quota or per-run company cap. The system runs all ${discoveryStatus.dailySearchQueries} searches and requests up to ${discoveryStatus.resultsPerQuery} results per query, subject to provider quotas and search coverage. It checks company homepages and up to ${discoveryStatus.maxPagesPerCompany} relevant pages per site; previously saved domains are not added again.${directorySchedule} ${providerPlan} Schedule: ${discoveryStatus.schedule}. Next run: ${formatDate(discoveryStatus.nextRunAt)}.`;
      $("runDiscoveryBtn").disabled = true;
      if (!discoveryPollTimer) discoveryPollTimer = setTimeout(() => pollDiscovery(job.id), 4000);
    } else {
      const lastSummary = discoveryStatus.lastRunSummary
        ? ` Last run: ${discoveryStatus.lastRunSummary.qualifiedProspectsAdded || 0} qualified prospects added from ${discoveryStatus.lastRunSummary.sitesVisited} sites.`
        : "";
      const lastRun = discoveryStatus.lastRunAt ? `Last run: ${formatDate(discoveryStatus.lastRunAt)}. ` : "No daily discovery run has completed yet. ";
      const lastError = discoveryStatus.lastError ? ` Latest issue: ${discoveryStatus.lastError}` : "";
      const directorySummary = discoveryStatus.lastPublicDirectoryRetrievalAt
        ? ` Latest public-directory retrieval: ${discoveryStatus.lastPublicDirectoryRetrievalSummary?.companiesVisited || 0} companies checked, ${discoveryStatus.lastPublicDirectoryRetrievalSummary?.qualifiedProspectsAdded || 0} qualified prospects added, ${discoveryStatus.lastPublicDirectoryRetrievalSummary?.errors || 0} errors.`
        : " Official public directories will be retrieved after the next scheduled web-discovery run.";
      const directoryError = discoveryStatus.lastPublicDirectoryRetrievalError
        ? ` Directory retrieval issue: ${discoveryStatus.lastPublicDirectoryRetrievalError}`
        : "";
      const providerPlan = discoveryStatus.authenticatedSearchConfigured
        ? "Authenticated search is configured; provider quotas still apply."
        : "Keyless search has lower rate limits; configure FIRECRAWL_API_KEY or BRAVE_SEARCH_API_KEY for higher provider limits.";
      $("discoveryStatus").textContent = `${discoveryStatus.provider} · ${lastRun}${lastSummary} Next search: ${formatDate(discoveryStatus.nextRunAt)} · ${discoveryStatus.schedule}.${lastError}${directoryError}`;
      $("discoverySetupStatus").textContent = `No daily lead quota or per-run company cap. Each run searches all ${discoveryStatus.dailySearchQueries} queries and requests up to ${discoveryStatus.resultsPerQuery} results per query, subject to provider quotas and search coverage. The crawler checks homepages and up to ${discoveryStatus.maxPagesPerCompany} relevant pages per site, and saves only Priority or Research-tier candidates with reachable company websites. Previously saved domains are not added again.${directorySummary}${directoryError} ${providerPlan} The server must remain running for scheduled discovery.${lastError}`;
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
