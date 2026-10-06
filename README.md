# Dakini AI ICP Scraper

This is a prospect-research POC, not a full production prospecting platform.

## What it does

1. Optionally define target industries, locations, and voice-agent use cases for manual crawls.
2. Register approved company pages as sources.
3. From a bank directory, discover every linked bank site. For each site, crawl the homepage and up to seven relevant product, service, integration, customer, careers, and contact pages.
4. Extract company activity, publicly listed business emails/phone numbers, operating details, voice use cases, and buying signals.
5. Recommend Dakini AI voice-agent workflows, match evidence against the ICP, and rank potential clients by a transparent score.
6. Review source quotes and score breakdowns for each result.
7. Search recent public web results for cross-industry prospect signals, on demand or daily.
8. Connect a Google account and sync prospects to a Google Sheet.

This tool generates a research list of potential Dakini AI clients; it does not prove that a company intends to buy. Scores and evidence confidence are heuristic, not calibrated probabilities. Publicly listed email addresses and phone numbers may be general company channels rather than named decision-makers. Verify the details and suitability before sales outreach.

### Dakini AI capabilities used for matching

Dakini AI's [public website](https://www.dakini-ai.com/) describes customer-service, sales, and knowledge agents; customer query and complaint handling; lead qualification, product recommendations, and demo/follow-up scheduling; multilingual Indian-language and accent support; customer-context retrieval and human escalation; and integration with existing systems, email, voice agents, and sales/CRM tools. The scraper maps company evidence to these documented capabilities. It does not treat adjacent opportunities—such as collections, healthcare intake, or appointment scheduling—as confirmed Dakini product features; those recommendations explicitly require workflow, integration, and compliance validation.

### Potential-client fit score (out of 100)

- **Service fit (35):** 15 for the first detected Dakini-aligned workflow, 10 for the second, then 5 for each additional workflow, capped at 35. Includes customer service, lead qualification, sales follow-up, and knowledge/FAQ support.
- **Operating scale (20):** 5 for a customer-service/sales calling team, 4 for multiple branches, 6 for high call/customer volumes or peak demand, and 5 for explicit round-the-clock or extended-hours operations.
- **India and language fit (15):** 8 for evidence of an India market presence and 7 for multilingual, regional-language, dialect, or accent needs.
- **Integration readiness (10):** 6 for CRM/telephony/contact-center tools and 4 for APIs, customer records, or integration evidence.
- **Buying/growth signals (15):** 10 for explicit AI/voice automation evaluation or adoption, 3 for relevant calling-team hiring, and 2 for expansion.
- **Public contactability (5):** 3 for a public business email and 2 for a phone number.

**High potential** requires at least 70 points, any configured ICP criteria to match, a confirmed Dakini workflow, and an explicit buying/automation signal. **Research** requires at least 45 points, configured ICP criteria to match, and at least one confirmed workflow. Adjacent opportunities may be suggested but do not earn service-fit points. Sites that appear to sell AI/voice-agent/contact-center software are treated as competitors, capped at 20 points, and excluded from these tiers. Industry, use-case, and location filters gate the tier but do not add score points. Each result shows its point breakdown and available evidence quotes/links. Scores prioritize research; they are not purchase probabilities.

In live mode, a source page containing external links labelled as banks is treated as a bank directory: the crawler extracts every distinct bank name and link, then visits each public site. Each company site is limited to eight pages total (homepage plus up to seven relevant same-domain pages); unsuccessful page fetches are reported as crawl errors. Discovery searches across 12 industries with operational-volume, hiring, growth, and explicit buying-signal queries; it ranks domains using search-result relevance and filters likely AI vendors/job boards before crawling. Up to 200 company sites can be crawled per run, with four sites in parallel.

## Run

Requirements: Node.js 20+

```bash
npm install
npm start
```

Open:

http://localhost:3000

## Google Sheets connection

1. In Google Cloud Console, create an OAuth 2.0 Client ID with application type **Web application**.
2. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
3. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Keep `.env` private and do not commit credentials.
4. Restart the server, choose **Connect Google Sheets**, and authorize the requested Sheets access.
5. Choose **Sync to Google Sheets** to create or update the prospect sheet for that app session.

