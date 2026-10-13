# 🔥 JobHunter Pro

## Personal daily application worker

The personal worker uses the confirmed candidate profile and original resume in
`.automation/` on this Mac. It runs independently of MongoDB and the Vercel deployment.
Install dependencies with `npm install`, then start:

```bash
npm run automation
```

Open `http://127.0.0.1:4129`. The worker schedules a daily run at **8 AM IST** while
the process is running and the Mac is awake. Click **Run today** for an immediate
discovery and submission run, or use:

```bash
npm run automation:discover
npm run automation:dry-run
npm run automation:apply
```

`npm start` also starts the personal worker when a local confirmed profile exists
and `MONGODB_URI` is unset. With MongoDB configured, it starts the original dashboard.

The watchlist contains 60 companies, split equally between product/in-house
engineering and services. Discovery supports Greenhouse, Lever, SmartRecruiters,
Workday, and structured JobPosting pages; other career pages are explicitly marked
as needing a connector. Discovery support does not imply submission support.

Applications use verified employer forms, known candidate answers and the original
resume. Hosted Greenhouse/Lever and supported SmartRecruiters forms are attempted;
custom portals and candidate-account creation currently require manual action.
Normal runs use a headless browser and never open windows or take keyboard focus.
The worker pauses individual applications for unknown required answers, unsupported
controls, login, or verification challenges. LinkedIn Easy Apply support is limited to known form steps and verified resume uploads; live unattended completion is being verified.
Naukri, Instahyre and Hirist can be opened for manual use and their employer
links imported into the queue. No passwords need to be entered in chat.

The daily target is **15 confirmed submissions**, counted from application-site receipts. Only a success
confirmation or an explicit candidate-recorded confirmation counts. Interrupted or
uncertain submissions cannot be automatically retried. The worker preserves statuses
and evidence across rediscovery. Full-time backend domain, core stack, location,
experience and salary rules are checked before final submission. Undisclosed salary
does not block an eligible application. Full-stack and out-of-domain jobs are excluded.

Daily reports are saved as `.automation/reports/YYYY-MM-DD.html`, `.csv`, and `.json`.
They show relevant jobs and application attempts, confirmed submissions, shortfalls,
confirmation screenshots, recruiter contacts, notes, interviews, and offers. Rejected
discovery matches are omitted from these reports. Record calls in **Applications**;
the saved report updates after each action. Reports and sessions remain private and
are excluded from Git and Vercel deployments.

For verification, use `npm test` (including a Chrome form fixture) and
`npm run automation:check` while the local server is running.

> Automated job hunting system — finds, scores and applies to jobs daily

## What It Does
- Parses your resume (PDF) and extracts skills, experience, roles
- Scrapes jobs from Naukri, LinkedIn, Instahyre, Wellfound daily
- Scores each job 0-100% based on skill + role + experience match
- Sends daily Telegram/Email report with top matches
- Dashboard to track all jobs, mark applied, filter by match score

---

## ⚡ Quick Setup (Local)

### 1. Install dependencies
```bash
npm install
```

### 2. Setup environment variables
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Add your resume
```bash
# Drop your resume PDF in the root folder
cp /path/to/your/resume.pdf ./resume.pdf
```

### 4. Run the server
```bash
npm run dev
```

### 5. Open dashboard
```
http://localhost:3000
```

### 6. Trigger your first hunt
- Click **"Run Now"** in the dashboard
- OR run from terminal: `npm run run-hunt`

---

## 🚀 Deploy to Vercel

### 1. Install Vercel CLI
```bash
npm i -g vercel
```

### 2. Login
```bash
vercel login
```

### 3. Add environment variables
```bash
vercel env add MONGODB_URI
vercel env add TELEGRAM_BOT_TOKEN
vercel env add TELEGRAM_CHAT_ID
vercel env add EMAIL_FROM
vercel env add EMAIL_PASSWORD
vercel env add EMAIL_TO
```

### 4. Deploy
```bash
vercel --prod
```

### 5. Cron runs automatically
- `vercel.json` has cron configured: runs daily at 8 AM UTC (1:30 PM IST)

---

## 📱 Telegram Setup (for notifications)

1. Open Telegram → search `@BotFather`
2. Send `/newbot` → follow steps → copy the **Bot Token**
3. Add token to `.env` as `TELEGRAM_BOT_TOKEN`
4. Open `https://t.me/userinfobot` → copy your **Chat ID**
5. Add to `.env` as `TELEGRAM_CHAT_ID`

---

## 📧 Email Setup (Gmail)

1. Go to Google Account → Security → 2-Step Verification (enable)
2. Go to → App Passwords → create one for "Mail"
3. Use that 16-character password as `EMAIL_PASSWORD`
4. Set `EMAIL_FROM` = your Gmail address

---

## 🗄️ MongoDB Setup (Free Atlas)

1. Go to `mongodb.com/atlas` → create free cluster
2. Create database user
3. Get connection string: `mongodb+srv://user:pass@cluster.mongodb.net/jobhunter`
4. Add to `.env` as `MONGODB_URI`

---

