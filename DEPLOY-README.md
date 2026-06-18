# Swift Investments — One-URL Deploy (Root Version)

This package is laid out so the backend sits at the **repo root**. That means
there is **NO “Root Directory” to set** in Render — the thing that errored before.

## What’s in here (these must end up at the TOP LEVEL of your repo)
```
server.js          ← backend: serves the website + /api + database
public/index.html  ← the app the server shows
package.json
render.yaml        ← Render reads this automatically
.node-version
.gitignore
.env.example
```

## Step 1 — Use a FRESH repo (cleanest)
1. On GitHub click **+** → **New repository**, name it `swift-app`, **Public**, **Create**.
2. On the empty repo page click **uploading an existing file**.
3. **Unzip this package, OPEN the unzipped folder, select ALL the files inside it**
   (server.js, render.yaml, the `public` folder, package.json, etc.) and drag them in.
   ⚠️ Drag the **files themselves**, not the folder that contains them.
4. **Commit changes.**

✅ Check: your repo’s front page should list **server.js** and **render.yaml**
directly. If you instead see one folder you must click into, delete those and
re-upload the files (not the folder).

## Step 2 — Deploy on Render
**Easiest — Blueprint:** New + → **Blueprint** → pick the repo → **Apply**.

**Or manual:** New + → **Web Service** → pick the repo, then:
- **Root Directory:** leave **EMPTY** (this is the fix — do not type `server`)
- **Build Command:** leave blank
- **Start Command:** `node --no-warnings --experimental-sqlite server.js`
- **Instance Type:** Free
- **Advanced → Add Environment Variable:** `NODE_VERSION` = `22.12.0`
- **Create Web Service**

## Step 3 — Open it
When Render says **Live**, open the URL. Log in with:
- Email: `demo@swift.io`
- Password: `demo1234`

> Free tier note: the app sleeps when idle (first visit ~30s to wake), and the
> database resets on redeploy. To make data permanent, see the disk option in
> `render.yaml`.
