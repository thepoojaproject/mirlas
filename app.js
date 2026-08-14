/* ==========================================================================
   LiveChat — app.js (Supabase edition)
   Vanilla JS + Supabase (Auth + Postgres + Realtime). No build step required.
   ========================================================================== */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* --------------------------------------------------------------------------
   1. SUPABASE CONFIGURATION
   Replace the placeholders below with your own Supabase project settings.
   Supabase Dashboard → Project Settings → API
   -------------------------------------------------------------------------- */
const SUPABASE_URL = "ftpozueynhllwussjqmb";
const SUPABASE_ANON_KEY = "sb_publishable_ipEpzQYLuiOj5LZZgVOg7A_L9EgzWTt";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/* --------------------------------------------------------------------------
   2. DOM REFERENCES
   -------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const authScreen = $("auth-screen");
const appScreen = $("app-screen");
const authError = $("auth-error");

const loginForm = $("login-form");
const signupForm = $("signup-form");
const showSignup = $("show-signup");
const showLogin = $("show-login");
const loginBtn = $("login-btn");
const signupBtn = $("signup-btn");

const meAvatar = $("me-avatar");
const meName = $("me-name");
const meEmail = $("me-email");
const logoutBtn = $("logout-btn");

const searchInput = $("search-users");
const userListEl = $("user-list");
const listLoading = $("list-loading");

const appShell = $("app-shell");
const chatEmpty = $("chat-empty");
const chatWindow = $("chat-window");
const chatAvatar = $("chat-avatar");
const chatHeaderName = $("chat-header-name");
const chatHeaderStatus = $("chat-header-status");
const backBtn = $("back-btn");

const messagesEl = $("messages");
const typingRow = $("typing-row");
const typingName = $("typing-name");

const messageForm = $("message-form");
const messageInput = $("message-input");
const sendBtn = $("send-btn");

const toastEl = $("toast");

/* --------------------------------------------------------------------------
   3. STATE
   -------------------------------------------------------------------------- */
let currentUser = null;      // Supabase auth user object
let currentProfile = null;   // profiles row for the signed-in user
let allProfiles = new Map(); // id -> profile row (excluding self)
let activeChatUid = null;    // id of the person currently chatting with
let activeChatId = null;     // deterministic "sorted uid pair" used for typing channel names

let messagesChannel = null;  // single global channel: streams INSERT on messages (RLS-scoped)
let profilesChannel = null;  // single global channel: streams profile changes (presence/last seen)
let typingChannel = null;    // per-open-chat channel: ephemeral typing broadcasts

let typingTimeout = null;
let isTypingSent = false;
let toastTimer = null;
let presenceHeartbeat = null;
let presenceHandlersRegistered = false;

/* --------------------------------------------------------------------------
   4. HELPERS
   -------------------------------------------------------------------------- */

function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

function chatIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase() || "?";
}

