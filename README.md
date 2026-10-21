# OUTTANS HQ

The OUTTANS team's internal tools, in one place. Each tool is a tab at the top of the screen. Everyone logs in with their own email and password.

| Tool | What it does |
|---|---|
| **Competitor Watch** | Tracks Amazon competitors every day: price, title, bullets, images, A+ content, variations and more. [Guide](tools/competitor-tracker/README.md) |

---

## Setting it up on Railway

OUTTANS HQ replaces AdScale. It runs on the same Railway service AdScale used, so there is no new app to create.

### Step 1. Publish the code

Merge the pull request into `main` on GitHub. Railway notices and starts building OUTTANS HQ automatically.

### Step 2. Add a volume (permanent storage)

OUTTANS HQ saves accounts and tool data on a Railway volume, so nothing is lost when the app restarts.

1. Open your Railway project.
2. Right-click an empty spot on the canvas (or click **Create**), choose **Volume**, and attach it to the service that used to run AdScale.
3. Set the mount path to `/data`.

### Step 3. Set the variables

Open the service, then the **Variables** tab.

**Add these:**

| Name | Value |
|---|---|
| `ADMIN_EMAIL` | your email, for the first admin account |
| `ADMIN_PASSWORD` | a password of at least 10 characters for that account |
| `ADMIN_NAME` | your name, as shown in the app |

The admin account is created the first time OUTTANS HQ starts. After that, these three are not used again. You can change your password inside the app any time.

**Delete these old AdScale ones** (if you see them): `APP_PASSWORD`, `ALLOWED_IPS`, `MAP_BEARER_TOKEN`, `MAP_ACCOUNT_ID`, `MAP_INTEGRATION_ID`, `MAP_BRAND_ID`, `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REGION`, `AMAZON_REDIRECT_URI`, `DATABASE_URL`.

If you have a `SESSION_SECRET`, keep it. If not, OUTTANS HQ makes its own.

If your project has a PostgreSQL database that AdScale used, OUTTANS HQ does not need it. You can delete it to save usage, but only once you are sure you no longer want AdScale's old data.

### Step 4. Rename things (optional, but tidy)

- **Railway service:** open **Settings** and rename it to `outtans-hq`. Under **Networking**, you can change the web address to something like `outtans-hq.up.railway.app`.
- **GitHub repository:** on github.com, open the repository, then **Settings**. Change the name from `adscale` to `outtans-hq` and click **Rename**. Afterward, check that Railway's service **Settings** still shows the repository. If it does not, connect it again.
- **Old tracker service:** if you created a separate Railway service for the competitor tracker earlier, delete it. Competitor Watch now lives inside OUTTANS HQ.

### Step 5. Log in

Open the web address, log in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`, and you are in.

Each tool may need its own setup. For Competitor Watch, see its [guide](tools/competitor-tracker/README.md).

---

## Your team

Only admins can manage the team. Click your initials in the top right, then **Team**.

- **Add a person:** enter their name and email, and pick **Member** (uses the tools) or **Admin** (can also manage the team). You get a temporary password to send them. The first time they log in, they choose their own password.
- **Forgot password:** click **Reset password** next to the person. They get a new temporary password, and any open sessions they have are logged out.
- **Remove someone:** click **Remove**. They are logged out right away and cannot log in again.

Everyone can change their own password under **Your account**.

**Security built in:** passwords are stored only as secure hashes, 5 wrong passwords lock the login for 15 minutes, sessions last 14 days, and changing a password logs out other devices.

---

## Costs

OUTTANS HQ is one small app on your Railway plan, the same as AdScale was. Tools add little on top, because they sit idle most of the day. You can see exact numbers under **Usage** in Railway.

---

## For developers

```
npm install
npm test      # platform and tool tests, using a fake Amazon server
npm start     # runs on http://localhost:8080 (set ADMIN_EMAIL and ADMIN_PASSWORD the first time)
```

**Layout**

| Path | What it is |
|---|---|
| `server.js` | Starts the app |
| `platform/` | Logins, team management, the page frame and tabs |
| `public/hq.css` | Shared look: colors, fonts, buttons, forms, tables (light and dark) |
| `tools/index.js` | The list of tools; each one becomes a tab, in this order |
| `tools/<tool>/` | One folder per tool |
| `test/` | Automated tests |

Data is saved in `DATA_DIR`, or the Railway volume, or `./data` locally. Each tool gets its own folder at `<data>/tools/<tool id>/`.

**Adding a tool**

1. Create `tools/<tool-id>/index.js` that exports `{ id, name, setup }`:

   ```js
   export default {
     id: 'my-tool',        // the tab's address: /my-tool
     name: 'My Tool',      // the tab's label
     setup({ router, dataDir, basePath, render, log }) {
       router.get('/', (req, res) => res.send(render(req, { title: 'My Tool', body: '<h1>My Tool</h1>' })));
       return { start() { /* optional: schedules */ } };
     },
   };
   ```

2. Add it to the list in `tools/index.js`.

`router` is an Express router (only logged-in people reach it, and `req.user` is the person). `render` wraps your page in the OUTTANS HQ frame. Use the classes in `public/hq.css` (`panel`, `btn`, `form`, `table`, `pill`, `notice`) so every tool looks the same.
