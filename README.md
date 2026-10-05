# Dakini AI ICP Prospecting POC

This is intentionally much smaller than the full production architecture.

## What it does

1. Define target industries, locations, and voice-agent use cases.
2. Register approved company pages as sources.
3. From a bank directory, discover every linked bank site. For each site, crawl the homepage and up to five relevant About, Products/Services, Careers, and Contact pages.
4. Extract company activity, publicly listed business emails/phone numbers, operating details, voice use cases, and buying signals.
5. Recommend Dakini AI voice-agent workflows, match evidence against the ICP, and rank potential clients by a transparent score.
6. Review source quotes and score breakdowns for each result.
7. Connect a Google account and sync prospects to a Google Sheet.

This tool generates a research list of potential Dakini AI clients; it does not prove that a company intends to buy. Scores and evidence confidence are heuristic, not calibrated probabilities. Publicly listed email addresses and phone numbers may be general company channels rather than named decision-makers. Verify the details and suitability before sales outreach.

In live mode, a source page containing external links labelled as banks is treated as a bank directory: the crawler extracts every distinct bank name and link, then visits each public site. Each company site is limited to six pages total (homepage plus up to five relevant same-domain pages); unsuccessful page fetches are reported as crawl errors. This per-company limit avoids unbounded traversal while covering more than just the homepage.

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

## Demo mode

Demo mode is the safe default and uses a built-in synthetic finance-company fixture. No external website is fetched.

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
