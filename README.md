# AdScale — Amazon PPC Management Dashboard

Private self-hosted PPC management tool for Amazon Ads.

---

## Files in this folder

```
adscale/
├── server.js          ← Backend server (do not edit unless instructed)
├── package.json       ← Dependencies list (do not edit)
├── .env.example       ← Secret variables template
├── .gitignore         ← Keeps secrets off GitHub (do not edit)
├── README.md          ← This file
└── public/
    └── index.html     ← Your dashboard UI
```

---

## Deployment Steps

### Step 1 — Install Node.js (Windows)
1. Go to https://nodejs.org
2. Click the LTS button and download the installer
3. Run it — all defaults, just click Next → Install
4. Open Command Prompt and verify:
   ```
   node --version
   npm --version
   ```

### Step 2 — GitHub (upload your code)
1. Go to https://github.com → sign up (free)
2. Create a new repository called `adscale` — set to PRIVATE
3. Upload all these files by dragging them into the GitHub repository page
4. Click "Commit changes"

### Step 3 — Railway (deploy to cloud)
1. Go to https://railway.app
2. Click "Login with GitHub"
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your `adscale` repository
5. Railway will start deploying automatically

### Step 4 — Set environment variables on Railway
In your Railway project, go to Variables tab and add:

| Variable               | Value                                      |
|------------------------|--------------------------------------------|
| AMAZON_CLIENT_ID       | Your Client ID from Amazon developer console |
| AMAZON_CLIENT_SECRET   | Your Client Secret from Amazon             |
| AMAZON_REGION          | EU  (or NA for North America)              |
| AMAZON_REDIRECT_URI    | https://YOUR-APP.railway.app/auth/callback |
| APP_PASSWORD           | Your chosen strong password                |
| SESSION_SECRET         | A random 32+ character string              |
| ALLOWED_IPS            | Your home IP, work IP (comma separated) or leave blank |
| NODE_ENV               | production                                 |

### Step 5 — Get your Railway URL
1. In Railway → Settings → Domains → Generate Domain
2. Copy your URL (looks like https://adscale-xxxx.railway.app)

### Step 6 — Update Amazon redirect URI
1. Go to https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html
2. Click your AdScale security profile → Web Settings → Edit
3. Add your Railway URL to Allowed Return URLs:
   https://adscale-xxxx.railway.app/auth/callback
4. Save

### Step 7 — Open your app
1. Go to your Railway URL in any browser
2. Enter your APP_PASSWORD
3. Click "Connect Amazon" → Authorize
4. Your real data loads

---

## Accessing from multiple devices
Just open your Railway URL in any browser on any device.
No installation needed on home PC, work PC, or phone.

---

## Security features included
- Password login (brute force protection — blocks after 5 failed attempts)
- Sessions expire after 24 hours
- HTTPS automatic on Railway
- All secrets in environment variables — never in code
- IP allowlist (optional — set ALLOWED_IPS)
- Secure HTTP headers (Helmet)

---

## When Amazon API is approved
Once you receive your Client ID and Client Secret from Amazon:
1. Go to Railway → Variables
2. Update AMAZON_CLIENT_ID and AMAZON_CLIENT_SECRET
3. Railway restarts automatically
4. Click "Connect Amazon" in the app

---

## Support
Built with Claude — continue the conversation to add features.
