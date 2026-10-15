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

It runs as its own small app on Railway, next to your AdScale dashboard. The Amazon data is free; the Railway app adds a small amount to your monthly Railway usage (see Common questions).

**About A+ content:** Amazon only lets you read A+ content for your own brand through the API, so the tracker reads the competitor's public product page instead. Amazon sometimes shows a "robot check" page to automated visitors. When that happens, the tracker skips A+ for that day and tries again on the next run. It never reports a fake change because of it.

---

## How it works

1. A small app on Railway shows the tracker website, behind a password.
2. Every day after 9 AM New York time (you can change this), the app checks every competitor in `products.json`.
3. For each competitor, it finds the parent product and all its variations, then downloads their current details and prices.
4. It compares today's details with the last saved copy and records every difference.
5. Everything is saved on a Railway volume (a small permanent disk), so the history survives restarts and updates.
6. The **Check now** button on the website starts a check right away.

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

### Step 3. Add your competitors

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
- Saving the file on GitHub makes Railway restart the tracker with the new list (takes about a minute). The history is kept.

Settings at the top of the same file:

| Setting | What it does |
|---|---|
| `checkEveryDays` | `1` = every day, `3` = every 3 days, and so on |
| `checkAtHour` | Hour of the day to check, 0 to 23. `9` = 9 AM |
| `timeZone` | Time zone for `checkAtHour`, such as `America/New_York` or `America/Chicago` |
| `trackVariations` | `true` = follow every variation's price and listing. `false` = only the ASIN you listed |
| `maxChildrenPerParent` | Upper limit of variations per product, to keep runs fast |
| `checkAplusContent` | `false` turns off the A+ page check |
| `rankChangeAlertPercent` | Only log rank moves bigger than this percent (rank moves a little every day) |
| `marketplace` | `US` (also supports `CA`, `MX`, `UK`, `DE`) |

### Step 4. Create the Railway app

This uses the same Railway account and GitHub repository as your AdScale dashboard, but it is a separate app, so the dashboard is not affected.

1. Open your Railway project (the one with AdScale) and click **Create** (or **+ New**), then **GitHub Repo**, and pick `adscale` again.
2. Click the new service, open **Settings**, and set:
   - **Root Directory**: `/competitor-tracker`
   - **Watch Paths**: `/competitor-tracker/**` (so it only restarts when tracker files change)
   - **Branch**: `main`
3. Still in Settings, under **Networking**, click **Generate Domain**. This is your tracker website address.
4. Add a volume (the permanent disk): right-click the service, or use **Create**, choose **Volume**, attach it to this service, and set the mount path to `/data`. Without a volume, the history is erased every time the app restarts.
5. Open the **Variables** tab and add these 4 variables:

| Name | Value |
|---|---|
| `SPAPI_CLIENT_ID` | the Client identifier from Step 2 |
| `SPAPI_CLIENT_SECRET` | the Client secret from Step 2 |
| `SPAPI_REFRESH_TOKEN` | the Refresh Token from Step 2 |
| `SITE_PASSWORD` | a password you choose for the website |

6. Railway deploys the app. When it shows **Active**, open the website address. Your browser asks for a username and password: type anything as the username, and your `SITE_PASSWORD` as the password.

Optional: in your AdScale dashboard service, set **Watch Paths** to `!/competitor-tracker/**` so that editing the watch list does not restart the dashboard.

### Step 5. First check

The first check starts by itself within a minute after the app starts. You can also click **Check now** on the website. With many variations, a check takes several minutes; refresh the page to see progress.

The first check saves a starting copy of each product. Changes appear from the second check on.

---

## Common questions

**The website shows a warning, or nothing changes.** Warnings from the last check show at the top of the website. For more detail, open the tracker service on Railway and click **Deployments**, then **View logs**. The most common problems:
- `Amazon login failed`: one of the 3 SPAPI variables is wrong or has extra spaces. Copy them again.
- `Unauthorized` or `Access denied`: the app is missing the **Product Listing** or **Pricing** role. Add it, then authorize again for a new Refresh Token.
- `products.json is not valid JSON`: a comma or quote is missing in your watch list.
- `No Railway volume attached` in the logs: do Step 4, item 4.

**How much does it cost?** The Amazon data is free. The app is very small and sits idle between checks, so it should add only around $1 a month or less to your Railway usage. Your plan includes $5 of usage a month, shared with AdScale. You can see the exact amount under **Usage** in Railway.

**How many products can I track?** 50 parents with up to 40 variations each takes roughly 15 minutes per check. Prices are the slow part, because Amazon allows about 20 price lookups every 10 seconds.

**Can I download the raw data?** Open `your-tracker-address/changes.json` for every change ever recorded.

**Does this touch my AdScale dashboard?** No. It is a separate Railway service that only uses the `competitor-tracker` folder.

---

## For developers

```
npm install
npm test                      # runs the tracker and server against a fake Amazon server
npm start                     # website + daily schedule (what Railway runs)
FORCE_RUN=1 npm run track     # one check from the command line, also writes site/index.html
```
