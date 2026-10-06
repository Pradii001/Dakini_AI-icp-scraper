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
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const WEB_SEARCH_PROVIDER = BRAVE_SEARCH_API_KEY
  ? "Brave Search"
  : FIRECRAWL_API_KEY ? "Firecrawl (authenticated)" : "Firecrawl (free keyless)";
const DISCOVERY_TIME = process.env.DISCOVERY_TIME || "09:00";
const DISCOVERY_TIME_ZONE = process.env.DISCOVERY_TIME_ZONE || "Asia/Kolkata";
const DAILY_NEW_PROSPECT_TARGET = 100;
const MAX_DAILY_DISCOVERY_COMPANIES = 200;
const MAX_RESULTS_PER_SEARCH = 10;
const DISCOVERY_REFRESH_DAYS = 30;
const MAX_PAGES_PER_COMPANY = 8;
const DISCOVERY_CRAWL_CONCURRENCY = 4;
const SCORE_VERSION = 3;
const TECH_UPDATE_RESULTS_PER_QUERY = 6;
const MAX_TECH_STORY_AGE_DAYS = 7;

if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(DISCOVERY_TIME)) {
  throw new Error("DISCOVERY_TIME must be a valid 24-hour time such as 09:00.");
}
try {
  new Intl.DateTimeFormat("en-US", { timeZone: DISCOVERY_TIME_ZONE }).format(new Date());
} catch {
  throw new Error("DISCOVERY_TIME_ZONE must be a valid IANA time zone.");
}

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
const discoveryState = {
  lastRunAt: null,
  lastRunSummary: null,
  lastError: "",
  nextRunAt: null,
  activeJobId: null
};
const technologyState = {
  items: [],
  lastUpdatedAt: null,
  lastError: "",
  refreshing: false
};
let lastFreeSearchStartedAt = 0;

