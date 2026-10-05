const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { z } = require("zod");
const cheerio = require("cheerio");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const DEMO_MODE = process.env.DEMO_MODE !== "false";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const STATE_FILE = process.env.DAKINI_STATE_FILE;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/*
  POC storage only.
  Production version should replace these Maps with PostgreSQL/Prisma.
*/
const icps = new Map();
const sources = new Map();
const jobs = new Map();
const companies = new Map();
const googleOAuthStates = new Map();
const googleConnections = new Map();

function persistState() {
  if (!STATE_FILE) return;
  const state = {
    icps: [...icps.values()],
    sources: [...sources.values()],
    jobs: [...jobs.values()],
    companies: [...companies.values()]
  };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temporaryFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state), "utf8");
  fs.renameSync(temporaryFile, STATE_FILE);
}

function restoreState() {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const values = (collection) => Array.isArray(collection)
    ? collection.flatMap(item => Array.isArray(item?.value) ? item.value : [item])
    : Array.isArray(collection?.value)
      ? collection.value
      : [];
  for (const value of values(state.icps)) icps.set(value.id, value);
  for (const value of values(state.sources)) sources.set(value.id, value);
  for (const value of values(state.jobs)) jobs.set(value.id, value);
  for (const value of values(state.companies)) companies.set(value.id, value);
}

restoreState();

const ICP = z.object({
  name: z.string().min(1),
  industries: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  useCases: z.array(z.string()).default([])
});

const SOURCE = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  approved: z.boolean().default(false)
});

function id() {
  return crypto.randomUUID();
}

function normalizeDomain(url) {
  return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
}

function scoreLead(data, icp) {
  const industryMatches = icp.industries.some(target =>
    data.industry.toLowerCase().includes(target.toLowerCase()) ||
    target.toLowerCase().includes(data.industry.toLowerCase())
  );
  const useCaseMatches = icp.useCases.filter(target =>
    data.detectedUseCases.some(found =>
      found.toLowerCase().includes(target.toLowerCase()) ||
      target.toLowerCase().includes(found.toLowerCase())
    )
  );
  const locationMatches = icp.locations.some(target =>
    data.locations.some(found => found.toLowerCase() === target.toLowerCase()) ||
    data.sourceText.toLowerCase().includes(target.toLowerCase())
  );
  const components = {
    industryFit: icp.industries.length ? (industryMatches ? 20 : 0) : 10,
    useCaseFit: icp.useCases.length ? (useCaseMatches.length ? 25 : 0) : 12.5,
    locationFit: icp.locations.length ? (locationMatches ? 5 : 0) : 2.5,
    operationalNeed:
      (data.callingTeam ? 5 : 0) +
      (data.branches >= 2 ? 5 : 0) +
      (data.extendedHours ? 5 : 0) +
      (data.telephonyOrCrm ? 5 : 0),
    buyingSignals:
      (data.voiceHiringSignal ? 10 : 0) +
      (data.automationIntent ? 10 : 0) +
      (data.expansionSignal ? 3 : 0) +
      (data.fundingSignal ? 2 : 0),
    reachable: (data.roleEmail ? 3 : 0) + (data.phone ? 2 : 0)
  };
  const score = +Object.values(components).reduce((total, value) => total + value, 0).toFixed(1);
  const strongIcpMatch = (!icp.industries.length || industryMatches) &&
    (!icp.useCases.length || useCaseMatches.length > 0) &&
    (!icp.locations.length || locationMatches);
  const tier = score >= 70 && strongIcpMatch && data.voiceUseCase && data.buyingSignal
    ? "Priority"
    : score >= 50 && strongIcpMatch
      ? "Review"
      : "Low fit";

  return {
    score,
    tier,
    strongIcpMatch,
    buyingSignal: data.buyingSignal,
    matchedUseCases: useCaseMatches,
    components
  };
}