OAuth tokens and the spreadsheet reference are held in memory by this POC and are lost when the server restarts. Configure a persistent, protected token store before using this flow as a multi-user production service.

Set `DAKINI_STATE_FILE` in `.env` to a private local JSON path if prospect data should survive server restarts. The app writes its ICPs, sources, crawl summaries, and prospect profiles there. Keep `.env` and this data file private; the state contains publicly listed contact details.

## Automated web discovery

Automated discovery defaults to Firecrawl's keyless web-search endpoint, which requires no API key but has lower rate limits than authenticated use. The app spaces its 56 searches by at least 6.5 seconds in keyless mode and stops early on HTTP 429 instead of continuing futile requests. A full run therefore needs at least about six minutes for search alone, plus site crawling. Optionally set `FIRECRAWL_API_KEY` in the private `.env` to authenticate Firecrawl, or set `BRAVE_SEARCH_API_KEY` to use Brave Search (Brave takes precedence if both are set). Each query requests up to ten results; results are deduplicated by company domain, likely AI vendors and job boards are filtered, and up to 200 eligible company sites are crawled per run. Each company crawl is limited to the homepage and up to seven relevant same-domain pages. Previously captured companies are skipped for 30 days, then may be refreshed. A prospect counts toward the daily goal only if its site yields a new company with a High potential or Research tier; pages identified as AI vendors do not count.

The daily goal is **100 new qualified prospects**, not a guaranteed result count. Search-index coverage, provider quotas, site blocks, repeat domains, and evidence quality can all reduce the actual total. The unauthenticated Firecrawl search has already returned HTTP 429 during a 56-query run, so keyless mode cannot be relied on to meet this goal. The app reports provider rate limits and the actual number achieved. For a dependable unattended daily target, configure `FIRECRAWL_API_KEY` or `BRAVE_SEARCH_API_KEY` with sufficient plan quota, then deploy on an always-on host. The local server must remain running and connected to the internet at its scheduled time (`09:00` by default in `Asia/Kolkata`); it does not run while the machine or server is off.

On startup, saved prospects with older score versions are re-scored using their stored company summaries and evidence quotes. Because full source-page text is not retained, recrawl companies to refresh their evidence and contact details.

The daily schedule defaults to `09:00` in `Asia/Kolkata`; customize it with `DISCOVERY_TIME` (24-hour `HH:MM`) and `DISCOVERY_TIME_ZONE` (IANA time-zone name). You can also start a run from the app. The server process must stay running for scheduled runs; stopping or restarting it interrupts an in-progress run, which is marked interrupted when the saved state is restored. Set `DAKINI_STATE_FILE` to keep completed results between restarts.

Search providers index only a subset of the public web, and provider limits, ranking, and query coverage constrain results. A `429` or other provider error is shown in job status. This cannot search the entire internet or guarantee 100 new qualified prospects each day. It can accumulate prospects across runs, but verify company fit, intent, and public contact details before outreach. Search-provider errors and company-site fetch errors are reported in job status.

## Daily technology-release brief

The **AI Tech Scout** section searches news results for new AI, voice, automation, and broader technology releases. It refreshes with the daily scheduled run and has a manual refresh button. It filters for reported launch/release announcements, suppresses stories the provider dates more than seven days old, prioritizes the freshest results, links each item to its publisher, and shows the provider's own headline, summary, and publication date where available. The category and Dakini-relevance label are keyword-based triage, not an LLM-generated analysis or a claim that a story is verified. The last successful digest is stored with `DAKINI_STATE_FILE` and remains available after a restart.

## Demo mode

Demo mode is the safe default and uses a built-in synthetic finance-company fixture for manual crawls. Automated web discovery, when configured, still searches the web and fetches public company sites even in demo mode.

To run a live crawl on Windows PowerShell, set the variable in the same terminal before starting the server:

```powershell
$env:DEMO_MODE = "false"
npm start
```

Restart the server after changing the mode, then add an approved public URL in the app.

## Important

This is a POC, not the production system described in the full engineering brief.

For production, the next upgrades should be:
- PostgreSQL + Prisma
- Redis + BullMQ
- robots.txt and terms/policy checks
- S3/MinIO snapshots
- authentication and tenant isolation
- real LLM adapter
- review workflow
- suppression/deletion
- audit logs
- tests
- Docker deployment