## 📊 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | Get all jobs (filter by status, score, source) |
| GET | `/api/jobs/stats` | Dashboard stats |
| GET | `/api/reports` | Daily hunt reports |
| GET | `/api/resume` | Current resume profile |
| POST | `/api/resume/upload` | Upload new resume PDF |
| POST | `/api/run` | Trigger job hunt now |
| PATCH | `/api/jobs/:id/status` | Update job status |
| DELETE | `/api/jobs/clear` | Clear all jobs |

---

## ⚙️ Configuration

In `.env`:

```
MIN_MATCH_SCORE=70    # Only notify/apply for 70%+ matches
DAILY_APPLY_LIMIT=10  # Max auto-applies per day
```

---

## 📁 Project Structure

```
jobhunter/
├── src/
│   ├── index.js          # Express server + cron
│   ├── runner.js         # Main hunt orchestrator
│   ├── models.js         # MongoDB schemas
│   ├── routes.js         # API routes
│   ├── parsers/
│   │   └── resumeParser.js   # PDF resume parser
│   ├── scrapers/
│   │   └── jobScraper.js     # Multi-platform scraper
│   ├── matchers/
│   │   └── jobMatcher.js     # Scoring engine
│   └── notifiers/
│       └── notifier.js       # Telegram + Email
├── public/
│   └── index.html        # Dashboard UI
├── vercel.json           # Vercel deployment config
├── .env.example          # Environment variables template
└── package.json
```



### Local email verification
Open Accounts & import in http://127.0.0.1:4129 and connect the profile Gmail account using a Google app password. Authentication must succeed before credentials are saved locally with owner-only permissions. This is independent of ChatGPT settings and connections. The worker searches only matching Greenhouse application security-code emails in read-only mode. Codes and email bodies are not saved. Other providers, CAPTCHA and login OTP challenges still require manual action.

### Verifying portal sessions
`npm run automation:check -- --inspect-platforms` performs read-only live checks in the separate headless worker browser and saves per-platform status to the private local store. Cookies alone are not treated as proof of authentication. CAPTCHA or expired sessions remain blocked. Portal submission support is not implied by this check.
`npm run automation:check -- --retry-email` retries a Druva application only when saved evidence proves the previous attempt was rejected for an email security code and Gmail has authenticated. It does not retry uncertain submissions.

The dashboard checks the shared worker lock when reporting an active run, including CLI runs. Email-only application blocks become eligible for one automatic retry per India day after Gmail connects; uncertain submissions are never automatically retried.

Each run also resumes eligible applications whose previously missing questions can now all be answered from confirmed facts or saved answers. Old Workday blocks that explicitly reported a missing connector receive one retry with the implemented connector. Sign-in, CAPTCHA and uncertain submissions remain held; failed upgraded attempts are not retried repeatedly.

### Workday form support
The local worker waits for actual application controls rather than treating Workday's early header as a loaded posting. It can open a Workday posting, enter its Apply Manually flow, fill recognised fields from confirmed answers, upload the saved resume and proceed through known steps. It stops for sign-in, browser verification, unknown required answers or unrecognised controls. Final submission requires a verified resume upload, current eligibility and a recognised site receipt. This connector has not yet produced a verified unattended live submission; account creation and arbitrary Workday custom questions remain unfinished.

### LinkedIn Easy Apply
When the separate worker browser has an authenticated LinkedIn session, discovery checks Java backend search results in the approved cities and India remote. It imports only employers whose category is known, reads each complete job description and runs the shared eligibility checks. The connector fills recognised modal fields, uploads the current local resume, stops on required unknown answers, and submits only at the final Submit application control. Follow-company checkboxes are cleared. It counts only a recognised site receipt; uncertain attempts are held. External Apply links and changed controls require review. This capability has not yet produced a verified live unattended submission.

Radio choices are identified by visible labels and individual controls, including forms whose choices share the same `value="on"`. The answer resolver uses explicitly confirmed NoSQL/MongoDB years, production ownership and implementation capabilities; production scale is not inferred. A title containing “backend architecture” is distinguished from an architect position.

### Manual completion shortlist
The dashboard opens on the Relevant jobs tab, which displays the shortlist as searchable cards with employer, role, location, source, salary verification, blocker and a direct manual application link. It reads the current shortlist from the local `/api/shortlist` endpoint, so application status updates appear without importing web leads into the automatic queue.
Saved daily reports now include links to `shortlist-YYYY-MM-DD.html`, `.csv` and `.json`. The shortlist combines eligible stored jobs with curated web leads in the private `web-leads.json` file, showing direct links, application status, blocker, manual action, salary verification and evidence date. Search-index leads are explicitly labelled as needing current vacancy confirmation. Completed duplicate roles, excluded domains, Python review roles and known foreign-eligibility conflicts are omitted. It does not count leads as applications or claim that every portal has been searched successfully. The current web search/import is curated, not an unattended internet-wide search service.

Use `npm run automation:apply -- --job JOB_ID` to attempt one eligible application without discovery. Unknown required facts and uncertain submissions remain held.

### Hirist email OTP
The local Gmail reader checks recent Hirist login/verification messages from Hirist-owned sender domains and the confirmed candidate recipient. It reads codes from plain text and HTML, without saving codes or mail bodies. The background Hirist login helper requests an email OTP only from a recognised candidate login form, enters it into recognised OTP controls, and reports authentication only when account controls confirm it. Changed layouts, CAPTCHA and unverified completion remain blocked. Hirist job submission is still unfinished.
