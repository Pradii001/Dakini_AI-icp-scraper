const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 15;
let activeIcpId;
let allCompanies = [];
let currentPage = 1;
let googleConnected = false;
let spreadsheetUrl = "";
let crawlPollTimer;

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
        maxPagesPerCompany: 6,
        ...(activeIcpId ? { icpId: activeIcpId } : {})
      })
    });
    pollJob(job.id);
  } catch (error) {
    $("jobResult").textContent = error.message;
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

function csvSafeText(value) {
  const text = String(value ?? "");
  return /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
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

  $("companies").innerHTML = pageCompanies.map((company, index) => `
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
            <p><strong>Pages scanned:</strong> ${company.pagesScanned.length}</p>
            <p><a href="${escapeHtml(company.sourceUrl)}" target="_blank" rel="noopener noreferrer">Company website</a> · <a href="${escapeHtml(company.directoryUrl || company.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a></p>
          </div>
        </details>
      </td>
    </tr>
  `).join("");
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

async function loadAll() {
  try {
    const [config, googleStatus, jobs, dashboard, companies] = await Promise.all([
      api("/api/config"),
      api("/api/google/status"),
      api("/api/jobs"),
      api("/api/dashboard"),
      api("/api/companies")
    ]);
    $("modeNotice").textContent = config.demoMode
      ? "DEMO MODE · Company pages are simulated; no live websites are fetched."
      : "LIVE MODE · Public approved websites are being used.";

    googleConnected = googleStatus.connected;
    spreadsheetUrl = googleStatus.spreadsheetUrl || "";
    $("googleSheetsBtn").disabled = !googleStatus.configured;
    $("googleSheetsBtn").textContent = !googleStatus.configured
      ? "Google Sheets setup required"
      : googleConnected ? "Sync to Google Sheets" : "Connect Google Sheets";
    if (!googleStatus.configured) {
      $("googleStatus").textContent = "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Sheets sync.";
    } else if (googleConnected && spreadsheetUrl) {
      showGoogleStatus("Google connected.", spreadsheetUrl);
    } else if (googleConnected) {
      $("googleStatus").textContent = "Google connected. Sync to create your prospect sheet.";
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

    const activeJob = jobs.slice().reverse().find(job => job.status === "running" || job.status === "queued");
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadAll();