/*
  Very small rule-based extractor.
  It intentionally avoids a real LLM so the POC runs without an API key.
*/
function extract(text, sourceUrl, icp, companyNameOverride, directoryUrl, pageSources = []) {
  const lower = text.toLowerCase();
  const sourceForOffset = (offset) => {
    let pageOffset = 0;
    for (const page of pageSources) {
      if (offset < pageOffset + page.text.length) return page.url;
      pageOffset += page.text.length + 3;
    }
    return sourceUrl;
  };
  const allEmailMatches = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .filter(match => !/^(noreply|no-reply|donotreply)@/i.test(match[0]));
  const contactAlias = /^(info|contact|support|customercare|customer-care|help|enquir(?:y|ies)|grievance|feedback|business|corporate|sales|care|loan|cards?)(?:[._+-]|$)/i;
  const isContactPage = url => /contact|support|customer-care|help|grievance/i.test(new URL(url).pathname);
  const contactEmailMatches = allEmailMatches
    .filter(match => contactAlias.test(match[0].split("@")[0]) || isContactPage(sourceForOffset(match.index)))
    .sort((a, b) => Number(contactAlias.test(b[0].split("@")[0])) - Number(contactAlias.test(a[0].split("@")[0])));
  const emails = [...new Set(contactEmailMatches.map(match => match[0].toLowerCase()))].slice(0, 5);
  const phones = [...new Set([...text.matchAll(/(?:\+91[\s-]?)?[6-9]\d{9}/g)]
    .map(match => match[0].replace(/\s+/g, " ").trim()))].slice(0, 5);
  const email = emails[0] || "";
  const phone = phones[0] || "";

  const industry =
    lower.includes("bank") || lower.includes("nbfc") ? "BFSI" :
    lower.includes("hospital") || lower.includes("healthcare") ? "Healthcare" :
    lower.includes("school") || lower.includes("education") ? "Education" :
    lower.includes("real estate") ? "Real Estate" :
    lower.includes("logistics") ? "Logistics" :
    lower.includes("ecommerce") || lower.includes("d2c") ? "D2C" : "Unknown";

  const useCasePatterns = [
    ["collections", /collections|debt recovery|payment reminder/i],
    ["customer support", /customer support|customer service|customer care|help ?desk|contact center|call center|customer helpline/i],
    ["appointment scheduling", /appointment|booking|schedule a visit/i],
    ["lead qualification", /lead qualification|qualify leads|sales enquiries|sales inquiries/i],
    ["order support", /order status|delivery updates|order support/i],
    ["loan servicing", /\bloan(?:s|ing)?\b|emi\b|credit card|loan application/i],
    ["account and card support", /account balance|debit card|credit card|card services/i],
    ["branch and service queries", /branch locator|nearest branch|atm locator|business hours/i]
  ];
  const detectedUseCases = useCasePatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  const voiceUseCase = detectedUseCases.length > 0 ||
    /voice agent|voice automation|automated calls|high call volume|inbound calls|outbound calls/i.test(text);
  const voiceHiringSignal =
    /(?:hiring|careers|recruit(?:ing|ment)?)\s+(?:\w+\s+){0,3}(?:telecallers?|call center|contact center|customer support|collections)/i.test(text) ||
    /(?:telecallers?|call center|contact center|customer support|collections)\s+(?:\w+\s+){0,3}(?:hiring|careers|recruit(?:ing|ment)?)/i.test(text);
  const hiringSignal = /hiring|careers|recruit/i.test(text);
  const automationIntent =
    /(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for|request for proposal).{0,80}(?:ai|voice|automation|call center|contact center)|(?:ai|voice|automation|call center|contact center).{0,80}(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for|request for proposal)/i.test(text);

  const expansionSignal =
    /expansion|new branch|branches|new location|launch/i.test(text);

  const languages = ["Hindi", "English", "Tamil", "Kannada"].filter(x =>
    lower.includes(x.toLowerCase())
  );

  const branchesMatch = text.match(/(\d{1,4})\s*(?:branches|branch)/i);
  const branches = branchesMatch ? Number(branchesMatch[1]) : 0;
  const locations = icp.locations.filter(location => lower.includes(location.toLowerCase()));

  const companyName = companyNameOverride ||
    text.match(/(?:company|organisation|organization|business)\s*[:\-]\s*([^|.!?\n]{2,80})/i)?.[1]?.trim()
    || new URL(sourceUrl).hostname.replace(/^www\./, "");

  const evidence = [];
  const addEvidence = (field, pattern, confidence = 0.85) => {
    const match = text.match(pattern);
    if (match) {
      const blockStart = text.lastIndexOf("|", match.index) + 1;
      const blockEnd = text.indexOf("|", match.index);
      const start = blockStart;
      const end = blockEnd < 0 ? text.length : blockEnd;
      const quote = text.slice(start, end).trim();
      evidence.push({
        field,
        value: match[0],
        quote: quote.length > 180 ? `${quote.slice(0, 177)}...` : quote,
        source_url: sourceForOffset(match.index),
        confidence
      });
    }
  };
  if (industry !== "Unknown") addEvidence("industry", /(?:bank|nbfc|hospital|healthcare|school|education|real estate|logistics|ecommerce|d2c)/i);
  if (detectedUseCases.length) addEvidence("voiceUseCase", /collections|debt recovery|payment reminder|customer support|customer service|help ?desk|contact center|call center|appointment|booking|lead qualification|order status/i);
  if (voiceHiringSignal) addEvidence("voiceHiring", /(?:hiring|careers|recruit(?:ing|ment)?).{0,60}(?:telecallers?|call center|contact center|customer support|collections)|(?:telecallers?|call center|contact center|customer support|collections).{0,60}(?:hiring|careers|recruit(?:ing|ment)?)/i);
  if (automationIntent) addEvidence("automationIntent", /evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for.{0,40}|request for proposal|voice automation|ai voice agent/i);
  if (branches) addEvidence("operationalScale", /\d{1,4}\s*(?:branches|branch)/i);
  if (dataHasExtendedHours(text)) addEvidence("extendedHours", /24\/7|extended hours|8\s*(?:am|a\.m\.)/i);
  if (email) evidence.push({
    field: "roleEmail",
    value: email,
    quote: email,
    source_url: sourceForOffset(text.indexOf(email)),
    confidence: 0.95
  });
  if (phone) evidence.push({
    field: "phone",
    value: phone,
    quote: phone,
    source_url: sourceForOffset(text.indexOf(phone)),
    confidence: 0.95
  });
  for (const publicEmail of emails.slice(1)) evidence.push({
    field: "roleEmail",
    value: publicEmail,
    quote: publicEmail,
    source_url: sourceForOffset(text.indexOf(publicEmail)),
    confidence: 0.95
  });
  if (companyNameOverride) evidence.push({
    field: "companyName",
    value: companyNameOverride,
    quote: `${companyNameOverride} is listed in the RBI bank directory.`,
    source_url: directoryUrl,
    confidence: 0.95
  });

  const confidence = evidence.length ? Math.min(0.85, 0.5 + evidence.length * 0.04) : 0.4;

  const data = {
    companyName,
    domain: normalizeDomain(sourceUrl),
    industry,
    voiceUseCase,
    detectedUseCases,
    companyActivities: summarizeActivities(text),
    dakiniRecommendations: getDakiniRecommendations(detectedUseCases),
    locations,
    sourceText: text,
    callingTeam: /collections team|customer support team|call center|contact center|telecallers?/i.test(text),
    branches,
    languages,
    extendedHours: dataHasExtendedHours(text),
    telephonyOrCrm: /crm|freshdesk|salesforce|hubspot|telephony/i.test(text),
    hiringSignal,
    voiceHiringSignal,
    automationIntent,
    buyingSignal: automationIntent,
    expansionSignal,
    fundingSignal: /funding|raised|series [a-z]/i.test(text),
    roleEmail: email,
    contactEmails: emails,
    phone,
    contactPhones: phones,
    contactPages: pageSources
      .filter(page => /contact|support|customer-care/i.test(new URL(page.url).pathname))
      .map(page => page.url),
    requiredFieldsComplete: Boolean(companyName && industry !== "Unknown"),
    confidence,
    evidence
  };

  const score = scoreLead(data, icp);
  delete data.sourceText;
  return { ...data, score };
}

