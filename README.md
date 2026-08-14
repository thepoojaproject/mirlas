# LiveChat (Supabase edition)

A complete, production-ready real-time 1-to-1 chat web app built with plain **HTML5, CSS3 and vanilla JavaScript**, powered by **Supabase** (Postgres + Auth + Realtime). No React, no Node.js, no npm, no backend server — it runs entirely as static files, so it deploys directly to **GitHub Pages**.

This is the Supabase port of the original Firebase version — the UI, layout, styling, and every feature are unchanged. Only the backend integration was replaced.

## Features

- Email/password signup and login (Supabase Auth)
- User profile (name + email + optional avatar) stored in Postgres
- Real-time 1-to-1 messaging (Supabase Realtime `postgres_changes`)
- Real-time, searchable user list
- Online / offline presence + "last seen"
- Typing indicator (Supabase Realtime Broadcast — no extra table needed)
- Message timestamps, sent/received bubble styling
- Auto-scroll to latest message, Enter-to-send
- Clean empty-chat / welcome state
- Mobile-first responsive layout (separate mobile chat screen with back button)
- XSS-safe message rendering (`textContent` only, never `innerHTML` with user data)
- Friendly error handling with toasts
- Secure database access via Postgres Row Level Security (RLS)

## Project structure

```
LiveChat/
├── index.html        # App markup (auth screens + chat shell) — unchanged
├── style.css          # All styling (responsive, mobile-first) — unchanged
├── app.js              # Supabase init + all app logic (ES module)
├── supabase.sql        # Schema, indexes, RLS policies, trigger, Realtime setup
└── README.md
```

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com/) and create a new project.
2. Wait for provisioning to finish, then open **Project Settings → API**.
3. Copy the **Project URL** and the **anon public** API key — you'll need both in step 3.

## 2. Run the database schema

1. In the Supabase dashboard, open **SQL Editor → New query**.
2. Paste the entire contents of `supabase.sql` and click **Run**.

This single script creates:

- `public.profiles` and `public.messages` tables with constraints
- Performance indexes (name search, per-conversation lookup, sender/receiver lookup)
- Row Level Security policies on both tables
- A trigger (`on_auth_user_created`) that automatically creates a `profiles` row whenever someone signs up
- Realtime replication settings so both tables stream live changes to clients

### What the RLS policies enforce

- **profiles**: any signed-in user can **read** the directory (needed for the sidebar/search), but a user can only **insert or update their own** row. There is no delete policy, so profiles can't be removed from the client.
- **messages**: a user can only **select** rows where they are the `sender_id` or `receiver_id`. A user can only **insert** a message as themselves (`sender_id = auth.uid()`). There are no update/delete policies, so messages are immutable once sent.

Because Supabase Realtime's `postgres_changes` events are filtered server-side by these same RLS policies, the app's single global "messages" channel only ever receives rows the signed-in user is actually allowed to see.

## 3. Add your Supabase config

Open `app.js` and replace the placeholder values near the top of the file:

```javascript
const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
```

with the **Project URL** and **anon public** key from step 1. The anon key is safe to expose in client-side code — it has no privileges beyond what your RLS policies allow.

## 4. Configure Auth settings

In **Authentication → URL Configuration**, add your GitHub Pages URL (e.g. `https://yourusername.github.io`) to **Site URL** and **Redirect URLs**.

If you want people to be able to sign in immediately after signup (no confirmation email), go to **Authentication → Providers → Email** and disable **Confirm email**. If you leave it enabled, the app already handles this gracefully — after signup it tells the user to check their email, then lets them log in once confirmed.

## 5. Deploy to GitHub Pages

1. Create a new GitHub repository and push these files (`index.html`, `style.css`, `app.js`, `supabase.sql`, `README.md`) to the root of the `main` branch.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select branch `main` and folder `/root`, then **Save**.
5. GitHub will give you a URL like `https://yourusername.github.io/your-repo/`. Open it — LiveChat is now live.

No build step, bundler, or server is required — the Supabase JS client is loaded directly from a CDN (`esm.sh`) as an ES module inside `app.js`.

## How the data model works

```
profiles
  id (uuid, = auth.users.id), name, email, avatar, online, last_seen, created_at

messages
  id, sender_id (-> profiles.id), receiver_id (-> profiles.id), content, created_at
```

There is no separate "chats" table. A conversation between two users is simply every `messages` row where the pair `(sender_id, receiver_id)` matches either direction — the app queries this with `.or(...)` when opening a chat, and a composite index (`least/greatest of the two ids + created_at`) keeps that lookup fast.

## How real-time works

- **New messages** — one Realtime channel is opened per session (not per chat) listening for `INSERT` on `public.messages`. RLS ensures it only ever streams rows the signed-in user is a participant in. When a message arrives for the currently-open chat, it's appended instantly; messages for other conversations are simply ignored by the client. This means switching chats never needs a new subscription for messages.
- **Online status / last seen** — one Realtime channel per session listens for `postgres_changes` on `public.profiles`. Presence itself is written with plain `update` calls (on login, tab focus/blur, and a 45s heartbeat) exactly as before; every other connected client sees those changes live through this channel.
- **Typing indicator** — uses Supabase Realtime **Broadcast** (not the database) on an ephemeral channel named `typing:<sorted-user-id-pair>`. This channel is opened when a chat is opened and properly closed (`supabase.removeChannel`) when you switch to a different chat, so there's never more than one typing channel active and never a duplicate listener.

## Presence notes

Like any client-driven presence system, this is **best-effort**: it's updated on sign-in, tab visibility changes, a 45-second heartbeat, and `beforeunload`/`pagehide`. A hard crash or killed process may occasionally leave a user shown as online until their next reload — this is standard behavior for Postgres/Realtime-based presence (Supabase's dedicated Presence API is channel-based and ephemeral, so this row-based approach was kept to preserve the existing "last seen" feature exactly as it worked before).

## Browser support

Works in all modern evergreen browsers (Chrome, Edge, Firefox, Safari) on both desktop and mobile — no transpilation needed since the code uses standard ES modules and modern (but broadly supported) JavaScript.

## Local development

Because `app.js` is loaded as an ES module, open the project through a local static server rather than a `file://` URL, for example:

```bash
python3 -m http.server 8080
```

then visit `http://localhost:8080`. Add `http://localhost:8080` to your Supabase **Redirect URLs** if you test auth flows locally.