/** Applies an avatar image if the profile has one, otherwise falls back to initials text. */
function applyAvatar(el, profile) {
  el.textContent = "";
  el.style.backgroundImage = "";
  if (profile?.avatar) {
    el.style.backgroundImage = `url("${profile.avatar}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.textContent = initials(profile?.name);
  }
}

/** Friendly, human-readable error messages for common Supabase Auth responses. */
function friendlyAuthError(err) {
  const msg = err?.message || "";
  if (/already registered/i.test(msg)) return "That email is already registered. Try logging in instead.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email before logging in.";
  if (/password should be at least/i.test(msg)) return "Password should be at least 6 characters.";
  if (/unable to validate email/i.test(msg) || /invalid email/i.test(msg)) return "Please enter a valid email address.";
  if (/rate limit/i.test(msg)) return "Too many attempts. Please wait a moment and try again.";
  if (/network/i.test(msg) || /fetch/i.test(msg)) return "Network error. Check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}

function setAuthError(msg) {
  if (!msg) {
    authError.classList.add("hidden");
    authError.textContent = "";
    return;
  }
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

function setBtnLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector(".btn-label").classList.toggle("hidden", loading);
  btn.querySelector(".btn-spinner").classList.toggle("hidden", !loading);
}

/** Formats an ISO timestamp string into HH:MM. */
function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatLastSeen(isoString) {
  if (!isoString) return "Offline";
  const d = new Date(isoString);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Last seen just now";
  if (diffMin < 60) return `Last seen ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Last seen ${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `Last seen ${diffDay}d ago`;
  return `Last seen ${d.toLocaleDateString()}`;
}

function scrollMessagesToBottom(smooth = true) {
  messagesEl.scrollTo({
    top: messagesEl.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  });
}

/* --------------------------------------------------------------------------
   5. AUTH — SIGNUP / LOGIN / LOGOUT
   -------------------------------------------------------------------------- */

showSignup.addEventListener("click", (e) => {
  e.preventDefault();
  setAuthError(null);
  loginForm.classList.add("hidden");
  signupForm.classList.remove("hidden");
});

showLogin.addEventListener("click", (e) => {
  e.preventDefault();
  setAuthError(null);
  signupForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError(null);

  const name = $("signup-name").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;

  if (name.length < 2) {
    setAuthError("Please enter your full name.");
    return;
  }

  setBtnLoading(signupBtn, true);
  try {
    // The `name` metadata is read by a database trigger (handle_new_user, see
    // supabase.sql) which automatically creates the matching profiles row.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) throw error;

    if (!data.session) {
      // Email confirmation is enabled on the project — no session yet.
      setAuthError(null);
      showToast("Account created! Check your email to confirm, then log in.");
      signupForm.reset();
      signupForm.classList.add("hidden");
      loginForm.classList.remove("hidden");
    }
    // If a session IS returned, onAuthStateChange fires and enters the app.
  } catch (err) {
    setAuthError(friendlyAuthError(err));
  } finally {
    setBtnLoading(signupBtn, false);
  }
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError(null);

  const email = $("login-email").value.trim();
  const password = $("login-password").value;

  setBtnLoading(loginBtn, true);
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // onAuthStateChange will take over from here.
  } catch (err) {
    setAuthError(friendlyAuthError(err));
  } finally {
    setBtnLoading(loginBtn, false);
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    if (currentUser) {
      await supabase
        .from("profiles")
        .update({ online: false, last_seen: new Date().toISOString() })
        .eq("id", currentUser.id);
    }
    await supabase.auth.signOut();
  } catch (err) {
    showToast(friendlyAuthError(err));
  }
});

/* --------------------------------------------------------------------------
   6. AUTH STATE OBSERVER — entry point after login/signup/reload
   -------------------------------------------------------------------------- */

supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    if (currentUser?.id === session.user.id && event !== "SIGNED_IN") return; // avoid re-entering on token refresh
    currentUser = session.user;
    enterApp(session.user);
  } else {
    currentUser = null;
    teardownApp();
    authScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    loginForm.reset();
    signupForm.reset();
  }
});

async function enterApp(user) {
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  setAuthError(null);

  // Fetch (or, in rare edge cases, create) this user's profile row.
  let { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    const name = user.user_metadata?.name || user.email.split("@")[0];
    const { data: created, error: createErr } = await supabase
      .from("profiles")
      .upsert({
        id: user.id,
        name,
        email: user.email,
        online: true,
        last_seen: new Date().toISOString(),
      })
      .select()
      .single();
    if (createErr) {
      showToast(friendlyAuthError(createErr));
      return;
    }
    profile = created;
  } else {
    const { data: updated } = await supabase
      .from("profiles")
      .update({ online: true, last_seen: new Date().toISOString() })
      .eq("id", user.id)
      .select()
      .single();
    if (updated) profile = updated;
  }

  currentProfile = profile;
  renderMeCard();

  await subscribeToProfiles();
  subscribeToMessagesChannel();
  registerPresenceHandlers();
}

function teardownApp() {
  removeChannelSafe(messagesChannel);
  removeChannelSafe(profilesChannel);
  removeChannelSafe(typingChannel);
  messagesChannel = profilesChannel = typingChannel = null;

  clearInterval(presenceHeartbeat);
  presenceHeartbeat = null;
  presenceHandlersRegistered = false;

  allProfiles.clear();
  activeChatUid = null;
  activeChatId = null;
  currentProfile = null;

  userListEl.innerHTML = "";
  messagesEl.innerHTML = "";
  chatWindow.classList.add("hidden");
  chatEmpty.classList.remove("hidden");
  appShell.classList.remove("mobile-chat-active");
}