function summarizeActivities(text) {
  const candidates = text.split(/\s*\|\s*|(?<=[.!?])\s+/)
    .map(value => value.replace(/\s+/g, " ").trim())
    .filter(value => value.length >= 35 && value.length <= 260)
    .filter(value => /bank|financial|loan|deposit|payment|card|account|insurance|investment|customer|business|service|product/i.test(value))
    .filter(value => !/cookie|privacy policy|terms and conditions|javascript|copyright/i.test(value));
  return [...new Set(candidates)].slice(0, 3);
}

function getDakiniRecommendations(useCases) {
  const recommendations = {
    "collections": "Automate payment reminders and collections follow-ups with multilingual voice calls.",
    "customer support": "Handle routine customer-service calls, FAQs, and call routing with a voice agent.",
    "appointment scheduling": "Book, confirm, and reschedule customer appointments by voice.",
    "lead qualification": "Qualify inbound enquiries and route high-intent prospects to the right team.",
    "order support": "Answer order and delivery-status calls and provide proactive voice updates.",
    "loan servicing": "Automate loan and EMI enquiries, application-status calls, and payment reminders.",
    "account and card support": "Handle routine account and card queries, with secure escalation for sensitive requests.",
    "branch and service queries": "Answer branch, ATM, hours, and service-location questions around the clock."
  };
  return [...new Set(useCases.map(useCase => recommendations[useCase]).filter(Boolean))];
}

