# Competitor Watch

A tool in OUTTANS HQ. It checks your Amazon competitors once a day (or every few days) and records every change:

| Change | Where it comes from |
|---|---|
| Price (Buy Box), list (strikethrough) price, number of sellers | Amazon SP-API (free) |
| Title, bullet points, description, brand | Amazon SP-API (free) |
| Main and gallery images (replaced, added, removed, reordered) | Amazon SP-API (free) |
| Variations added or removed under the parent | Amazon SP-API (free) |
| Best Sellers Rank (only big moves, 25% or more by default) | Amazon SP-API (free) |
| Any other listing detail (material, dimensions, weight, etc.) | Amazon SP-API (free) |
| A+ content (text and images) | Public product page (free, see note below) |

**About A+ content:** Amazon only lets you read A+ content for your own brand through the API, so the tracker reads the competitor's public product page instead. Amazon sometimes shows a "robot check" page to automated visitors. When that happens, the tracker skips A+ for that day and tries again on the next check. It never reports a fake change because of it.

---

## How it works

1. Every day after 9 AM New York time (you can change this), OUTTANS HQ checks every competitor in `products.json`.
2. For each competitor, it finds the parent product and all its variations, then downloads their current details and prices.
3. It compares today's details with the last saved copy and records every difference.
4. The **Competitor Watch** tab shows each competitor and a feed of every change, with "before" and "after".
5. The **Check now** button starts a check right away.

---

## Setup

First set up OUTTANS HQ itself (see the main README). Then:

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
2. Name it `OUTTANS HQ`, choose API type **SP API**, and tick the roles **Product Listing** and **Pricing**. Save.
3. In the app list, next to "LWA credentials", click **View**. Copy:
   - **Client identifier** (starts with `amzn1.application-oa2-client.`)
   - **Client secret**
4. In the app list, open the arrow next to **Edit App** and click **Authorize**. Click **Authorize app** and copy the **Refresh Token** (starts with `Atzr|`).

Keep these 3 values private, like a password.

### Step 3. Add the keys on Railway

In your OUTTANS HQ service on Railway, open **Variables** and add:

| Name | Value |
|---|---|
| `SPAPI_CLIENT_ID` | the Client identifier |
| `SPAPI_CLIENT_SECRET` | the Client secret |
| `SPAPI_REFRESH_TOKEN` | the Refresh Token |

Railway restarts the app on its own.

### Step 4. Add your competitors

Edit `tools/competitor-tracker/products.json` on github.com (click the file, then the pencil icon). Replace the example line with your competitors:

```json
"products": [
  { "asin": "B0ABC12345", "nickname": "Brand A 8 ft table" },
  { "asin": "B0DEF67890", "nickname": "Brand B round table" }
]
```

- You can use the parent ASIN or the ASIN of any one variation. The tracker finds the parent and follows all variations.
- Every line except the last needs a comma at the end.
- The nickname is just for you.
- Saving the file on GitHub makes Railway restart OUTTANS HQ with the new list (about a minute). The history is kept.

Settings at the top of the same file:

| Setting | What it does |
|---|---|
| `checkEveryDays` | `1` = every day, `3` = every 3 days, and so on |
| `checkAtHour` | Hour of the day to check, 0 to 23. `9` = 9 AM |
| `timeZone` | Time zone for `checkAtHour`, such as `America/New_York` or `America/Chicago` |
| `trackVariations` | `true` = follow every variation's price and listing. `false` = only the ASIN you listed |
| `maxChildrenPerParent` | Upper limit of variations per product, to keep checks fast |
| `checkAplusContent` | `false` turns off the A+ page check |
| `rankChangeAlertPercent` | Only log rank moves bigger than this percent (rank moves a little every day) |
| `marketplace` | `US` (also supports `CA`, `MX`, `UK`, `DE`) |

### Step 5. First check

Open the **Competitor Watch** tab and click **Check now**, or wait for the daily check. With many variations, a check takes several minutes; refresh the page to see progress.

The first check saves a starting copy of each product. Changes appear from the second check on.

---

## Common questions

**The tab shows a warning, or nothing changes.** Warnings from the last check show at the top of the tab. For more detail, open the service on Railway and click **Deployments**, then **View logs**. The most common problems:
- `Amazon login failed`: one of the 3 SPAPI variables is wrong or has extra spaces. Copy them again.
- `Unauthorized` or `Access denied`: the app is missing the **Product Listing** or **Pricing** role. Add it, then authorize again for a new Refresh Token.
- `products.json is missing or is not valid JSON`: a comma or quote is missing in your watch list.

**How many products can I track?** 50 parents with up to 40 variations each takes roughly 15 minutes per check. Prices are the slow part, because Amazon allows about 20 price lookups every 10 seconds.

**Can I download the raw data?** While logged in, open `your-hq-address/competitor-tracker/changes.json` for every change ever recorded.

---

## Files in this folder

| File | What it does |
|---|---|
| `index.js` | Plugs the tool into OUTTANS HQ: the tab, the Check now button, the daily schedule |
| `tracker.js` | One check: downloads, compares, saves |
| `spapi.js` | Talks to Amazon's Selling Partner API |
| `aplus.js` | Reads A+ content from the public product page |
| `normalize.js` | Turns Amazon's data into a tidy snapshot |
| `diff.js` | Decides what counts as a change |
| `data.js`, `page.js` | What the tab shows and how it looks |
| `products.json` | Your watch list and settings |