function removeChannelSafe(channel) {
  if (channel) supabase.removeChannel(channel);
}

function renderMeCard() {
  applyAvatar(meAvatar, currentProfile);
  meName.textContent = currentProfile?.name || "—";
  meEmail.textContent = currentProfile?.email || "—";
}

/* --------------------------------------------------------------------------
   7. PRESENCE (online / offline / last seen)
   Best-effort presence via direct row updates + realtime broadcast of those
   updates to everyone else (see subscribeToProfiles below).
   -------------------------------------------------------------------------- */

function registerPresenceHandlers() {
  if (presenceHandlersRegistered) return;
  presenceHandlersRegistered = true;

  // Heartbeat: refresh last_seen every 45s while the tab is visible & user is signed in.
  presenceHeartbeat = setInterval(() => {
    if (currentUser && document.visibilityState === "visible") {
      supabase
        .from("profiles")
        .update({ online: true, last_seen: new Date().toISOString() })
        .eq("id", currentUser.id)
        .then(() => {});
    }
  }, 45000);

  document.addEventListener("visibilitychange", () => {
    if (!currentUser) return;
    const online = document.visibilityState === "visible";
    supabase
      .from("profiles")
      .update({ online, last_seen: new Date().toISOString() })
      .eq("id", currentUser.id)
      .then(() => {});
  });

  window.addEventListener("beforeunload", () => {
    if (!currentUser) return;
    // Best-effort — browsers don't guarantee async work completes on unload.
    navigator.sendBeacon?.(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${currentUser.id}`,
      new Blob([JSON.stringify({ online: false, last_seen: new Date().toISOString() })], {
        type: "application/json",
      })
    );
    supabase
      .from("profiles")
      .update({ online: false, last_seen: new Date().toISOString() })
      .eq("id", currentUser.id)
      .then(() => {});
  });

  window.addEventListener("pagehide", () => {
    if (!currentUser) return;
    supabase
      .from("profiles")
      .update({ online: false, last_seen: new Date().toISOString() })
      .eq("id", currentUser.id)
      .then(() => {});
  });
}

/* --------------------------------------------------------------------------
   8. USER LIST (real-time, searchable)
   Initial fetch + a single persistent Realtime channel that streams profile
   inserts/updates so online status, last-seen and new signups appear live.
   -------------------------------------------------------------------------- */

async function subscribeToProfiles() {
  removeChannelSafe(profilesChannel);
  listLoading.classList.remove("hidden");
  listLoading.textContent = "Loading people…";

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    listLoading.textContent = "Couldn't load people. Check your connection.";
    showToast(friendlyAuthError(error));
  } else {
    allProfiles.clear();
    for (const p of data) {
      if (p.id !== currentUser.id) allProfiles.set(p.id, p);
    }
    renderUserList(searchInput.value.trim().toLowerCase());
  }

  profilesChannel = supabase
    .channel("public:profiles")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "profiles" },
      (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        if (!row || row.id === currentUser.id) return;

        if (payload.eventType === "DELETE") {
          allProfiles.delete(row.id);
        } else {
          allProfiles.set(row.id, payload.new);
        }

        renderUserList(searchInput.value.trim().toLowerCase());

        if (activeChatUid === row.id && payload.eventType !== "DELETE") {
          renderChatHeaderStatus(payload.new);
        }
      }
    )
    .subscribe();
}

function renderUserList(filterText = "") {
  userListEl.innerHTML = "";

  const entries = Array.from(allProfiles.values()).filter((u) =>
    !filterText ||
    u.name?.toLowerCase().includes(filterText) ||
    u.email?.toLowerCase().includes(filterText)
  );

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = allProfiles.size === 0
      ? "No other users yet. Invite someone to join!"
      : "No matches found.";
    userListEl.appendChild(empty);
    return;
  }

  for (const u of entries) {
    userListEl.appendChild(buildUserItem(u));
  }
}

function buildUserItem(u) {
  const item = document.createElement("div");
  item.className = "user-item" + (u.id === activeChatUid ? " active" : "");
  item.dataset.uid = u.id;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  applyAvatar(avatar, u);

  const dot = document.createElement("span");
  dot.className = "status-dot" + (u.online ? " online" : "");
  avatar.appendChild(dot);

  const info = document.createElement("div");
  info.className = "user-item-info";

  const nameEl = document.createElement("div");
  nameEl.className = "user-item-name";
  nameEl.textContent = u.name || "Unnamed";

  const subEl = document.createElement("div");
  subEl.className = "user-item-sub";
  subEl.textContent = u.online ? "Online" : formatLastSeen(u.last_seen);

  info.appendChild(nameEl);
  info.appendChild(subEl);
  item.appendChild(avatar);
  item.appendChild(info);

  item.addEventListener("click", () => openChat(u.id));
  return item;
}

searchInput.addEventListener("input", () => {
  renderUserList(searchInput.value.trim().toLowerCase());
});

/* --------------------------------------------------------------------------
   9. OPENING A CHAT
   -------------------------------------------------------------------------- */

async function openChat(uid) {
  if (uid === activeChatUid) {
    // Already open — on mobile just make sure the chat view is shown.
    appShell.classList.add("mobile-chat-active");
    return;
  }

  // Clean up the previous chat's ephemeral typing channel (messages/profiles
  // channels stay open for the whole session — see section 8 & 10).
  removeChannelSafe(typingChannel);
  typingChannel = null;
  clearTypingIndicatorUI();

  activeChatUid = uid;
  activeChatId = chatIdFor(currentUser.id, uid);

  appShell.classList.add("mobile-chat-active");
  chatEmpty.classList.add("hidden");
  chatWindow.classList.remove("hidden");
  messagesEl.innerHTML = '<div class="messages-loading">Loading conversation…</div>';

  // Highlight active item in the sidebar.
  document.querySelectorAll(".user-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.uid === uid);
  });

  const otherUser = allProfiles.get(uid);
  renderChatHeader(otherUser);

  await loadMessageHistory(uid);
  subscribeTyping(activeChatId);

  messageInput.value = "";
  messageInput.focus();
}

function renderChatHeader(u) {
  applyAvatar(chatAvatar, u);
  chatHeaderName.textContent = u?.name || "Unknown user";
  renderChatHeaderStatus(u);
}

function renderChatHeaderStatus(u) {
  if (!u) return;
  chatHeaderStatus.textContent = u.online ? "Online" : formatLastSeen(u.last_seen);
  chatHeaderStatus.classList.toggle("online", !!u.online);
}

backBtn.addEventListener("click", () => {
  appShell.classList.remove("mobile-chat-active");
});

/* --------------------------------------------------------------------------
   10. MESSAGES — history load + single global realtime INSERT listener
   (XSS-safe rendering via textContent, never innerHTML with user data)
   -------------------------------------------------------------------------- */

async function loadMessageHistory(otherUid) {
  const me = currentUser.id;
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .or(`and(sender_id.eq.${me},receiver_id.eq.${otherUid}),and(sender_id.eq.${otherUid},receiver_id.eq.${me})`)
    .order("created_at", { ascending: true });

  if (error) {
    showToast(friendlyAuthError(error));
    messagesEl.innerHTML = '<div class="messages-loading">Couldn\'t load messages.</div>';
    return;
  }

  renderMessageList(data);
}

function renderMessageList(rows) {
  messagesEl.innerHTML = "";
  if (!rows || rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "messages-loading";
    empty.textContent = "No messages yet. Say hello 👋";
    messagesEl.appendChild(empty);
    return;
  }

  let lastDay = null;
  for (const msg of rows) {
    const day = new Date(msg.created_at).toDateString();
    if (day !== lastDay) {
      messagesEl.appendChild(buildDayDivider(new Date(msg.created_at)));
      lastDay = day;
    }
    messagesEl.appendChild(buildMessageRow(msg));
  }
  scrollMessagesToBottom(false);
}

function buildDayDivider(date) {
  const div = document.createElement("div");
  div.className = "day-divider";
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (date.toDateString() === today) div.textContent = "Today";
  else if (date.toDateString() === yesterday) div.textContent = "Yesterday";
  else div.textContent = date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  return div;
}

function buildMessageRow(msg) {
  const row = document.createElement("div");
  const mine = msg.sender_id === currentUser.id;
  row.className = "msg-row " + (mine ? "mine" : "theirs");
  row.dataset.id = msg.id;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // XSS-safe: textContent only, never innerHTML with user-supplied data.
  const textNode = document.createElement("span");
  textNode.className = "msg-text";
  textNode.textContent = msg.content || "";
  bubble.appendChild(textNode);

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(msg.created_at);
  bubble.appendChild(time);

  row.appendChild(bubble);
  return row;
}

/** One persistent channel for the whole session — RLS already restricts the
 *  stream to rows where I'm the sender or receiver, so no per-chat
 *  resubscription (and no duplicate listeners) is needed when switching chats. */
function subscribeToMessagesChannel() {
  removeChannelSafe(messagesChannel);
  messagesChannel = supabase
    .channel("public:messages")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        const msg = payload.new;
        const belongsToActiveChat =
          activeChatUid &&
          ((msg.sender_id === currentUser.id && msg.receiver_id === activeChatUid) ||
            (msg.sender_id === activeChatUid && msg.receiver_id === currentUser.id));

        if (!belongsToActiveChat) return;

        // Avoid duplicate render if this row is already in the DOM.
        if (messagesEl.querySelector(`[data-id="${msg.id}"]`)) return;

        const loadingNode = messagesEl.querySelector(".messages-loading");
        if (loadingNode) loadingNode.remove();

        const lastDivider = [...messagesEl.querySelectorAll(".day-divider")].pop();
        const day = new Date(msg.created_at).toDateString();
        if (!lastDivider || lastDivider.textContent !== dayLabel(day)) {
          messagesEl.appendChild(buildDayDivider(new Date(msg.created_at)));
        }

        messagesEl.appendChild(buildMessageRow(msg));
        scrollMessagesToBottom();

        // The sender is clearly done typing once their message arrives.
        if (msg.sender_id === activeChatUid) {
          typingRow.classList.add("hidden");
        }
      }
    )
    .subscribe();
}

function dayLabel(dayString) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (dayString === today) return "Today";
  if (dayString === yesterday) return "Yesterday";
  return new Date(dayString).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/* --------------------------------------------------------------------------
   11. SENDING MESSAGES
   -------------------------------------------------------------------------- */

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await sendCurrentMessage();
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
});

async function sendCurrentMessage() {
  const text = messageInput.value.trim();
  if (!text || !activeChatUid) return;

  sendBtn.disabled = true;
  messageInput.value = "";
  setTypingState(false);

  const { error } = await supabase.from("messages").insert({
    sender_id: currentUser.id,
    receiver_id: activeChatUid,
    content: text,
  });
  // The realtime INSERT listener (section 10) renders the message once the
  // database confirms it — this keeps a single source of truth and avoids
  // any risk of rendering it twice.

  if (error) {
    showToast(friendlyAuthError(error));
    messageInput.value = text; // restore on failure
  }

  sendBtn.disabled = false;
  messageInput.focus();
}

/* --------------------------------------------------------------------------
   12. TYPING INDICATOR (ephemeral Realtime Broadcast — no DB writes)
   -------------------------------------------------------------------------- */

function subscribeTyping(chatId) {
  typingChannel = supabase
    .channel(`typing:${chatId}`)
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload || payload.userId === currentUser.id) return;
      if (payload.isTyping) {
        const otherUser = allProfiles.get(activeChatUid);
        typingName.textContent = otherUser?.name?.split(" ")[0] || "They";
        typingRow.classList.remove("hidden");
        scrollMessagesToBottom();
      } else {
        typingRow.classList.add("hidden");
      }
    })
    .subscribe();
}

messageInput.addEventListener("input", () => {
  if (!activeChatId) return;
  setTypingState(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => setTypingState(false), 2000);
});

messageInput.addEventListener("blur", () => setTypingState(false));

function setTypingState(isTyping) {
  if (!activeChatId || !currentUser || !typingChannel) return;
  if (isTyping === isTypingSent) return;
  isTypingSent = isTyping;
  typingChannel.send({
    type: "broadcast",
    event: "typing",
    payload: { userId: currentUser.id, isTyping },
  });
}

function clearTypingIndicatorUI() {
  typingRow.classList.add("hidden");
  isTypingSent = false;
  clearTimeout(typingTimeout);
}

/* --------------------------------------------------------------------------
   13. GLOBAL ERROR SAFETY NET
   -------------------------------------------------------------------------- */

window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || "";
  if (msg) console.error("Unhandled error:", e.reason);
});