function extractPageText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  const title = $("title").text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() || "";
  const body = $("body").find("h1, h2, h3, p, li").map((_, element) =>
    $(element).text().replace(/\s+/g, " ").trim()
  ).get().filter(Boolean).join(" | ") || $("body").text().replace(/\s+/g, " ").trim();
  const text = [title, description, body].filter(Boolean).join(" | ");
  return { $, title, text: text.slice(0, 100000) };
}

function extractRelevantPageLinks($, baseUrl) {
  const base = new URL(baseUrl);
  const baseDomain = normalizeDomain(baseUrl);
  const candidates = new Map();
  const relevantPath = /about|who-we-are|our-story|product|service|solution|business|personal-banking|loan|credit|card|contact|support|customer-care|help|career|job|investor|branch|atm|collection/i;

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const label = $(element).text().replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) return;

    try {
      const url = new URL(href, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (normalizeDomain(url.href) !== baseDomain) return;
      if (!relevantPath.test(`${url.pathname} ${label}`)) return;
      if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?)(?:$|\?)/i.test(url.pathname)) return;
      url.hash = "";
      const normalizedUrl = url.href;
      if (normalizedUrl === base.href || candidates.has(normalizedUrl)) return;
      candidates.set(normalizedUrl, {
        url: normalizedUrl,
        label,
        priority: /contact|support|customer-care|help/i.test(`${url.pathname} ${label}`) ? 3 :
          /about|who-we-are|our-story|business/i.test(`${url.pathname} ${label}`) ? 2 : 1
      });
    } catch {
      return;
    }
  });

  return [...candidates.values()].sort((a, b) => b.priority - a.priority).map(({ url }) => url);
}

function extractBankLinks($, sourceUrl) {
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  const seenDomains = new Set();
  const bankLinks = [];

  $("a[href]").each((_, element) => {
    const name = $(element).text().replace(/\s+/g, " ").trim();
    if (!/\bbank\b/i.test(name)) return;

    try {
      const url = new URL($(element).attr("href"), sourceUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname.toLowerCase() === sourceHost) return;
      const domain = normalizeDomain(url.href);
      if (seenDomains.has(domain)) return;
      seenDomains.add(domain);
      bankLinks.push({ name, url: url.href });
    } catch {
      return;
    }
  });

  return bankLinks;
}

