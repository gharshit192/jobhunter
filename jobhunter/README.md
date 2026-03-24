# 🔥 JobHunter Pro

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