function persistState() {
  if (!STATE_FILE) return;
  const state = {
    icps: [...icps.values()],
    sources: [...sources.values()],
    jobs: [...jobs.values()],
    companies: [...companies.values()],
    discoveryState,
    technologyState
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
  Object.assign(discoveryState, state.discoveryState || {});
  Object.assign(technologyState, state.technologyState || {});
  technologyState.refreshing = false;
  if (discoveryState.activeJobId) {
    const interruptedJob = jobs.get(discoveryState.activeJobId);
    if (interruptedJob && ["running", "queued"].includes(interruptedJob.status)) {
      interruptedJob.status = "interrupted";
      interruptedJob.completedAt = new Date().toISOString();
      interruptedJob.error = "Server restarted while this discovery job was running.";
    }
    discoveryState.activeJobId = null;
  }
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

const DAKINI_WORKFLOW_RECOMMENDATIONS = {
  "customer support": "Use multilingual voice support for routine customer questions and complaints, with customer-context lookup and escalation for complex issues.",
  "lead qualification": "Qualify sales leads against agreed criteria, then route high-intent prospects to the sales team.",
  "sales follow-up": "Automate sales follow-ups and demo scheduling; Dakini's public site describes lead qualification and meeting scheduling.",
  "knowledge and FAQs": "Provide round-the-clock voice answers to repeat questions and procedures, escalating cases that need a person.",
  "product recommendations": "Use a conversational sales agent to answer product questions and make personalized recommendations; verify voice and catalog integration scope.",
  "appointment scheduling": "A voice agent could book or reschedule appointments; confirm the required calendar integration and workflow before pitching.",
  "collections": "Payment reminders and collections follow-ups are a potential voice workflow; confirm Dakini's compliance and payment-provider support before proposing it.",
  "order support": "Answer order, delivery, and return questions; verify access to the company's order-management data.",
  "loan servicing": "Handle routine loan and EMI questions with secure escalation; do not request credentials or expose sensitive financial details.",
  "account and card support": "Answer routine account or policy questions using approved customer context, with sensitive requests escalated to a human.",
  "branch and service queries": "Answer location, branch, and operating-hours questions in the customer's preferred supported language.",
  "reservations and bookings": "A voice agent could answer availability and booking questions; verify booking-system integration before proposing implementation.",
  "healthcare intake": "A voice agent could route enquiries and support appointment intake; verify privacy, clinical-safety, and integration requirements.",
  "technical support": "Resolve repeat troubleshooting and service questions, with complex issues transferred to a human support team.",
  "dispatch and field service": "A voice agent could coordinate service appointments and dispatch enquiries; verify scheduling and field-system integration."
};
const DAKINI_CORE_WORKFLOWS = new Set([
  "customer support",
  "lead qualification",
  "sales follow-up",
  "knowledge and FAQs",
  "product recommendations"
]);
const DAKINI_USE_CASE_PATTERNS = [
  ["customer support", /customer support|customer service|customer care|help ?desk|contact center|call center|customer helpline|inbound calls|customer quer(?:y|ies)|support requests|complaints/i],
  ["lead qualification", /lead qualification|qualify leads|sales enquiries|sales inquiries|lead generation|prospect qualification/i],
  ["sales follow-up", /sales follow.?up|follow.?up calls|schedule demos?|demo booking|sales agent|sales calls/i],
  ["knowledge and FAQs", /knowledge agent|frequently asked questions|\bFAQs?\b|self.service|policy questions|process questions|answer(?:ing)? queries/i],
  ["appointment scheduling", /appointment|booking|schedule a visit|reschedule/i],
  ["collections", /collections|debt recovery|payment reminder/i],
  ["order support", /order status|delivery updates|order support|returns|shipment tracking/i],
  ["loan servicing", /\bloan(?:s|ing)?\b|emi\b|credit card|loan application/i],
  ["account and card support", /account balance|debit card|credit card|card services|policy servicing|insurance claim/i],
  ["branch and service queries", /branch locator|nearest branch|atm locator|business hours/i],
  ["reservations and bookings", /reservation|hotel booking|travel booking|room booking/i],
  ["healthcare intake", /patient intake|medical appointment|clinic appointment|healthcare helpline/i],
  ["technical support", /technical support|troubleshooting|IT help ?desk/i],
  ["dispatch and field service", /dispatch|field service|service appointment|repair booking/i],
  ["product recommendations", /product recommendations?|personalized shopping|product discovery|shopping assistant/i]
];

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
  const dakiniWorkflowMatches = data.detectedUseCases.filter(useCase =>
    DAKINI_CORE_WORKFLOWS.has(useCase)
  );
  const components = {
    serviceFit: Math.min(35, dakiniWorkflowMatches.length
      ? 15 + (dakiniWorkflowMatches.length - 1) * 10
      : 0),
    operatingScale:
      (data.callingTeam ? 5 : 0) +
      (data.branches >= 2 ? 4 : 0) +
      (data.highCallVolume ? 6 : 0) +
      (data.extendedHours ? 5 : 0),
    indiaMarketFit: (data.indiaMarketSignal ? 8 : 0) + (data.multilingualSignal ? 7 : 0),
    integrationReadiness:
      (data.telephonyOrCrm ? 6 : 0) +
      (data.systemIntegrationSignal ? 4 : 0),
    buyingSignals:
      (data.automationIntent ? 10 : 0) +
      (data.voiceHiringSignal ? 3 : 0) +
      (data.expansionSignal ? 2 : 0),
    reachability: (data.roleEmail ? 3 : 0) + (data.phone ? 2 : 0)
  };
  const rawScore = Object.values(components).reduce((total, value) => total + value, 0);
  components.aiVendorExclusion = data.aiSolutionProvider ? -Math.max(0, rawScore - 20) : 0;
  const score = +(rawScore + components.aiVendorExclusion).toFixed(1);
  const strongIcpMatch = (!icp.industries.length || industryMatches) &&
    (!icp.useCases.length || useCaseMatches.length > 0) &&
    (!icp.locations.length || locationMatches);
  const tier = !data.aiSolutionProvider && score >= 70 && strongIcpMatch && dakiniWorkflowMatches.length > 0 && data.buyingSignal
    ? "Priority"
    : !data.aiSolutionProvider && score >= 45 && strongIcpMatch && dakiniWorkflowMatches.length > 0
      ? "Review"
      : "Low fit";

  return {
    score,
    tier,
    strongIcpMatch,
    buyingSignal: data.buyingSignal,
    matchedUseCases: useCaseMatches,
    dakiniWorkflowMatches,
    exclusionReason: data.aiSolutionProvider
      ? "This company appears to sell AI, voice-agent, or contact-center software rather than primarily operate as a potential customer."
      : "",
    components
  };
}

/*
  Very small rule-based extractor.
  It intentionally avoids a real LLM so the POC runs without an API key.
*/
function extract(text, sourceUrl, icp, companyNameOverride, directoryUrl, pageSources = []) {
  const analysisPages = pageSources.filter(page => page.sourceType !== "web search");
  if (analysisPages.length) text = analysisPages.map(page => page.text).join(" | ");
  const lower = text.toLowerCase();
  const sourceForOffset = (offset) => {
    let pageOffset = 0;
    for (const page of analysisPages.length ? analysisPages : pageSources) {
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
  const labeledPhoneMatches = [...text.matchAll(/(?:phone|telephone|tel|mobile|call|hotline|contact)\s*(?:number)?\s*[:\-]?\s*(\+?\d[\d\s().-]{6,}\d)/gi)]
    .map(match => match[1]);
  const internationalPhoneMatches = [...text.matchAll(/(?<!\w)\+\d{1,3}(?:[\s().-]*\d){7,14}(?!\w)/g)]
    .map(match => match[0]);
  const phones = [...new Set([...labeledPhoneMatches, ...internationalPhoneMatches]
    .map(value => value.replace(/[^\d+]/g, ""))
    .filter(value => {
      const digitCount = value.replace(/\D/g, "").length;
      return digitCount >= 7 && digitCount <= 15;
    }))].slice(0, 5);
  const email = emails[0] || "";
  const phone = phones[0] || "";

  const industry =
    /bank|nbfc|financial services|fintech|lending/i.test(text) ? "BFSI" :
    /insurance|insurer|policyholder/i.test(text) ? "Insurance" :
    /hospital|healthcare|clinic|patient/i.test(text) ? "Healthcare" :
    /school|education|university|college/i.test(text) ? "Education" :
    /real estate|property management|realtor/i.test(text) ? "Real Estate" :
    /logistics|shipping|freight|courier/i.test(text) ? "Logistics" :
    /ecommerce|e-commerce|d2c|online store/i.test(text) ? "E-commerce" :
    /retail|retailer|store locations/i.test(text) ? "Retail" :
    /hotel|hospitality|travel|airline|tourism/i.test(text) ? "Travel & Hospitality" :
    /telecom|telecommunications|mobile network/i.test(text) ? "Telecommunications" :
    /utility|utilities|electricity provider|water provider/i.test(text) ? "Utilities" :
    /automotive|car dealership|vehicle service/i.test(text) ? "Automotive" :
    /manufacturing|manufacturer|factory/i.test(text) ? "Manufacturing" :
    /restaurant|food delivery|quick service restaurant/i.test(text) ? "Food & Restaurants" :
    /professional services|consulting|law firm|accounting firm/i.test(text) ? "Professional Services" : "Unknown";

  const detectedUseCases = DAKINI_USE_CASE_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  const voiceUseCase = detectedUseCases.length > 0 ||
    /voice agent|voice automation|automated calls|high call volume|inbound calls|outbound calls/i.test(text);
  const voiceHiringSignal =
    /(?:hiring|careers|recruit(?:ing|ment)?)\s+(?:\w+\s+){0,3}(?:telecallers?|call center|contact center|customer support|customer service|sales|collections)/i.test(text) ||
    /(?:telecallers?|call center|contact center|customer support|customer service|sales|collections)\s+(?:\w+\s+){0,3}(?:hiring|careers|recruit(?:ing|ment)?)/i.test(text);
  const hiringSignal = /hiring|careers|recruit/i.test(text);
  const automationIntent =
    /(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for|request for proposal|seeking|piloting).{0,80}(?:ai|voice|automation|agent|call center|contact center)|(?:ai|voice|automation|agent|call center|contact center).{0,80}(?:evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for|request for proposal|seeking|piloting)/i.test(text);

  const expansionSignal =
    /expansion|new branch|branches|new location|launch|rapid growth|scaling(?: up)?/i.test(text);

  const languages = ["Hindi", "English", "Tamil", "Telugu", "Kannada", "Marathi", "Bengali", "Gujarati", "Malayalam", "Punjabi", "Odia"].filter(x =>
    lower.includes(x.toLowerCase())
  );

  const branchesMatch = text.match(/(\d{1,4})\s*(?:branches|branch)/i);
  const branches = branchesMatch ? Number(branchesMatch[1]) : 0;
  const locations = icp.locations.filter(location => lower.includes(location.toLowerCase()));
  const indiaMarketSignal = /\bIndia(?:n)?\b|\bINR\b|₹|Tamil Nadu|Karnataka|Maharashtra|Telangana|Andhra Pradesh/i.test(text);
  const multilingualSignal = languages.length >= 2 ||
    /multilingual|multiple languages|regional languages|local languages|dialects|accents/i.test(text);
  const callingTeam = /collections team|customer support team|customer service team|sales team|call center|contact center|telecallers?/i.test(text);
  const highCallVolume = /high[- ]volume calls?|large call volumes?|heavy call volumes?|thousands of calls|large customer base|millions of customers|peak (?:season|demand|shopping)|surge in (?:calls|enquiries|inquiries)/i.test(text);
  const extendedHours = dataHasExtendedHours(text);
  const telephonyOrCrm = /crm|freshdesk|salesforce|hubspot|telephony|contact center platform/i.test(text);
  const systemIntegrationSignal = /integrat(?:e|es|ed|ing|ion)|API|customer (?:database|records|information)|existing systems|sales tools|CRM workflow/i.test(text);
  const aiSolutionProvider = isAiSolutionProviderEvidence([{ title: "", description: text }]);

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
  if (industry !== "Unknown") addEvidence("industry", /bank|nbfc|financial services|fintech|lending|insurance|insurer|hospital|healthcare|clinic|patient|school|education|university|college|real estate|property management|logistics|shipping|freight|courier|ecommerce|e-commerce|d2c|online store|retail|hotel|hospitality|travel|airline|telecom|utilities|automotive|manufacturing|restaurant|professional services|consulting|law firm/i);
  if (detectedUseCases.length) addEvidence("voiceUseCase", /collections|debt recovery|payment reminder|customer support|customer service|help ?desk|contact center|call center|appointment|booking|lead qualification|order status|sales follow.?up|knowledge agent|FAQs?/i);
  if (voiceHiringSignal) addEvidence("voiceHiring", /(?:hiring|careers|recruit(?:ing|ment)?).{0,60}(?:telecallers?|call center|contact center|customer support|collections)|(?:telecallers?|call center|contact center|customer support|collections).{0,60}(?:hiring|careers|recruit(?:ing|ment)?)/i);
  if (automationIntent) addEvidence("automationIntent", /evaluat(?:ing|e)|explor(?:ing|e)|implement(?:ing)?|deploy(?:ing)?|adopt(?:ing)?|looking for.{0,40}|request for proposal|voice automation|ai voice agent/i);
  if (branches) addEvidence("operationalScale", /\d{1,4}\s*(?:branches|branch)/i);
  if (callingTeam) addEvidence("callingTeam", /collections team|customer support team|customer service team|sales team|call center|contact center|telecallers?/i);
  if (highCallVolume) addEvidence("highCallVolume", /high[- ]volume calls?|large call volumes?|heavy call volumes?|thousands of calls|large customer base|millions of customers|peak (?:season|demand|shopping)|surge in (?:calls|enquiries|inquiries)/i);
  if (extendedHours) addEvidence("extendedHours", /24\/7|24x7|around the clock|round.the.clock|extended hours|after.hours|outside normal business hours/i);
  if (indiaMarketSignal) addEvidence("indiaMarketFit", /\bIndia(?:n)?\b|\bINR\b|₹|Tamil Nadu|Karnataka|Maharashtra|Telangana|Andhra Pradesh/i);
  if (multilingualSignal) addEvidence("multilingualFit", /multilingual|multiple languages|regional languages|local languages|dialects|accents|Hindi|Tamil|Telugu|Kannada|Marathi|Bengali|Gujarati|Malayalam|Punjabi|Odia/i);
  if (telephonyOrCrm) addEvidence("existingCustomerSystems", /crm|freshdesk|salesforce|hubspot|telephony|contact center platform/i);
  if (systemIntegrationSignal) addEvidence("integrationReadiness", /integrat(?:e|es|ed|ing|ion)|API|customer (?:database|records|information)|existing systems|sales tools|CRM workflow/i);
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
    callingTeam,
    branches,
    languages,
    multilingualSignal,
    indiaMarketSignal,
    highCallVolume,
    extendedHours,
    telephonyOrCrm,
    systemIntegrationSignal,
    hiringSignal,
    voiceHiringSignal,
    automationIntent,
    buyingSignal: automationIntent && !aiSolutionProvider,
    aiSolutionProvider,
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
  return [...new Set(useCases.map(useCase => DAKINI_WORKFLOW_RECOMMENDATIONS[useCase]).filter(Boolean))];
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
  const relevantPath = /about|who-we-are|our-story|product|service|solution|business|personal-banking|loan|credit|card|contact|support|customer-care|help|career|job|investor|branch|atm|collection|integration|platform|agent|faq|knowledge|case-stud|customer|industry|pricing|news|press/i;

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
        priority: /product|service|solution|agent|platform|integration|case-stud|customer|industry|support|knowledge|faq/i.test(`${url.pathname} ${label}`) ? 4 :
          /career|job|contact|about|who-we-are|our-story|business/i.test(`${url.pathname} ${label}`) ? 3 : 1
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

const DISCOVERY_INDUSTRIES = [
  "retail and ecommerce",
  "banks and lending",
  "insurance",
  "hospitals and healthcare",
  "education",
  "travel and hospitality",
  "logistics and delivery",
  "telecommunications",
  "automotive",
  "real estate",
  "utilities",
  "food delivery"
];
const DISCOVERY_QUERY_TEMPLATES = [
  'India {industry} customer support hiring call center customer enquiries',
  'India {industry} regional language customer service helpline high volume',
  'India {industry} multiple branches customer care appointment support',
  'India {industry} customer service automation investment expansion'
];
const DISCOVERY_BUYING_SIGNAL_QUERIES = [
  '"looking for" "voice AI" customer support company India',
  '"voice AI" RFP OR pilot customer service India business',
  '"AI voice agent" customer support implementation company India',
  '"customer service automation" procurement OR RFP India',
  '"contact center" "AI automation" hiring customer support India',
  '"multilingual customer support" automation India business',
  '"AI customer service" "human escalation" company India',
  '"customer operations" voice automation deployment India'
];
const DISCOVERY_QUERIES = [
  ...DISCOVERY_INDUSTRIES.flatMap(industry =>
    DISCOVERY_QUERY_TEMPLATES.map(template => template.replace("{industry}", industry))
  ),
  ...DISCOVERY_BUYING_SIGNAL_QUERIES
];
const TECH_UPDATE_QUERIES = [
  'AI technology new product launch announced released this week',
  'voice AI agent new product launch announced released',
  'technology startup launches new product software device platform today'
];

const NON_PROSPECT_DOMAINS = new Set([
  "google.com", "bing.com", "brave.com", "duckduckgo.com",
  "youtube.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
  "linkedin.com", "reddit.com", "wikipedia.org", "crunchbase.com",
  "techcrunch.com", "g2.com", "capterra.com", "amazon.com", "quora.com",
  "indeed.com", "glassdoor.com", "naukri.com", "ambitionbox.com"
]);

function isEligibleProspectUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const domain = normalizeDomain(value);
    return ![...NON_PROSPECT_DOMAINS].some(blocked =>
      domain === blocked || domain.endsWith(`.${blocked}`)
    );
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function companyNameFromSearchTitle(title, url) {
  const atCompany = title.match(/\b(?:at|from|for)\s+([A-Z][\w&.' -]{1,70})(?:\||$)/);
  if (atCompany) return atCompany[1].trim();
  const firstSegment = title.split(/\s+[|:–—]\s+/)[0].trim();
  const genericTitle = /voice agent|voice ai|customer service|customer support|call center|contact center|hiring|career|job opening|procurement|request for proposal|RFP|automation/i;
  if (firstSegment && !genericTitle.test(firstSegment) && firstSegment.length <= 70) return firstSegment;
  return new URL(url).hostname.replace(/^www\./i, "");
}

function scoreSearchEvidence(evidence) {
  const text = evidence.map(item => `${item.title} ${item.description}`).join(" ").toLowerCase();
  return (
    (/\b(rfp|request for proposal|looking for|seeking|pilot|vendor|deployment|implement(?:ation|ing)?)\b/.test(text) ? 5 : 0) +
    (/\bvoice ai|ai voice|voice agent|voice bot|voice automation\b/.test(text) ? 5 : 0) +
    (/\b(customer support|customer service|customer care|lead qualification|sales follow-up|call center|contact center|faq|knowledge agent)\b/.test(text) ? 4 : 0) +
    (/\b(multilingual|indian languages|hindi|tamil|telugu|marathi|24\/7|high[- ]volume|thousands of calls)\b/.test(text) ? 3 : 0) +
    Math.min(evidence.length, 4)
  );
}

function isAiSolutionProviderEvidence(evidence) {
  const text = evidence.map(item => `${item.title} ${item.description}`).join(" ").toLowerCase();
  return /\b(?:voice[- ]ai|ai voice|voice agent|conversational ai|contact[- ]center|call[- ]center)\s+(?:agent|platform|software|solution|api|technology|provider|vendor|product|tool)s?\b/i.test(text) ||
    /\b(?:we (?:build|offer|provide|sell|develop|power)|our (?:platform|software|product|solution)|leading provider of)\b.{0,100}\b(?:voice ai|voice agent|conversational ai|contact center automation|ai sales agent)\b/i.test(text) ||
    /\b(?:best|top)\s+\d*\s*(?:ai voice|voice ai|voice agent|ai sales agent|contact center software)\b/i.test(text);
}

async function waitForSearchRateLimit() {
  if (BRAVE_SEARCH_API_KEY || FIRECRAWL_API_KEY) return;
  const waitMs = Math.max(0, 6500 - (Date.now() - lastFreeSearchStartedAt));
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  lastFreeSearchStartedAt = Date.now();
}

async function searchWeb(query, resultType = "web", limit = MAX_RESULTS_PER_SEARCH) {
  const firecrawl = !BRAVE_SEARCH_API_KEY;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  if (!firecrawl) {
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    if (resultType === "news") url.searchParams.set("freshness", "pd");
  }
  const response = await fetch(
    firecrawl
      ? "https://api.firecrawl.dev/v2/search"
      : url,
    {
      method: firecrawl ? "POST" : "GET",
      signal: AbortSignal.timeout(30000),
      headers: firecrawl
        ? {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...(FIRECRAWL_API_KEY ? { "Authorization": `Bearer ${FIRECRAWL_API_KEY}` } : {})
          }
        : { "Accept": "application/json", "X-Subscription-Token": BRAVE_SEARCH_API_KEY },
      body: firecrawl
        ? JSON.stringify({ query, limit, sources: [resultType] })
        : undefined
    }
  );
  if (!response.ok) throw new Error(`${WEB_SEARCH_PROVIDER} returned HTTP ${response.status}`);
  const data = await response.json();
  if (firecrawl && data.success === false) {
    throw new Error(`Firecrawl search failed: ${data.error || "unknown provider error"}`);
  }
  const results = firecrawl
    ? data.data?.[resultType] || []
    : data.web?.results || [];
  return results
    .filter(result => result.url && (resultType === "news" ? isHttpUrl(result.url) : isEligibleProspectUrl(result.url)))
    .map(result => ({
      url: result.url,
      title: String(result.title || "").slice(0, 240),
      description: String(result.description || result.snippet || "").slice(0, resultType === "news" ? 500 : 1000),
      publishedAt: String(result.date || result.age || result.page_age || "").slice(0, 80)
    }));
}

function categorizeTechnologyRelease(text) {
  const lower = text.toLowerCase();
  if (/voice ai|speech|voice agent|conversational ai|text.to.speech|speech.to.text/.test(lower)) {
    return { category: "Voice & speech AI", relevance: "High" };
  }
  if (/customer service|customer support|contact center|call center|service agent/.test(lower)) {
    return { category: "Customer operations", relevance: "High" };
  }
  if (/\bai agent|agentic|\bagents?\b|artificial intelligence|large language model|\bllm\b|foundation model|generative ai/.test(lower)) {
    return { category: "AI & agents", relevance: "High" };
  }
  if (/automation|robotics|workflow|customer experience/.test(lower)) {
    return { category: "Automation & robotics", relevance: "Medium" };
  }
  return { category: "Technology release", relevance: "Explore" };
}

function isTechnologyRelease(item) {
  const title = item.title.toLowerCase();
  if (/\b(stocks?|investing|market outlook|trend report|trends|tracker|roundup|weekly|newsletter|best \d*|top \d*|latest .* news|everything we announced|could|may|might|expected|reportedly|rumou?red)\b/i.test(title)) {
    return false;
  }
  return /\b(launch(?:es|ed|ing)?|release(?:s|d)?|announc(?:e|es|ed|ing)|unveil(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|debut(?:s|ed|ing)?|roll(?:s|ed)? out|ship(?:s|ped|ping)?|available now|preview(?:s|ed)?)\b/i
    .test(`${item.title} ${item.description.slice(0, 240)}`);
}

function technologyStoryAgeDays(publishedAt) {
  const value = publishedAt.trim().toLowerCase();
  if (!value) return null;
  if (value === "today") return 0;
  if (value === "yesterday") return 1;
  const relative = value.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitDays = {
      minute: 1 / 1440,
      hour: 1 / 24,
      day: 1,
      week: 7,
      month: 30,
      year: 365
    };
    return amount * unitDays[relative[2]];
  }
  const timestamp = Date.parse(publishedAt);
  return Number.isNaN(timestamp)
    ? null
    : Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
}

async function refreshTechnologyDigest() {
  if (technologyState.refreshing) return;
  technologyState.refreshing = true;
  technologyState.lastError = "";
  technologyState.searchesCompleted = 0;
  technologyState.startedAt = new Date().toISOString();
  persistState();
  const updates = new Map();
  const errors = [];

  try {
    for (const query of TECH_UPDATE_QUERIES) {
      technologyState.currentQuery = query;
      try {
        await waitForSearchRateLimit();
        const results = await searchWeb(query, "news", TECH_UPDATE_RESULTS_PER_QUERY);
        for (const result of results) {
          if (!isTechnologyRelease(result)) continue;
          const ageDays = technologyStoryAgeDays(result.publishedAt);
          if (ageDays !== null && ageDays > MAX_TECH_STORY_AGE_DAYS) continue;
          const key = result.url.toLowerCase().replace(/\/$/, "");
          const { category, relevance } = categorizeTechnologyRelease(result.title);
          const item = {
            ...result,
            category,
            relevance,
            ageDays,
            discoveredAt: new Date().toISOString()
          };
          if (!updates.has(key)) updates.set(key, item);
        }
      } catch (error) {
        errors.push(error.message);
      }
      technologyState.searchesCompleted += 1;
      persistState();
    }

    if (updates.size) {
      technologyState.items = [...updates.values()]
        .sort((a, b) =>
          (a.ageDays ?? 15) - (b.ageDays ?? 15) ||
          (b.relevance === "High") - (a.relevance === "High")
        )
        .slice(0, 18);
      technologyState.lastUpdatedAt = new Date().toISOString();
    } else if (!errors.length) {
      technologyState.items = [];
      technologyState.lastUpdatedAt = new Date().toISOString();
    }
    technologyState.lastError = errors.length
      ? `${errors.length} technology news search(es) failed: ${errors.join("; ")}`
      : updates.size ? "" : "No news results dated within the past 14 days were returned.";
  } finally {
    technologyState.refreshing = false;
    persistState();
  }
}

function createDiscoveryJob(kind) {
  return {
    id: id(),
    kind,
    status: "queued",
    searchesCompleted: 0,
    searchResults: 0,
    companiesVisited: 0,
    pages: 0,
    records: 0,
    newQualifiedProspects: 0,
    newHighPotentialProspects: 0,
    targetMet: false,
    rateLimited: false,
    maxPagesPerCompany: MAX_PAGES_PER_COMPANY,
    discoveredCompanies: [],
    errors: []
  };
}

async function runDiscoveryJob(job) {
  const genericVoiceAgentIcp = {
    industries: [],
    locations: [],
    useCases: [
      "collections",
      "customer support",
      "appointment scheduling",
      "lead qualification",
      "order support",
      "loan servicing",
      "account and card support",
        "branch and service queries",
        "reservations and bookings",
        "healthcare intake",
        "technical support",
        "dispatch and field service"
      ]
  };
  job.maxPagesPerCompany = MAX_PAGES_PER_COMPANY;
  const prospectsByDomain = new Map();
  job.status = "running";
  job.startedAt = new Date().toISOString();
  discoveryState.activeJobId = job.id;
  discoveryState.lastError = "";
  persistState();

  try {
    for (const query of DISCOVERY_QUERIES) {
      job.currentQuery = query;
      try {
        await waitForSearchRateLimit();
        const results = await searchWeb(query);
        for (const result of results) {
          const domain = normalizeDomain(result.url);
          const existing = prospectsByDomain.get(domain) || {
            domain,
            url: new URL(result.url).origin,
            companyName: companyNameFromSearchTitle(result.title, result.url),
            evidence: []
          };
          if (!existing.evidence.some(item => item.url === result.url)) {
            existing.evidence.push({
              url: result.url,
              title: result.title,
              description: result.description
            });
          }
          prospectsByDomain.set(domain, existing);
        }
      } catch (error) {
        job.errors.push({ query, reason: error.message });
        if (/HTTP 429\b/.test(error.message)) {
          job.rateLimited = true;
        }
      }
      job.searchesCompleted += 1;
      job.searchResults = [...prospectsByDomain.values()].length;
      if (job.rateLimited) break;
    }

    const prospects = [...prospectsByDomain.values()]
      .filter(prospect => !isAiSolutionProviderEvidence(prospect.evidence))
      .sort((a, b) => scoreSearchEvidence(b.evidence) - scoreSearchEvidence(a.evidence) ||
        b.evidence.length - a.evidence.length)
      .filter(prospect => {
        const existing = companies.get(prospect.domain);
        if (!existing?.capturedAt) return true;
        return Date.now() - new Date(existing.capturedAt).getTime() >=
          DISCOVERY_REFRESH_DAYS * 24 * 60 * 60 * 1000;
      })
      .slice(0, MAX_DAILY_DISCOVERY_COMPANIES)
      .map(prospect => ({ ...prospect, isNewProspect: !companies.has(prospect.domain) }));
    job.discoveredCompanies = prospects.map(({ domain, url, companyName }) => ({ domain, url, companyName }));

    let nextProspectIndex = 0;
    const workerCount = Math.min(DISCOVERY_CRAWL_CONCURRENCY, prospects.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextProspectIndex < prospects.length &&
          job.newQualifiedProspects < DAILY_NEW_PROSPECT_TARGET) {
        const prospect = prospects[nextProspectIndex];
        nextProspectIndex += 1;
        const evidencePages = prospect.evidence.map(item => ({
          url: item.url,
          title: item.title,
          text: `${item.title}. ${item.description}`.trim(),
          sourceType: "web search"
        }));
        const companyRecord = await crawlCompanySite(
          job,
          prospect.url,
          genericVoiceAgentIcp,
          prospect.companyName,
          "",
          WEB_SEARCH_PROVIDER.toLowerCase().replaceAll(" ", "-"),
          undefined,
          evidencePages,
          true
        );
        if (prospect.isNewProspect && companyRecord &&
            ["Priority", "Review"].includes(companyRecord.score.tier)) {
          job.newQualifiedProspects += 1;
          if (companyRecord.score.tier === "Priority") job.newHighPotentialProspects += 1;
          job.targetMet = job.newQualifiedProspects >= DAILY_NEW_PROSPECT_TARGET;
        }
        if (job.companiesVisited > 0 && job.companiesVisited % 5 === 0) persistState();
      }
    }));

    job.status = job.errors.length ? "completed_with_errors" : "completed";
    job.completedAt = new Date().toISOString();
    discoveryState.lastRunAt = job.completedAt;
    discoveryState.lastRunSummary = {
      newQualifiedProspects: job.newQualifiedProspects,
      newHighPotentialProspects: job.newHighPotentialProspects,
      target: DAILY_NEW_PROSPECT_TARGET,
      sitesVisited: job.companiesVisited,
      pagesScanned: job.pages,
      errors: job.errors.length,
      rateLimited: Boolean(job.rateLimited),
      targetMet: job.targetMet
    };
    if (job.errors.length) {
      discoveryState.lastError = `${job.errors.length} search or website fetch error(s); see the discovery job for details.`;
      if (!job.targetMet) {
        discoveryState.lastError += ` Reached ${job.newQualifiedProspects} of ${DAILY_NEW_PROSPECT_TARGET} daily qualified prospects.`;
      }
      if (job.rateLimited) {
        discoveryState.lastError += " Search provider quota/rate limit reached; configure an authenticated provider for higher-volume daily discovery.";
      }
    } else if (job.newQualifiedProspects < DAILY_NEW_PROSPECT_TARGET) {
      discoveryState.lastError = `Discovery found ${job.newQualifiedProspects} new qualified prospects, below the daily target of ${DAILY_NEW_PROSPECT_TARGET}. Search-provider coverage and public-site accessibility limit results.`;
    } else {
      discoveryState.lastError = "";
    }
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    discoveryState.lastError = error.message;
  } finally {
    discoveryState.activeJobId = null;
    discoveryState.nextRunAt = getNextDiscoveryRun().toISOString();
    persistState();
  }
}

function getNextDiscoveryRun(now = new Date()) {
  const [hour, minute] = DISCOVERY_TIME.split(":").map(Number);
  const localNow = new Date(now.toLocaleString("en-US", { timeZone: DISCOVERY_TIME_ZONE }));
  const localTarget = new Date(localNow);
  localTarget.setHours(hour, minute, 0, 0);
  if (localTarget <= localNow) localTarget.setDate(localTarget.getDate() + 1);
  return new Date(now.getTime() + (localTarget.getTime() - localNow.getTime()));
}

function scheduleDailyDiscovery() {
  const nextRun = getNextDiscoveryRun();
  discoveryState.nextRunAt = nextRun.toISOString();
  persistState();
  const delay = Math.min(nextRun.getTime() - Date.now(), 2147483647);
  setTimeout(async () => {
    if (!discoveryState.activeJobId) {
      const job = createDiscoveryJob("daily_web_discovery");
      jobs.set(job.id, job);
      await runDiscoveryJob(job);
      await refreshTechnologyDigest();
    }
    while (jobs.size > 120) jobs.delete(jobs.keys().next().value);
    scheduleDailyDiscovery();
  }, delay);
}

function dataHasExtendedHours(text) {
  return /24\/7|24x7|around the clock|round.the.clock|extended hours|after.hours|outside normal business hours/i.test(text);
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

async function crawlCompanySite(job, homeUrl, icp, companyName, directoryUrl, sourceId, homeHtml, discoveryEvidence = [], liveCrawl = !DEMO_MODE) {
  const pages = [...discoveryEvidence];
  try {
    const html = homeHtml || await fetchPage(homeUrl);
    const homepage = extractPageText(html);
    pages.push({ url: homeUrl, title: homepage.title, text: homepage.text, sourceType: "company website" });
    job.pages += 1;

    const internalLinks = liveCrawl
      ? extractRelevantPageLinks(homepage.$, homeUrl).slice(0, job.maxPagesPerCompany - 1)
      : [];
    for (const pageUrl of internalLinks) {
      try {
        const pageHtml = await fetchPage(pageUrl);
        const page = extractPageText(pageHtml);
        pages.push({ url: pageUrl, title: page.title, text: page.text, sourceType: "company website" });
        job.pages += 1;
      } catch (error) {
        job.errors.push({ sourceId, company: companyName || normalizeDomain(homeUrl), url: pageUrl, reason: error.message });
      }
    }

    const companyRecord = saveCompany(pages, homeUrl, icp, companyName, directoryUrl);
    job.records += 1;
    job.companiesVisited += 1;
    return companyRecord;
  } catch (error) {
    job.errors.push({ sourceId, company: companyName || normalizeDomain(homeUrl), url: homeUrl, reason: error.message });
    return null;
  }
}

function saveCompany(pages, sourceUrl, icp, companyName, directoryUrl) {
  const pageSources = pages.map(({ url, text, sourceType }) => ({ url, text, sourceType }));
  const text = pages.map(page => page.text).join(" | ");
  const record = extract(text, sourceUrl, icp, companyName, directoryUrl, pageSources);
  record.title = pages[0]?.title || "";
  record.sourceUrl = sourceUrl;
  record.directoryUrl = directoryUrl || "";
  record.pagesScanned = pages.map(({ url, title, sourceType }) => ({ url, title, sourceType: sourceType || "company website" }));
  record.capturedAt = new Date().toISOString();
  record.scoreVersion = SCORE_VERSION;

  const companyId = normalizeDomain(sourceUrl);
  companies.set(companyId, { id: companyId, ...record });
  return record;
}

function recalculateStoredScores() {
  let changed = false;
  const broadIcp = { industries: [], locations: [], useCases: [] };
  for (const company of companies.values()) {
    if (company.scoreVersion === SCORE_VERSION) continue;
    const evidenceText = [
      ...(company.companyActivities || []),
      ...(company.evidence || []).map(item => item.quote || "")
    ].join(" | ");
    const detectedUseCases = DAKINI_USE_CASE_PATTERNS
      .filter(([, pattern]) => pattern.test(evidenceText))
      .map(([useCase]) => useCase);
    company.detectedUseCases = detectedUseCases;
    company.dakiniRecommendations = getDakiniRecommendations(detectedUseCases);
    const aiSolutionProvider = isAiSolutionProviderEvidence([{
      title: company.title || "",
      description: evidenceText
    }]);
    company.aiSolutionProvider = aiSolutionProvider;
    company.score = scoreLead({
      industry: company.industry || "Unknown",
      detectedUseCases,
      sourceText: "",
      locations: company.locations || [],
      roleEmail: company.roleEmail || "",
      phone: company.phone || "",
      callingTeam: Boolean(company.callingTeam),
      branches: Number(company.branches) || 0,
      highCallVolume: /high[- ]volume calls?|large call volumes?|heavy call volumes?|thousands of calls|large customer base|millions of customers|peak (?:season|demand|shopping)|surge in (?:calls|enquiries|inquiries)/i.test(evidenceText),
      extendedHours: Boolean(company.extendedHours),
      indiaMarketSignal: /\bIndia(?:n)?\b|\bINR\b|₹|Tamil Nadu|Karnataka|Maharashtra|Telangana|Andhra Pradesh/i.test(evidenceText),
      multilingualSignal: (company.languages || []).length >= 2 ||
        /multilingual|multiple languages|regional languages|local languages|dialects|accents/i.test(evidenceText),
      telephonyOrCrm: Boolean(company.telephonyOrCrm),
      systemIntegrationSignal: /integrat(?:e|es|ed|ing|ion)|API|customer (?:database|records|information)|existing systems|sales tools|CRM workflow/i.test(evidenceText),
      automationIntent: Boolean(company.automationIntent),
      voiceHiringSignal: Boolean(company.voiceHiringSignal),
      expansionSignal: Boolean(company.expansionSignal),
      buyingSignal: Boolean(company.automationIntent) && !aiSolutionProvider,
      aiSolutionProvider
    }, broadIcp);
    company.scoreVersion = SCORE_VERSION;
    changed = true;
  }
  if (changed) persistState();
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
  googleConfigured: isGoogleConfigured(),
  webSearchConfigured: true,
  webSearchProvider: WEB_SEARCH_PROVIDER,
  authenticatedSearchConfigured: Boolean(BRAVE_SEARCH_API_KEY || FIRECRAWL_API_KEY)
}));

app.get("/api/discovery/status", (req, res) => {
  const activeJob = discoveryState.activeJobId ? jobs.get(discoveryState.activeJobId) : null;
  res.json({
    provider: WEB_SEARCH_PROVIDER,
    apiKeyRequired: false,
    configured: true,
    authenticatedSearchConfigured: Boolean(BRAVE_SEARCH_API_KEY || FIRECRAWL_API_KEY),
    dailyScheduleEnabled: true,
    schedule: `${DISCOVERY_TIME} ${DISCOVERY_TIME_ZONE}`,
    nextRunAt: discoveryState.nextRunAt,
    lastRunAt: discoveryState.lastRunAt,
    lastRunSummary: discoveryState.lastRunSummary,
    lastError: discoveryState.lastError,
    activeJob: activeJob ? {
      id: activeJob.id,
      status: activeJob.status,
      searchesCompleted: activeJob.searchesCompleted,
      companiesVisited: activeJob.companiesVisited,
      companiesDiscovered: activeJob.discoveredCompanies.length,
      newQualifiedProspects: activeJob.newQualifiedProspects || 0,
      newHighPotentialProspects: activeJob.newHighPotentialProspects || 0,
      dailyProspectTarget: DAILY_NEW_PROSPECT_TARGET,
      rateLimited: Boolean(activeJob.rateLimited),
      targetMet: Boolean(activeJob.targetMet),
      pages: activeJob.pages,
      errors: activeJob.errors.length
    } : null,
    technologyRefreshInProgress: technologyState.refreshing,
    dailySearchQueries: DISCOVERY_QUERIES.length,
    resultsPerQuery: MAX_RESULTS_PER_SEARCH,
    dailyProspectTarget: DAILY_NEW_PROSPECT_TARGET,
    maxCompanySitesPerRun: MAX_DAILY_DISCOVERY_COMPANIES,
    maxPagesPerCompany: MAX_PAGES_PER_COMPANY,
    crawlConcurrency: DISCOVERY_CRAWL_CONCURRENCY
  });
});

app.post("/api/discovery/run-now", (req, res) => {
  if (discoveryState.activeJobId || technologyState.refreshing) {
    return res.status(409).json({ error: "Another discovery or technology-news search is already running." });
  }

  const job = createDiscoveryJob("manual_web_discovery");
  jobs.set(job.id, job);
  discoveryState.activeJobId = job.id;
  persistState();
  runDiscoveryJob(job);
  res.status(202).json({ id: job.id, status: job.status });
});

app.get("/api/technology-updates", (req, res) => {
  res.json({
    provider: WEB_SEARCH_PROVIDER,
    items: technologyState.items,
    lastUpdatedAt: technologyState.lastUpdatedAt,
    lastError: technologyState.lastError,
    refreshing: technologyState.refreshing,
    searchesCompleted: technologyState.searchesCompleted || 0,
    totalSearches: TECH_UPDATE_QUERIES.length,
    schedule: `${DISCOVERY_TIME} ${DISCOVERY_TIME_ZONE}`
  });
});

app.post("/api/technology-updates/refresh", (req, res) => {
  if (discoveryState.activeJobId || technologyState.refreshing) {
    return res.status(409).json({ error: "Another discovery or technology-news search is already running." });
  }

  refreshTechnologyDigest().catch(error => {
    technologyState.refreshing = false;
    technologyState.lastError = `Technology digest failed: ${error.message}`;
    console.error(technologyState.lastError);
    persistState();
  });
  res.status(202).json({ status: "refreshing" });
});

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
    maxPagesPerCompany: z.number().int().positive().max(10).default(MAX_PAGES_PER_COMPANY),
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

  recalculateStoredScores();

  app.listen(PORT, () => {
  console.log(`Dakini POC running at http://localhost:${PORT}`);
  scheduleDailyDiscovery();
});