function dataHasExtendedHours(text) {
  return /24\/7|extended hours|8\s*(?:am|a\.m\.)/i.test(text);
}
async function fetchPage(url) {
  // POC safety checks: only http(s), reject localhost/private-looking hosts.
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/i.test(parsed.hostname)) {
    throw new Error("Private/local hosts are blocked");
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Dakini-POC/1.0" }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function runJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const visitedDomains = new Set();

  for (const sourceId of job.sourceIds) {
    const source = sources.get(sourceId);
    if (!source || !source.approved) {
      job.errors.push({ sourceId, reason: "Source is not approved" });
      continue;
    }

    try {
      const icp = icps.get(job.icpId);
      if (!icp) throw new Error("ICP not found");
      const html = DEMO_MODE
        ? DEMO_HTML
        : await fetchPage(source.url);

      const $ = cheerio.load(html);
      const bankLinks = DEMO_MODE ? [] : extractBankLinks($, source.url);
      if (bankLinks.length) {
        job.discoveredCompanies.push(...bankLinks.filter(bank => !visitedDomains.has(normalizeDomain(bank.url))));
        for (const bank of bankLinks) {
          const domain = normalizeDomain(bank.url);
          if (visitedDomains.has(domain)) continue;
          visitedDomains.add(domain);
          await crawlCompanySite(job, bank.url, icp, bank.name, source.url, sourceId);
        }
      } else {
        const domain = normalizeDomain(source.url);
        if (!visitedDomains.has(domain)) {
          visitedDomains.add(domain);
          await crawlCompanySite(job, source.url, icp, undefined, undefined, sourceId, html);
        }
      }
    } catch (error) {
      job.errors.push({ sourceId, reason: error.message });
    }
  }

  if (job.status === "running") job.status = "completed";
  job.completedAt = new Date().toISOString();
  persistState();
}

async function crawlCompanySite(job, homeUrl, icp, companyName, directoryUrl, sourceId, homeHtml) {
  const pages = [];
  try {
    const html = homeHtml || await fetchPage(homeUrl);
    const homepage = extractPageText(html);
    pages.push({ url: homeUrl, title: homepage.title, text: homepage.text });
    job.pages += 1;

    const internalLinks = DEMO_MODE ? [] : extractRelevantPageLinks(homepage.$, homeUrl)
      .slice(0, job.maxPagesPerCompany - 1);
    for (const pageUrl of internalLinks) {
      try {
        const pageHtml = await fetchPage(pageUrl);
        const page = extractPageText(pageHtml);
        pages.push({ url: pageUrl, title: page.title, text: page.text });
        job.pages += 1;
      } catch (error) {
        job.errors.push({ sourceId, company: companyName || normalizeDomain(homeUrl), url: pageUrl, reason: error.message });
      }
    }

    saveCompany(pages, homeUrl, icp, companyName, directoryUrl);
    job.records += 1;
    job.companiesVisited += 1;
  } catch (error) {
    job.errors.push({ sourceId, company: companyName || normalizeDomain(homeUrl), url: homeUrl, reason: error.message });
  }
}

function saveCompany(pages, sourceUrl, icp, companyName, directoryUrl) {
  const pageSources = pages.map(({ url, text }) => ({ url, text }));
  const text = pages.map(page => page.text).join(" | ");
  const record = extract(text, sourceUrl, icp, companyName, directoryUrl, pageSources);
  record.title = pages[0]?.title || "";
  record.sourceUrl = sourceUrl;
  record.directoryUrl = directoryUrl || "";
  record.pagesScanned = pages.map(({ url, title }) => ({ url, title }));
  record.capturedAt = new Date().toISOString();

  const companyId = normalizeDomain(sourceUrl);
  companies.set(companyId, { id: companyId, ...record });
}

