# Competitor Watch

Checks your Amazon competitors once a day (or every few days) and records every change:

| Change | Where it comes from |
|---|---|
| Price (Buy Box), list (strikethrough) price, number of sellers | Amazon SP-API (free) |
| Title, bullet points, description, brand | Amazon SP-API (free) |
| Main and gallery images (replaced, added, removed, reordered) | Amazon SP-API (free) |
| Variations added or removed under the parent | Amazon SP-API (free) |
| Best Sellers Rank (only big moves, 25% or more by default) | Amazon SP-API (free) |
| Any other listing detail (material, dimensions, weight, etc.) | Amazon SP-API (free) |
| A+ content (text and images) | Public product page (free, see note below) |

Everything runs for free on GitHub. Results appear on a small website (Step 5) and are also saved in this folder.

**About A+ content:** Amazon only lets you read A+ content for your own brand through the API, so the tracker reads the competitor's public product page instead. Amazon sometimes shows a "robot check" page to automated visitors. When that happens, the tracker skips A+ for that day and tries again on the next run. It never reports a fake change because of it.

---

## How it works

1. Every day at 9:17 AM New York time, GitHub starts the tracker (file: `.github/workflows/competitor-tracker.yml`).
2. The tracker reads your watch list in `products.json`.
3. For each competitor, it finds the parent product and all its variations, then downloads their current details and prices.
4. It compares today's details with the last saved copy and writes every difference to `data/changes.json`.
5. It rebuilds the website in `site/index.html` and saves everything back to GitHub.

---

## Setup (about 30 minutes, plus waiting for Amazon's approval)

### Step 1. Register as an SP-API developer in Seller Central

1. Log in to Seller Central.
2. Open the menu, go to **Apps and Services**, then **Develop Apps**.
3. If asked, fill in the **developer profile**:
   - Choose **Private developer** ("I build applications that integrate my own company with Amazon").
   - For data access (roles), tick **Product Listing** and **Pricing**. Nothing else is needed.
   - Answer the security questions honestly: the tracker only reads public catalog and price data and stores no customer information.
4. Submit. Amazon usually approves private developers within a few days. You will get an email.

### Step 2. Create the app and get your 3 keys

1. Back in **Develop Apps**, click **Add new app client**.
2. Name it `Competitor Watch`, choose API type **SP API**, and tick the roles **Product Listing** and **Pricing**. Save.
3. In the app list, next to "LWA credentials", click **View**. Copy:
   - **Client identifier** (starts with `amzn1.application-oa2-client.`)
   - **Client secret**
4. In the app list, open the arrow next to **Edit App** and click **Authorize**. Click **Authorize app** and copy the **Refresh Token** (starts with `Atzr|`).

Keep these 3 values private, like a password.

### Step 3. Save the keys in GitHub

1. Open this repository on github.com.
2. Go to **Settings**, then **Secrets and variables**, then **Actions**.
3. Click **New repository secret** three times and add:

| Name | Value |
|---|---|
| `SPAPI_CLIENT_ID` | the Client identifier |
| `SPAPI_CLIENT_SECRET` | the Client secret |
| `SPAPI_REFRESH_TOKEN` | the Refresh Token |

### Step 4. Add your competitors

Edit `competitor-tracker/products.json` on github.com (click the file, then the pencil icon). Replace the example line with your competitors:

```json
"products": [
  { "asin": "B0ABC12345", "nickname": "Brand A 8 ft table" },
  { "asin": "B0DEF67890", "nickname": "Brand B round table" }
]
```

- You can use the parent ASIN or the ASIN of any one variation. The tracker finds the parent and follows all variations.
- Every line except the last needs a comma at the end.
- The nickname is just for you.

Settings at the top of the same file:

| Setting | What it does |
|---|---|
| `checkEveryDays` | `1` = every day, `3` = every 3 days, and so on |
| `trackVariations` | `true` = follow every variation's price and listing. `false` = only the ASIN you listed |
| `maxChildrenPerParent` | Upper limit of variations per product, to keep runs fast |
| `checkAplusContent` | `false` turns off the A+ page check |
| `rankChangeAlertPercent` | Only log rank moves bigger than this percent (rank moves a little every day) |
| `marketplace` | `US` (also supports `CA`, `MX`, `UK`, `DE`) |

### Step 5. Put the website online (free, on Netlify)

1. Go to [netlify.com](https://www.netlify.com) and sign up with your GitHub account.
2. Click **Add new site**, then **Import an existing project**, then **GitHub**, and pick the `adscale` repository.
3. Set **Branch to deploy** to `main` and **Base directory** to `competitor-tracker`. Leave everything else as is. Click **Deploy**.
4. Netlify gives you an address like `random-name-123.netlify.app`. You can rename it under **Site configuration**.

The website updates on its own every time the tracker runs. Note: anyone who has the address can open it (search engines are told not to list it). It only shows public Amazon information.

### Step 6. Run it the first time

1. On github.com, open the **Actions** tab.
2. Click **Competitor tracker** on the left, then **Run workflow**, then the green **Run workflow** button.
3. Wait a few minutes. A green check means it worked.

The first run saves a starting copy of each product. Changes appear from the second run on.

---

## Common questions

**I got an email that the run failed.** Open the **Actions** tab, click the failed run, then **Check competitors**. The last lines explain the problem. The most common ones:
- `Amazon login failed`: one of the 3 secrets is wrong or has extra spaces. Copy them again.
- `Unauthorized` or `Access denied`: the app is missing the **Product Listing** or **Pricing** role. Add it, then authorize again for a new Refresh Token.
- `products.json is not valid JSON`: a comma or quote is missing in your watch list.

**How many products can I track?** 50 parents with up to 40 variations each takes roughly 15 minutes per run, well inside GitHub's free allowance. Prices are the slow part, because Amazon allows about 20 price lookups every 10 seconds.

**Can I see the raw data?** Yes. `data/changes.json` has every change, `data/snapshots/` has the latest copy of each product, and `data/history/` keeps daily prices and ranks for future charts.

**Does this touch my AdScale dashboard?** No. It lives only in this folder and its own GitHub workflow.

---

## For developers

```
npm install
npm test                      # runs the tracker twice against a fake Amazon server
FORCE_RUN=1 npm run track     # real run (needs the 3 SPAPI_ variables)
npm run build-site            # rebuild site/index.html from data/
```