/* Health */
app.get("/healthz", (req, res) => res.json({ ok: true }));
function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function createGoogleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function readGoogleSessionId(req) {
  const match = req.headers.cookie?.match(/(?:^|;\s*)dakini_google_session=([^;]+)/);
  return match?.[1] || "";
}

function setGoogleSessionCookie(res, sessionId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `dakini_google_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`
  );
}

app.get("/api/config", (req, res) => res.json({
  demoMode: DEMO_MODE,
  googleConfigured: isGoogleConfigured()
}));

app.get("/api/google/status", (req, res) => {
  const connection = googleConnections.get(readGoogleSessionId(req));
  res.json({
    configured: isGoogleConfigured(),
    connected: Boolean(connection),
    spreadsheetUrl: connection?.spreadsheetUrl || ""
  });
});

app.get("/auth/google", (req, res) => {
  if (!isGoogleConfigured()) {
    return res.redirect(`/?googleError=${encodeURIComponent("Google Sheets is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")}`);
  }

  const sessionId = readGoogleSessionId(req) || crypto.randomBytes(32).toString("hex");
  setGoogleSessionCookie(res, sessionId);
  const state = crypto.randomBytes(32).toString("hex");
  googleOAuthStates.set(state, { sessionId, createdAt: Date.now() });

  const oauth = createGoogleOAuthClient();
  const authorizationUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file"
    ],
    state
  });
  res.redirect(authorizationUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const stateRecord = googleOAuthStates.get(state);
  googleOAuthStates.delete(state);
  const sessionId = readGoogleSessionId(req);

  if (!stateRecord || stateRecord.sessionId !== sessionId ||
      Date.now() - stateRecord.createdAt > 10 * 60 * 1000) {
    return res.redirect(`/?googleError=${encodeURIComponent("Google sign-in expired. Please connect again.")}`);
  }
  if (req.query.error) {
    return res.redirect(`/?googleError=${encodeURIComponent("Google authorization was not completed.")}`);
  }
  if (typeof req.query.code !== "string") {
    return res.redirect(`/?googleError=${encodeURIComponent("Google did not return an authorization code.")}`);
  }

  try {
    const oauth = createGoogleOAuthClient();
    const { tokens } = await oauth.getToken(req.query.code);
    googleConnections.set(sessionId, { tokens, spreadsheetId: "", spreadsheetUrl: "" });
    res.redirect("/?google=connected");
  } catch (error) {
    console.error("Google OAuth callback failed:", error.message);
    res.redirect(`/?googleError=${encodeURIComponent("Google sign-in failed. Please try again.")}`);
  }
});

app.post("/api/google/sheets", async (req, res) => {
  const sessionId = readGoogleSessionId(req);
  const connection = googleConnections.get(sessionId);
  if (!connection) return res.status(401).json({ error: "Connect your Google account before syncing." });

  const companiesToSync = [...companies.values()].sort((a, b) => b.score.score - a.score.score);
  if (!companiesToSync.length) return res.status(400).json({ error: "There are no prospect results to sync yet." });

  try {
    const oauth = createGoogleOAuthClient();
    oauth.setCredentials(connection.tokens);
    oauth.on("tokens", tokens => {
      connection.tokens = { ...connection.tokens, ...tokens };
      googleConnections.set(sessionId, connection);
    });
    const sheets = google.sheets({ version: "v4", auth: oauth });
    let spreadsheetId = connection.spreadsheetId;

    if (!spreadsheetId) {
      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: "Dakini AI Prospects" },
          sheets: [{ properties: { title: "Prospects", gridProperties: { frozenRowCount: 1 } } }]
        }
      });
      spreadsheetId = created.data.spreadsheetId;
      connection.spreadsheetId = spreadsheetId;
      connection.spreadsheetUrl = created.data.spreadsheetUrl;
    }

    const values = [
      [
        "Rank", "Company", "Fit score", "Fit tier", "Industry", "What they do",
        "Dakini AI opportunities", "Public business emails", "Public business phones",
        "Contact page", "Company website", "Evidence confidence"
      ],
      ...companiesToSync.map((company, index) => [
        index + 1,
        company.companyName,
        company.score.score,
        company.score.tier,
        company.industry,
        company.companyActivities.join(" | "),
        company.dakiniRecommendations.join(" | "),
        company.contactEmails.join(" | "),
        company.contactPhones.join(" | "),
        company.contactPages[0] || "",
        company.sourceUrl,
        `${Math.round(company.confidence * 100)}%`
      ].map(value => String(value ?? "").replace(/^[\s]*[=+\-@]/, "'$&")))
    ];

    if (connection.spreadsheetUrl) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: "Prospects!A:Z"
      });
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Prospects!A1",
      valueInputOption: "RAW",
      requestBody: { values }
    });

    googleConnections.set(sessionId, connection);
    res.json({
      spreadsheetUrl: connection.spreadsheetUrl,
      rows: companiesToSync.length
    });
  } catch (error) {
    console.error("Google Sheets sync failed:", error.message);
    res.status(502).json({ error: "Could not sync to Google Sheets. Check the OAuth setup and try again." });
  }
});

/* ICP */
app.get("/api/icps", (req, res) => res.json([...icps.values()]));

app.post("/api/icps", (req, res) => {
  const parsed = ICP.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = { id: id(), ...parsed.data };
  icps.set(item.id, item);
  persistState();
  res.status(201).json(item);
});

/* Sources */
app.get("/api/sources", (req, res) => res.json([...sources.values()]));

app.post("/api/sources", (req, res) => {
  const parsed = SOURCE.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = {
    id: id(),
    ...parsed.data,
    domain: normalizeDomain(parsed.data.url),
    createdAt: new Date().toISOString()
  };
  sources.set(item.id, item);
  persistState();
  res.status(201).json(item);
});

/* Crawl job */
app.post("/api/jobs", (req, res) => {
  const schema = z.object({
    sourceIds: z.array(z.string()).min(1),
    maxPagesPerCompany: z.number().int().positive().max(10).default(6),
    icpId: z.string().optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const icpId = parsed.data.icpId || [...icps.keys()].at(-1);
  if (!icpId || !icps.has(icpId)) {
    return res.status(400).json({ error: "Create an ICP before starting a crawl." });
  }

  const job = {
    id: id(),
    ...parsed.data,
    icpId,
    pages: 0,
    records: 0,
    companiesVisited: 0,
    discoveredCompanies: [],
    errors: [],
    status: "queued"
  };

  jobs.set(job.id, job);
  persistState();
  runJob(job);
  res.status(202).json(job);
});

app.get("/api/jobs", (req, res) => res.json([...jobs.values()]));

/* Companies */
app.get("/api/companies", (req, res) => res.json([...companies.values()]));

/* Dashboard */
app.get("/api/dashboard", (req, res) => {
  const list = [...companies.values()];
  res.json({
    companies: list.length,
    priority: list.filter(x => x.score.tier === "Priority").length,
    review: list.filter(x => x.score.tier === "Review").length,
    lowFit: list.filter(x => x.score.tier === "Low fit").length,
    jobs: jobs.size
  });
});

const DEMO_HTML = `
<!doctype html>
<html>
<head><title>Demo Finance Company</title></head>
<body>
  <h1>Example Finance Company</h1>
  <p>Company: Example Finance Pvt Ltd</p>
  <p>We are an NBFC serving customers across India.</p>
  <p>We operate 140 branches across India.</p>
  <p>Our collections team is hiring telecallers and customer support executives.</p>
  <p>We are evaluating AI voice automation to handle high call volumes for collections and customer support.</p>
  <p>We support Hindi, Tamil and Kannada.</p>
  <p>Customer support operates 8 AM to 8 PM.</p>
  <p>Our CRM uses Freshdesk.</p>
  <p>Email: collections@example.com</p>
  <p>Phone: +919876543210</p>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`Dakini POC running at http://localhost:${PORT}`);
});
