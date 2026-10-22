import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@1/+esm";

// ─── fleetr hq ────────────────────────────────────────────────────────────────
// Fleetr's own console for managing customer companies. Same stack as
// fleetr-internal (no build, React and supabase-js v1 from CDNs, served as-is by
// GitHub Pages), with everything that app does for branch staff left out.
//
// Nothing here is a security boundary. The page only decides what to SHOW.
// What an account can actually do is decided by the fleetr-reset Worker, which
// verifies the session and calls public.is_platform_admin() before it reads or
// writes anything. A person who edits this file in their browser gets a
// different screen and the same 403.

// ─── Supabase client ──────────────────────────────────────────────────────────
// Same project and anon key as fleetr-internal. The anon key is public by
// design; it ships in every browser that loads either app.
const SUPABASE_URL  = "https://hzcatlecvwpqxedrzfog.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2F0bGVjdndwcXhlZHJ6Zm9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNzQzMTMsImV4cCI6MjA5MzY1MDMxM30.mfqwWQh54hPsRunAVB6RDf_IrvwKmhSYWWJ4sMy0rcw";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// The Worker holding the service role. The /admin routes live there, not on
// fleetr-ai-proxy, so that key never sits in the public proxy.
const ADMIN_API_URL = "https://fleetr-reset.connor-0a5.workers.dev";

// Matches fleetr-internal, so a password accepted there is accepted here.
const PASSWORD_MAX = 72;

const h = React.createElement;

// ─── Messages ─────────────────────────────────────────────────────────────────
// Same idea as internal's LOGIN_REASONS: only a wrong password stays vague.
// not_authorized is reached only after a correct password, so saying so gives
// away nothing the person did not just prove.
const REASONS = {
  credentials:    "Invalid credentials",
  not_authorized: "Not authorized",
  load_failed:    "Signed in, but the company list could not be loaded. Try again.",
  network:        "Could not reach the server.",
  auth_other:     "Could not sign in. Try again.",
};
const reasonMessage = (reason) => REASONS[reason] || REASONS.auth_other;

// Copied from fleetr-internal. GoTrue answers a wrong password and an unknown
// address identically, and that is the one failure worth hiding.
const isBadCredentials = (err) => {
  if (!err) return false;
  if (typeof err === "string") return /invalid login credentials/i.test(err);
  return err.error_code === "invalid_credentials" ||
         /invalid login credentials/i.test(String(err.message || err.msg || ""));
};

// ─── The gate ─────────────────────────────────────────────────────────────────
// Asks the Worker for the company list with the session's own token. This is
// both the permission check and the data load: a platform admin gets the list,
// anyone else gets 401 or 403 and never sees it.
//
// Returns { ok, companies } or { ok: false, reason, error }. Never throws.
async function loadCompanies() {
  const session = supabase.auth.session();
  if (!session) return { ok: false, reason: "not_authorized", error: "no session" };
  let res;
  try {
    res = await fetch(`${ADMIN_API_URL}/admin/companies`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch (e) {
    return { ok: false, reason: "network", error: e.message || String(e) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "not_authorized", error: String(res.status) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !Array.isArray(body.companies)) {
    return { ok: false, reason: "load_failed", error: String(res.status) };
  }
  return { ok: true, companies: body.companies };
}

// Every failure past a correct password signs out. A session that cannot get
// through the gate is no use here, and leaving it behind would put the next
// page load straight back through the same refusal.
async function passGateOrSignOut() {
  const gate = await loadCompanies();
  if (!gate.ok) await supabase.auth.signOut().catch((e) => console.warn("sign out:", e));
  return gate;
}

async function signIn(email, password) {
  try {
    // supabase-js v1: signIn, not v2's signInWithPassword.
    const { error } = await supabase.auth.signIn({ email, password });
    if (error) {
      if (isBadCredentials(error)) return { ok: false, reason: "credentials", error: error.message };
      return { ok: false, reason: "auth_other", message: error.message, error: error.message };
    }
  } catch (e) {
    return { ok: false, reason: "network", error: e.message || String(e) };
  }
  return passGateOrSignOut();
}

// On load, a stored session is re-checked rather than trusted. The company list
// is never persisted: it is fetched fresh each time, so signing out leaves none
// of it behind in the browser.
async function resumeSession() {
  const session = supabase.auth.session();
  if (!session) return null;
  // A token that expired while the tab was closed would come back 401 and read
  // as "Not authorized". Refreshed first so an expiry is not mistaken for a
  // refusal.
  if (session.expires_at && session.expires_at * 1000 < Date.now() + 30 * 1000) {
    const { error } = await supabase.auth.refreshSession();
    if (error) {
      await supabase.auth.signOut().catch(() => {});
      return null;
    }
  }
  return passGateOrSignOut();
}

// ─── Shared pieces ────────────────────────────────────────────────────────────
// Line icons on a 24 grid, the staff app's style.
const ICONS = {
  companies: ["M3 21h18", "M5 21V7l7-4 7 4v14", "M9 9h.01", "M15 9h.01", "M9 13h.01", "M15 13h.01", "M10 21v-4h4v4"],
  texts:     ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M8 9h8", "M8 13h5"],
  billing:   ["M6 2h12v20l-3-2-3 2-3-2-3 2z", "M9 7h6", "M9 11h6", "M9 15h4"],
  dashboard: ["M3 3v18h18", "M7 15v3", "M12 10v8", "M17 6v12"],
  plus:      ["M12 5v14", "M5 12h14"],
  search:    ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  chevron:   ["M9 18l6-6-6-6"],
  check:     ["M20 6L9 17l-5-5"],
  copy:      ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  close:     ["M18 6L6 18", "M6 6l12 12"],
  menu:      ["M3 6h18", "M3 12h18", "M3 18h18"],
  signOut:   ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  sort:      ["M7 15l5 5 5-5", "M7 9l5-5 5 5"],
  dash:      ["M6 12h12"],
};
function Icon({ name, size = 18, className }) {
  return h("svg", { className, width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    (ICONS[name] || []).map((d, i) => h("path", { key: i, d })));
}

// A company's or person's initials, for the round avatars.
const initialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0].toUpperCase()).join("") || "?";
function Avatar({ name, size }) {
  return h("span", { className: `avatar${size === "lg" ? " avatar--lg" : ""}`, "aria-hidden": "true" }, initialsOf(name));
}

const prefersReducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
};
// Counts up to the value, as the staff app's Home numbers do.
function CountUp({ value }) {
  const still = prefersReducedMotion();
  const [shown, setShown] = React.useState(still ? value : 0);
  const at = React.useRef(still ? value : 0);
  React.useEffect(() => {
    // A hidden tab runs no animation frames, so it shows the number at once.
    if (prefersReducedMotion() || document.hidden) { at.current = value; setShown(value); return undefined; }
    const from = at.current, start = performance.now();
    let raf = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / 800);
      at.current = from + (value - from) * (1 - Math.pow(1 - p, 3));
      setShown(Math.round(at.current));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown.toLocaleString();
}

// Toasts: a short message in the corner that goes by itself, for a save that
// worked. Errors stay where they happened, beside what failed.
const toastListeners = new Set();
let toastSeq = 0;
function toast(text) { const t = { id: ++toastSeq, text }; toastListeners.forEach((fn) => fn(t)); }
function Toaster() {
  const [list, setList] = React.useState([]);
  React.useEffect(() => {
    const add = (t) => {
      setList((l) => [...l.slice(-2), t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 4000);
    };
    toastListeners.add(add);
    return () => toastListeners.delete(add);
  }, []);
  return h("div", { className: "toaster", role: "status", "aria-live": "polite" },
    list.map((t) => h("div", { key: t.id, className: "toast" },
      h("span", { className: "toast__icon" }, h(Icon, { name: "check", size: 14 })),
      h("span", { className: "toast__text" }, t.text),
      h("button", { type: "button", className: "toast__close", "aria-label": "Dismiss",
        onClick: () => setList((l) => l.filter((x) => x.id !== t.id)) }, h(Icon, { name: "close", size: 14 })))));
}

// Grey shapes with a sheen passing over them while something loads, the
// website's skeleton.
function Skeleton({ lines = 3 }) {
  return h("div", { className: "skel", "aria-busy": "true", "aria-label": "Loading" },
    h("div", { className: "sk sk--title" }),
    Array.from({ length: lines }, (_, i) => h("div", { key: i, className: "sk sk--row" })));
}

// ─── Screens ──────────────────────────────────────────────────────────────────
// The fleetr wordmark (wordmark.svg, "fleetr" in Inter SemiBold as
// outlines), then "hq". tone "dark" is #F9F9F7 for the dark sidebar;
// otherwise terracotta, for light backgrounds.
function Wordmark({ tone } = {}) {
  return h("div", { className: "wordmark" },
    h("span", { className: `wordmarkLogo${tone === "dark" ? " wordmarkLogo--dark" : ""}`, role: "img", "aria-label": "fleetr" }),
    h("span", { className: "wordmarkHq" }, "hq"));
}

function LoginScreen({ onSuccess, notice }) {
  const [email,    setEmail]    = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error,    setError]    = React.useState(notice || "");
  const [loading,  setLoading]  = React.useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    signIn(email.trim().toLowerCase(), password)
      .then((result) => {
        if (result.ok) { onSuccess(result.companies); return; }
        console.warn("fleetr hq sign-in failed:", result.reason, result.error);
        setError(result.message || reasonMessage(result.reason));
      })
      .finally(() => setLoading(false));
  };

  // As the staff app's sign-in page draws it (fleetr-internal LoginScreen):
  // the card, the centred wordmark, two fields and the terracotta pill.
  return h("div", { className: "hqSignIn" },
    h("div", { className: "hqSignIn__card" },
      h("h1", { className: "hqSignIn__brand", "aria-label": "fleetr HQ" },
        h("span", { className: "wordmarkLogo hqSignIn__wordmark", "aria-hidden": "true" }),
        h("span", { className: "hqSignIn__hq", "aria-hidden": "true" }, "HQ")),
      h("form", { className: "hqSignIn__form", onSubmit: handleSubmit },
        h("input", {
          id: "email", className: "hqSignIn__input", type: "email", required: true, placeholder: "Email",
          "aria-label": "Email", autoComplete: "username", value: email,
          onChange: (e) => { setEmail(e.target.value); setError(""); },
        }),
        h("input", {
          id: "password", className: "hqSignIn__input", type: "password", required: true, placeholder: "Password",
          "aria-label": "Password", maxLength: PASSWORD_MAX, autoComplete: "current-password", value: password,
          onChange: (e) => { setPassword(e.target.value); setError(""); },
        }),
        h("button", { type: "submit", className: "hqSignIn__btn", disabled: loading },
          loading ? "Signing in…" : "Sign in"),
        error && h("div", { className: "hqSignIn__error", role: "alert" }, error))));
}

// ─── Creating a company ───────────────────────────────────────────────────────
// Returns { ok, company } or { ok: false, message }. Never throws. The message
// is the Worker's own when it sent one: it already words each refusal for a
// person, and a second table of reasons here would only drift from it.
async function createCompany(name) {
  const session = supabase.auth.session();
  if (!session) return { ok: false, message: "Your session has ended. Sign in again." };
  let res;
  try {
    res = await fetch(`${ADMIN_API_URL}/admin/companies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    console.warn("fleetr hq create company failed:", e.message || String(e));
    return { ok: false, message: REASONS.network };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body && body.ok && body.company) return { ok: true, company: body.company };
  console.warn("fleetr hq create company refused:", res.status);
  return { ok: false, message: (body && body.message) || `Could not create the company (${res.status}).` };
}

// ─── Routing ──────────────────────────────────────────────────────────────────
// Two routes, so a hash listener rather than react-router. Hash-based for the
// same reason internal uses HashRouter: GitHub Pages serves one file and would
// 404 on any real path.
// Set by a screen holding unsaved changes: returns the warning to show before
// leaving it, or null when there is nothing to lose.
let leaveGuard = null;
const confirmLeave = () => {
  const msg = leaveGuard && leaveGuard();
  return !msg || window.confirm(msg);
};

function useHashRoute() {
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    let current = window.location.hash;
    const onChange = () => {
      // Cancelled: put the address back without firing another hashchange.
      if (!confirmLeave()) {
        history.replaceState(null, "", current || window.location.pathname + window.location.search);
        return;
      }
      current = window.location.hash;
      setHash(current);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  if (hash === "#/texts") return { name: "texts" };
  if (hash === "#/dashboard") return { name: "dashboard" };
  const b = hash.match(/^#\/billing(?:\/([^/?#]+)\/(\d{4}-\d{2}))?$/);
  if (b) return b[1] ? { name: "billingCompany", id: decodeURIComponent(b[1]), month: b[2] } : { name: "billing" };
  const m = hash.match(/^#\/company\/([^/?#]+)$/);
  return m ? { name: "company", id: decodeURIComponent(m[1]) } : { name: "list" };
}

// ─── Screens: signed in ───────────────────────────────────────────────────────
const STATUS_LABELS = { trial: "Trial", active: "Active", suspended: "Suspended" };

function StatusBadge({ status }) {
  return h("span", { className: `badge badge-${STATUS_LABELS[status] ? status : "unknown"}` },
    h("span", { className: "badge__dot", "aria-hidden": "true" }),
    STATUS_LABELS[status] || status || "Unknown");
}

// Where a company is in its own setup, as a pill.
function SetupBadge({ company }) {
  const label = setupStateLabel(company);
  return h("span", { className: `pill pill--${label === "Live" ? "live" : label === "Paused" ? "paused" : "setup"}` }, label);
}

// Where a company is in its own setup: before launch, paused by its Exec, or
// live. Suspension is the status above, set here.
function setupStateLabel(c) {
  if (!c.launchedAt) return "In setup";
  if (c.pausedAt) return "Paused";
  return "Live";
}

function NewCompanyForm({ onCreated, onCancel }) {
  const [name,   setName]   = React.useState("");
  const [error,  setError]  = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError("Enter a company name."); return; }
    setSaving(true);
    setError("");
    createCompany(trimmed)
      .then((result) => {
        if (result.ok) { onCreated(result.company); return; }
        setError(result.message);
      })
      .finally(() => setSaving(false));
  };

  // A dialog over the list. Escape or a click outside closes it.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onCancel]);
  return h("div", { className: "dialogBackdrop", onMouseDown: (e) => { if (e.target === e.currentTarget && !saving) onCancel(); } },
    h("form", { className: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "newCompanyTitle", onSubmit: handleSubmit },
      h("div", { className: "dialog__head" },
        h("h2", { id: "newCompanyTitle", className: "dialog__title" }, "New company"),
        h("button", { type: "button", className: "iconBtn", "aria-label": "Close", onClick: onCancel, disabled: saving }, h(Icon, { name: "close" }))),
      h("p", { className: "muted dialog__sub" }, "It starts in setup, with a join code and no branch. You open its first branch from its page."),
      h("label", { className: "loginLabel", htmlFor: "newCompanyName" }, "Company name"),
      h("input", {
        id: "newCompanyName", className: "loginInput", type: "text", autoFocus: true,
        maxLength: 200, value: name, disabled: saving,
        onChange: (e) => { setName(e.target.value); setError(""); },
      }),
      error && h("div", { className: "loginError", role: "alert", style: { margin: "0 0 16px" } }, error),
      h("div", { className: "dialog__actions" },
        h("button", { type: "button", className: "secondaryBtn", onClick: onCancel, disabled: saving }, "Cancel"),
        h("button", { type: "submit", className: "primaryBtn", disabled: saving }, saving ? "Creating…" : "Create company"))));
}

// The filters above the list, in order. Live, In setup and Paused are where a
// company is in its own setup; Suspended is its status, set here.
const LIST_FILTERS = [
  ["all",       "All",       () => true],
  ["live",      "Live",      (c) => c.status !== "suspended" && setupStateLabel(c) === "Live"],
  ["setup",     "In setup",  (c) => !c.launchedAt],
  ["paused",    "Paused",    (c) => !!c.launchedAt && !!c.pausedAt],
  ["suspended", "Suspended", (c) => c.status === "suspended"],
];

function StatTile({ label, value, active, onClick }) {
  return h("button", { type: "button", className: `statTile${active ? " statTile--on" : ""}`, onClick, "aria-pressed": active },
    h("span", { className: "statTile__value" }, h(CountUp, { value })),
    h("span", { className: "statTile__label" }, label));
}

function CompanyListScreen({ companies, onCreated }) {
  const [creating, setCreating] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [desc, setDesc] = React.useState(false);

  const count = (key) => companies.filter(LIST_FILTERS.find(([k]) => k === key)[2]).length;
  const q = query.trim().toLowerCase();
  const shown = companies
    .filter(LIST_FILTERS.find(([k]) => k === filter)[2])
    .filter((c) => !q || String(c.name).toLowerCase().includes(q) || String(c.planTier || "").toLowerCase().includes(q))
    .slice().sort((x, y) => String(x.name).localeCompare(String(y.name)) * (desc ? -1 : 1));
  const open = (c) => { window.location.hash = `#/company/${encodeURIComponent(c.id)}`; };

  return h(React.Fragment, null,
    h("div", { className: "titleRow" },
      h("div", null,
        h("h1", { className: "pageTitle" }, "Companies"),
        h("p", { className: "muted pageSub" }, `${companies.length} ${companies.length === 1 ? "company" : "companies"} on fleetr`)),
      // The website's motion button: the ink circle grows across on hover.
      h("button", { type: "button", className: "motionBtn", onClick: () => setCreating(true) },
        h("span", { className: "motionBtn__fill", "aria-hidden": "true" }),
        h("span", { className: "motionBtn__icon" }, h(Icon, { name: "plus", size: 18 })),
        h("span", { className: "motionBtn__label" }, "New company"))),

    h("div", { className: "statRow" },
      [["all", "Companies"], ["live", "Live"], ["setup", "In setup"], ["suspended", "Suspended"]].map(([key, label]) =>
        h(StatTile, { key, label, value: count(key), active: filter === key && key !== "all",
          onClick: () => setFilter(filter === key ? "all" : key) }))),

    creating && h(NewCompanyForm, {
      onCreated: (company) => { onCreated(company); setCreating(false); toast(`${company.name} was created.`); open(company); },
      onCancel: () => setCreating(false),
    }),

    h("div", { className: "card listCard" },
      h("div", { className: "toolbar" },
        h("label", { className: "searchBox" },
          h(Icon, { name: "search", size: 16 }),
          h("input", { type: "search", placeholder: "Search companies", value: query, "aria-label": "Search companies",
            onChange: (e) => setQuery(e.target.value) })),
        h("div", { className: "chips", role: "group", "aria-label": "Filter companies" },
          LIST_FILTERS.map(([key, label]) => h("button", {
            key, type: "button", className: `chip${filter === key ? " chip--on" : ""}`, "aria-pressed": filter === key,
            onClick: () => setFilter(key),
          }, label, h("span", { className: "chip__count" }, count(key)))))),
      companies.length === 0
        ? h("div", { className: "emptyState" },
            h("div", { className: "emptyState__icon" }, h(Icon, { name: "companies", size: 22 })),
            h("p", { className: "emptyState__title" }, "No companies yet"),
            h("p", { className: "muted" }, "Create the first one to give it a join code."))
        : shown.length === 0
          ? h("div", { className: "emptyState" },
              h("p", { className: "emptyState__title" }, "No companies match"),
              h("button", { type: "button", className: "secondaryBtn", onClick: () => { setQuery(""); setFilter("all"); } }, "Clear search and filters"))
          : h("div", { className: "tableWrap" },
              h("table", { className: "companyTable" },
                h("thead", null,
                  h("tr", null,
                    h("th", { scope: "col", "aria-sort": desc ? "descending" : "ascending" },
                      h("button", { type: "button", className: "sortBtn", onClick: () => setDesc((d) => !d) },
                        "Company", h(Icon, { name: "sort", size: 13 }))),
                    h("th", { scope: "col" }, "Status"),
                    h("th", { scope: "col" }, "Setup"),
                    h("th", { scope: "col" }, "Plan"),
                    h("th", { scope: "col", "aria-label": "Open" }))),
                h("tbody", null,
                  shown.map((c) => h("tr", { key: c.id, className: "rowLink", onClick: () => open(c) },
                    h("td", null,
                      h("div", { className: "nameCell" },
                        h(Avatar, { name: c.name }),
                        h("a", { className: "companyLink", href: `#/company/${encodeURIComponent(c.id)}`,
                          onClick: (e) => e.stopPropagation() }, c.name))),
                    h("td", null, h(StatusBadge, { status: c.status })),
                    h("td", null, h(SetupBadge, { company: c })),
                    h("td", null, c.planTier || h("span", { className: "muted" }, "Not set")),
                    h("td", { className: "rowChevron" }, h(Icon, { name: "chevron", size: 16 })))))))));
}

// ─── Company detail ───────────────────────────────────────────────────────────
// Every call on this page goes through here. Returns { ok, body } or
// { ok: false, message }. Never throws. As with createCompany, a failure
// carries the Worker's own message when it sent one.
async function adminRequest(path, { method = "GET", body } = {}) {
  const session = supabase.auth.session();
  if (!session) return { ok: false, message: "Your session has ended. Sign in again." };
  let res;
  try {
    res = await fetch(`${ADMIN_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    console.warn(`fleetr hq ${method} ${path} failed:`, e.message || String(e));
    return { ok: false, message: REASONS.network };
  }
  const json = await res.json().catch(() => null);
  if (res.ok && json && json.ok) return { ok: true, body: json };
  console.warn(`fleetr hq ${method} ${path} refused:`, res.status);
  return { ok: false, message: (json && json.message) || `The request failed (${res.status}).`, reason: json && json.reason, refusal: json };
}

// Hardcoded until there is a feature catalogue. A key with no company_features
// row is off, which is what the table's default means too.
const FEATURES = [
  { key: "ai_command_bar",      label: "AI command bar" },
  { key: "insurance_rentals",   label: "Insurance rentals" },
  { key: "non_drive_intake",    label: "Non-drive intake" },
  { key: "pre_rental_check",    label: "Pre-rental check" },
  { key: "unknown_repair_date", label: "Unknown repair date" },
  { key: "no_shows",            label: "No-shows" },
  { key: "reports",             label: "Reports" },
  { key: "audit_log",           label: "Audit log" },
  { key: "fleet_notifications", label: "Notification centre" },
];

// The editable fields, in display order. `nullable` fields are cleared by
// saving them empty, which is sent as null; name cannot be empty.
const DETAIL_FIELDS = [
  { key: "name",         label: "Company name",  type: "text",  maxLength: 200 },
  { key: "status",       label: "Status",        type: "select" },
  { key: "planTier",     label: "Plan tier",     type: "text",  maxLength: 64,  nullable: true },
  { key: "contactName",  label: "Contact name",  type: "text",  maxLength: 200, nullable: true },
  { key: "contactEmail", label: "Contact email", type: "email", maxLength: 254, nullable: true },
  { key: "contactPhone", label: "Contact phone", type: "tel",   maxLength: 32,  nullable: true },
];

const toDraft = (company) =>
  Object.fromEntries(DETAIL_FIELDS.map((f) => [f.key, company[f.key] == null ? "" : String(company[f.key])]));

// Only what differs from the last saved copy, trimmed, with empty nullable
// fields sent as null. An unchanged form produces an empty object.
function changedFields(saved, draft) {
  const out = {};
  for (const f of DETAIL_FIELDS) {
    const next = draft[f.key].trim();
    const prev = saved[f.key] == null ? "" : String(saved[f.key]);
    if (next === prev) continue;
    out[f.key] = next === "" && f.nullable ? null : next;
  }
  return out;
}

function FeatureToggle({ feature, enabled, changed, pending, onToggle }) {
  const id = `feature-${feature.key}`;
  return h("div", { className: "featureRow" },
    h("label", { className: "featureLabel", htmlFor: id }, feature.label),
    h("div", { className: "featureControl" },
      h("span", { className: "featureState" }, `${enabled ? "On" : "Off"}${changed ? " (unsaved)" : ""}`),
      h("button", {
        id, type: "button", role: "switch", "aria-checked": enabled,
        className: `toggle${enabled ? " toggleOn" : ""}`, disabled: pending,
        onClick: onToggle,
      }, h("span", { className: "toggleKnob" }))));
}

// The setup steps company_setup_status returns, in its order, as the
// company's Exec sees them on the Company page in fleetr. detail is what is
// still missing.
const SETUP_ITEMS = {
  branch:                "Branch: address, map pin and sales tax",
  fuel_rate:             "Post-pay fuel rate",
  vehicle_classes:       "Vehicle classes",
  rates:                 "A daily rate for every vehicle class",
  vehicles:              "A vehicle at the default branch",
  protection:            "Protection and deductibles",
  contract:              "Contract terms",
  revenue_share:         "Revenue share, set by fleetr",
  listing:               "fleetr.ai listing",
  staff:                 "Staff besides the Exec",
  test_rentals_finished: "Test rentals finished",
};
// Why an item that is not done is not done, from its detail.
function setupReason(item) {
  const list = Array.isArray(item.detail) ? item.detail : [];
  if (item.skipped) return "Skipped for now.";
  switch (item.key) {
    case "branch":            return list.length ? `No full address, map pin or confirmed sales tax: ${list.join(", ")}.` : "No open branch.";
    case "fuel_rate":         return "Not set.";
    case "vehicle_classes":   return "None added.";
    case "rates":             return list.length ? `No rate for: ${list.join(", ")}.` : "No vehicle classes yet.";
    case "vehicles":          return "No vehicle with one of the company's classes at its default branch.";
    case "protection":        return list.length ? `Missing a price or decline wording: ${list.join(", ")}.` : "None added.";
    case "contract":          return "Not saved yet.";
    case "revenue_share":     return "Not set. Set it on this company's Billing tab.";
    case "listing":           return list.length ? `Incomplete: ${list.join(", ")}.` : "No branch is listed.";
    case "staff":             return "Only the Exec so far.";
    case "test_rentals_finished": return `Still open: ${list.join(", ")}.`;
    default:                  return "";
  }
}

// One step, as a row of the website's timeline: a round node, done or not,
// joined to the next by a line.
function SetupItem({ item }) {
  const state = item.done ? "done" : item.skipped ? "skipped" : "left";
  return h("li", { className: `step step--${state}` },
    h("span", { className: "step__node", "aria-hidden": "true" },
      item.done ? h(Icon, { name: "check", size: 14 }) : item.skipped ? h(Icon, { name: "dash", size: 14 }) : null),
    h("div", { className: "step__body" },
      h("div", { className: "step__title" }, SETUP_ITEMS[item.key] || item.key,
        h("span", { className: "step__state" }, item.done ? "Done" : item.skipped ? "Skipped" : "Left to do")),
      !item.done && h("div", { className: "muted step__why" }, setupReason(item))));
}

// Read only. HQ sees the company's progress; only its Exec can launch,
// pause or resume it, from fleetr.
function SetupProgress({ id }) {
  const [state, setState] = React.useState(undefined);   // undefined loading, { error } or { setup }
  React.useEffect(() => {
    let live = true;
    setState(undefined);
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/setup`).then((r) => {
      if (!live) return;
      setState(r.ok ? { setup: r.body.setup } : { error: r.message });
    });
    return () => { live = false; };
  }, [id]);

  const body = () => {
    if (state === undefined) return h(Skeleton, { lines: 4 });
    if (state.error) return h("div", { className: "loginError", role: "alert" }, state.error);
    const s = state.setup;
    const required = s.items.filter((i) => i.required);
    const optional = s.items.filter((i) => !i.required);
    const left = required.filter((i) => !i.done).length;
    const where = !s.launched
      ? `In setup. ${left === 0 ? "Every required item is done; waiting for the Exec to launch." : `${left} of ${required.length} required items left.`}`
      : s.suspended ? "Launched, and suspended here: hidden from fleetr.ai with no online bookings until the status is changed back. Texts for existing bookings still go."
      : s.paused ? "Launched, and paused by its Exec: hidden from fleetr.ai with no online bookings. Texts for existing bookings still go."
      : "Launched and live.";
    const doneCount = required.length - left;
    const pct = required.length ? Math.round((doneCount / required.length) * 100) : 100;
    return h(React.Fragment, null,
      h("div", { className: "progress" },
        h("div", { className: "progress__top" },
          h("span", { className: "progress__count" }, `${doneCount} of ${required.length} required done`),
          h("span", { className: "progress__pct" }, `${pct}%`)),
        h("div", { className: "progress__bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct, "aria-label": "Setup progress" },
          h("span", { style: { width: `${pct}%` } }))),
      h("p", { className: "setupWhere" }, where),
      h("h3", { className: "setupHeading" }, "Required before launch"),
      h("ul", { className: "steps" }, required.map((i) => h(SetupItem, { key: i.key, item: i }))),
      optional.length > 0 && h("h3", { className: "setupHeading" }, "Optional"),
      optional.length > 0 && h("ul", { className: "steps" }, optional.map((i) => h(SetupItem, { key: i.key, item: i }))));
  };

  return h("section", { className: "detailSection" },
    h("h2", { className: "sectionTitle" }, "Setup"),
    body());
}

// A company made here has no branch, so its join code works for nobody until
// HQ opens the first one. After that its Exec opens any more from fleetr.
function FirstBranchForm({ id, onOpened }) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err,  setErr]  = React.useState("");

  const submit = (e) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm) { setErr("Enter a branch name."); return; }
    if (!window.confirm(`Open ${nm} as this company's first branch? People who sign up with the join code will join it.`)) return;
    setBusy(true);
    setErr("");
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/branch`, { method: "POST", body: { name: nm } })
      .then((r) => { if (r.ok) onOpened(); else setErr(r.message); })
      .finally(() => setBusy(false));
  };

  return h("form", { className: "newCompany", onSubmit: submit, noValidate: true },
    h("p", { style: { marginTop: 0 } },
      "This company has no branch yet, so nobody can sign up with its join code. Open its first branch here. Its Exec sets the rest of it up in fleetr."),
    h("div", { className: "detailGrid" },
      h("div", { className: "detailField" },
        h("label", { className: "loginLabel", htmlFor: "branch-name" }, "Branch name"),
        h("input", { id: "branch-name", className: "loginInput", maxLength: 60, value: name, disabled: busy,
          onChange: (e) => { setName(e.target.value); setErr(""); } }))),
    h("div", { className: "saveRow" },
      h("button", { type: "submit", className: "primaryBtn", disabled: busy }, busy ? "Opening…" : "Open first branch")),
    err && h("div", { className: "loginError", role: "alert" }, err));
}

const signedUpOn = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

// Read only, apart from approving or declining a pending sign-up. HQ approves
// only the company's first Exec; once it has one, the Exec approves the rest.
function CompanyStaff({ id, company, onChanged }) {
  const [state, setState] = React.useState(undefined);   // undefined loading, { error } or { staff, branches }
  const [busyId, setBusyId] = React.useState(null);
  const [actErr, setActErr] = React.useState("");
  const [actMsg, setActMsg] = React.useState("");
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/staff`).then((r) => {
      if (!live) return;
      setState(r.ok ? { staff: r.body.staff, branches: r.body.branches } : { error: r.message });
    });
    return () => { live = false; };
  }, [id, reload]);

  const refresh = () => { setReload((n) => n + 1); onChanged(); };

  const act = (person, approve) => {
    const who = `${person.name} (${person.username})`;
    const contact = [company.contactName, company.contactEmail].filter(Boolean).join(", ");
    const msg = approve
      ? `Approve ${who} as ${company.name}'s Exec? They will be able to run the whole company in fleetr and approve its staff.`
        + (contact ? ` The company contact on record is ${contact}.` : " This company has no contact on record to check them against.")
      : `Decline ${who}? Their account is removed and they cannot sign in.`;
    if (!window.confirm(msg)) return;
    setBusyId(person.id);
    setActErr("");
    setActMsg("");
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/signups/${encodeURIComponent(person.id)}`,
      { method: approve ? "POST" : "DELETE" })
      .then((r) => {
        if (!r.ok) { setActErr(r.message); return; }
        const done = approve ? `${person.name} is now the Exec.`
          : r.body.removed ? `${person.name}'s sign-up was declined.`
          : `${person.name}'s sign-up was declined. Their account is kept, deactivated, because records point at it.`;
        setActMsg(done);
        toast(done);
        refresh();
      })
      .finally(() => setBusyId(null));
  };

  const body = () => {
    if (state === undefined) return h(Skeleton, { lines: 3 });
    if (state.error) return h("div", { className: "loginError", role: "alert" }, state.error);
    const { staff, branches } = state;
    const branchName = (s) => (s.role === "Exec" ? "All branches"
      : (branches.find((b) => b.id === s.locationId) || { name: "" }).name);
    const hasExec = staff.some((s) => s.role === "Exec" && s.active);
    return h(React.Fragment, null,
      branches.length === 0 && h(FirstBranchForm, { id, onOpened: refresh }),
      staff.length === 0
        ? h("p", { className: "muted" }, branches.length === 0 ? "No staff yet." : "No staff yet. The first person to sign up with the join code appears here.")
        : h("div", { className: "tableWrap" },
            h("table", { className: "companyTable" },
              h("thead", null,
                h("tr", null,
                  ["Name", "Email", "Role", "Branch", "Status", "Signed up", ""].map((c, i) =>
                    h("th", { key: i, scope: "col" }, c)))),
              h("tbody", null,
                staff.map((s) => {
                  const pending = !!s.pendingApprovalSince;
                  return h("tr", { key: s.id },
                    h("td", null, h("div", { className: "nameCell" }, h(Avatar, { name: s.name }),
                      h("div", null, s.name, h("div", { className: "muted small" }, s.username)))),
                    h("td", null, s.recoveryEmail || h("span", { className: "muted" }, "None")),
                    h("td", null, s.role),
                    h("td", null, branchName(s)),
                    h("td", null, h("span", { className: `pill pill--${pending ? "paused" : s.active ? "live" : "setup"}` },
                      pending ? "Pending" : s.active ? "Approved" : "Deactivated")),
                    h("td", null, signedUpOn(s.createdAt)),
                    h("td", null, pending && h("div", { className: "staffActions" },
                      !hasExec && h("button", { type: "button", className: "linkBtn", disabled: busyId !== null,
                        onClick: () => act(s, true) }, busyId === s.id ? "Working…" : "Approve as Exec"),
                      h("button", { type: "button", className: "linkBtn", disabled: busyId !== null,
                        onClick: () => act(s, false) }, "Decline"))));
                })))),
      hasExec && staff.some((s) => s.pendingApprovalSince) && h("p", { className: "muted" },
        "This company has an Exec, who approves pending staff from fleetr. HQ can still decline a sign-up here."),
      actMsg && h("div", { className: "successMsg", role: "status" }, actMsg),
      actErr && h("div", { className: "loginError", role: "alert" }, actErr));
  };

  return h("section", { className: "detailSection" },
    h("h2", { className: "sectionTitle" }, "Staff"),
    body());
}

// ─── Deleting a company ───────────────────────────────────────────────────────
// What the confirm box counts, in words. Everything else is "other records".
const DELETE_COUNT_WORDS = [
  ["users",             "staff member and their sign-in", "staff members and their sign-ins"],
  ["locations",         "branch", "branches"],
  ["reservations",      "reservation", "reservations"],
  ["rental_agreements", "rental agreement", "rental agreements"],
  ["fleet",             "vehicle", "vehicles"],
  ["damage_claims",     "damage claim", "damage claims"],
];
const countWords = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
function deletionLines(counts, files) {
  const c = counts || {};
  const lines = DELETE_COUNT_WORDS.filter(([k]) => c[k] > 0).map(([k, one, many]) => countWords(c[k], one, many));
  const named = new Set(DELETE_COUNT_WORDS.map(([k]) => k));
  const other = Object.entries(c).filter(([k]) => !named.has(k)).reduce((sum, [, n]) => sum + n, 0);
  if (other > 0) lines.push(countWords(other, "other record", "other records"));
  if (files > 0) lines.push(countWords(files, "photo or logo file", "photo and logo files"));
  return lines;
}

// Only a company in setup mode (never launched) or suspended can be deleted.
// The database refuses any other; this box only says so first.
const DELETE_BLOCKED = {
  live: "This company is live. A company can be deleted only in setup mode or once it is suspended. Set its status to Suspended under Details first.",
  platform_admin: "One of this company's staff is a platform admin. Remove them from platform admins first.",
};

function DeleteCompany({ id, company, onDeleted }) {
  const [open,    setOpen]    = React.useState(false);
  const [preview, setPreview] = React.useState(undefined);   // undefined loading, { error } or the preview
  const [typed,   setTyped]   = React.useState("");
  const [busy,    setBusy]    = React.useState(false);
  const [err,     setErr]     = React.useState("");

  React.useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setPreview(undefined);
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/deletion`).then((r) => {
      if (live) setPreview(r.ok ? r.body : { error: r.message });
    });
    return () => { live = false; };
  }, [open, id, company.status]);

  const close = () => { setOpen(false); setTyped(""); setErr(""); };
  const blocked = preview && !preview.error && preview.blocked;
  const ready = preview && !preview.error && !blocked && typed.trim() === company.name && !busy;

  const remove = () => {
    if (!ready) return;
    setBusy(true);
    setErr("");
    adminRequest(`/admin/companies/${encodeURIComponent(id)}`, { method: "DELETE", body: { name: typed } })
      .then((r) => {
        if (!r.ok) { setErr(r.message); return; }
        if (r.body.filesLeft) {
          window.alert(`${company.name} was deleted, but ${r.body.filesLeft} files could not be removed. Delete it again from the same address to remove them.`);
        }
        onDeleted(id);
      })
      .finally(() => setBusy(false));
  };

  return h("section", { className: "detailSection" },
    h("h2", { className: "sectionTitle" }, "Danger zone"),
    !open
      ? h("div", { className: "saveRow" },
          h("button", { type: "button", className: "dangerBtn", onClick: () => setOpen(true) }, "Delete company"),
          h("span", { className: "muted" }, "Deletes the company and everything tied to it. This cannot be undone."))
      : h("div", { className: "deleteBox" },
          h("p", { className: "deleteTitle" }, `Delete ${company.name}?`),
          preview === undefined && h("p", { className: "muted" }, "Checking what would be deleted…"),
          preview && preview.error && h("div", { className: "loginError", role: "alert" }, preview.error),
          preview && !preview.error && h(React.Fragment, null,
            h("p", null, "This deletes the company and everything tied to it, for good:"),
            h("ul", { className: "deleteList" },
              deletionLines(preview.counts, preview.files).map((line) => h("li", { key: line }, line)),
              h("li", null, "its settings, rates, texts, contract wording and audit log")),
            blocked && h("div", { className: "loginError", role: "alert" }, DELETE_BLOCKED[blocked] || "This company cannot be deleted right now.")),
          h("label", { className: "loginLabel", htmlFor: "delete-name" }, `Type ${company.name} to confirm`),
          h("input", { id: "delete-name", className: "loginInput", type: "text", autoComplete: "off", value: typed,
            disabled: busy || !!blocked, onChange: (e) => { setTyped(e.target.value); setErr(""); } }),
          h("div", { className: "saveRow" },
            h("button", { type: "button", className: "dangerBtn", disabled: !ready, onClick: remove },
              busy ? "Deleting…" : "Delete company"),
            h("button", { type: "button", className: "linkBtn", disabled: busy, onClick: close }, "Cancel")),
          err && h("div", { className: "loginError", role: "alert" }, err)));
}

function CompanyDetailScreen({ id, onUpdated, onDeleted }) {
  // undefined while loading; { error } when the load failed.
  const [loaded,   setLoaded]   = React.useState(undefined);
  const [draft,    setDraft]    = React.useState(null);
  const [saving,   setSaving]   = React.useState(false);
  const [saveMsg,  setSaveMsg]  = React.useState(null);   // { ok, text }
  const [features, setFeatures] = React.useState({});
  // Flipped but not saved yet: featureKey -> the value it will be saved as.
  const [featDraft, setFeatDraft] = React.useState({});
  const [featSaving, setFeatSaving] = React.useState(false);
  const [featErr,  setFeatErr]  = React.useState("");
  const [featMsg,  setFeatMsg]  = React.useState("");
  // Bumped when a staff or branch change could move the setup checklist.
  const [setupKey, setSetupKey] = React.useState(0);
  const [tab, setTab] = React.useState("setup");
  const unsaved = Object.keys(featDraft).length;

  // Warn before leaving with unsaved feature changes: closing or reloading
  // the tab, and moving to another screen in this app.
  React.useEffect(() => {
    if (!unsaved) return undefined;
    const msg = `You have ${unsaved} unsaved feature ${unsaved === 1 ? "change" : "changes"}. Leave without saving?`;
    leaveGuard = () => msg;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = msg; return msg; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { leaveGuard = null; window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [unsaved]);

  React.useEffect(() => {
    let live = true;
    setLoaded(undefined);
    setSaveMsg(null);
    setFeatErr("");
    setFeatMsg("");
    setFeatDraft({});
    adminRequest(`/admin/companies/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (!r.ok) { setLoaded({ error: r.message }); return; }
      setLoaded({ company: r.body.company });
      setDraft(toDraft(r.body.company));
      setFeatures(Object.fromEntries((r.body.features || []).map((f) => [f.featureKey, f.enabled === true])));
    });
    return () => { live = false; };
  }, [id]);

  const back = h("nav", { className: "crumbs", "aria-label": "Breadcrumb" },
    h("a", { href: "#/" }, "Companies"), h(Icon, { name: "chevron", size: 14 }),
    h("span", { "aria-current": "page" }, loaded && loaded.company ? loaded.company.name : "Company"));
  if (loaded === undefined) return h(React.Fragment, null, back, h("div", { className: "card" }, h(Skeleton, { lines: 2 })), h("div", { className: "card" }, h(Skeleton, { lines: 5 })));
  if (loaded.error) {
    return h(React.Fragment, null, back,
      h("h1", { className: "pageTitle" }, "Company"),
      h("div", { className: "loginError", role: "alert" }, loaded.error));
  }

  const company = loaded.company;
  const changes = changedFields(company, draft);
  const dirty = Object.keys(changes).length > 0;

  const edit = (key) => (e) => {
    setDraft({ ...draft, [key]: e.target.value });
    setSaveMsg(null);
  };

  const save = (e) => {
    e.preventDefault();
    if (!dirty) return;
    if ("name" in changes && !changes.name) {
      setSaveMsg({ ok: false, text: "Enter a company name." });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    adminRequest(`/admin/companies/${encodeURIComponent(id)}`, { method: "PATCH", body: changes })
      .then((r) => {
        if (!r.ok) { setSaveMsg({ ok: false, text: r.message }); return; }
        // The Worker returns the whole row after the update, so what is shown
        // is what was stored, not what was typed.
        setLoaded({ company: r.body.company });
        setDraft(toDraft(r.body.company));
        setSaveMsg(null);
        toast("Details saved.");
        onUpdated(r.body.company);
      })
      .finally(() => setSaving(false));
  };

  // Flipping only changes the draft. Flipping back to the saved value drops
  // it from the draft, so it no longer counts as a change.
  const shownFeature = (key) => (key in featDraft ? featDraft[key] : features[key] === true);
  const toggle = (key) => {
    const next = !shownFeature(key);
    setFeatDraft((d) => {
      const out = { ...d };
      if (next === (features[key] === true)) delete out[key]; else out[key] = next;
      return out;
    });
    setFeatErr("");
    setFeatMsg("");
  };

  // Saves every flipped toggle. Each is its own request; the ones that fail
  // stay in the draft, flipped, so nothing is silently lost.
  const saveFeatures = () => {
    const keys = Object.keys(featDraft);
    if (!keys.length) return;
    setFeatSaving(true);
    setFeatErr("");
    setFeatMsg("");
    Promise.all(keys.map((key) =>
      adminRequest(`/admin/companies/${encodeURIComponent(id)}/features/${encodeURIComponent(key)}`,
        { method: "PUT", body: { enabled: featDraft[key] } }).then((r) => ({ key, r }))))
      .then((results) => {
        const saved = results.filter((x) => x.r.ok);
        const failed = results.filter((x) => !x.r.ok);
        // The switches show what the Worker stored, not what was requested.
        setFeatures((f) => {
          const out = { ...f };
          saved.forEach(({ key, r }) => { out[key] = !!(r.body.feature && r.body.feature.enabled === true); });
          return out;
        });
        setFeatDraft((d) => {
          const out = { ...d };
          saved.forEach(({ key }) => { delete out[key]; });
          return out;
        });
        if (failed.length) {
          const names = failed.map(({ key }) => (FEATURES.find((f) => f.key === key) || { label: key }).label);
          setFeatErr(`Not saved: ${names.join(", ")}. ${failed[0].r.message}`);
        } else {
          toast(`Saved ${saved.length} feature ${saved.length === 1 ? "change" : "changes"}.`);
        }
      })
      .finally(() => setFeatSaving(false));
  };

  const field = (f) => h("div", { key: f.key, className: "detailField" },
    h("label", { className: "loginLabel", htmlFor: `field-${f.key}` }, f.label),
    f.type === "select"
      ? h("select", {
          id: `field-${f.key}`, className: "loginInput", value: draft[f.key],
          disabled: saving, onChange: edit(f.key),
        }, Object.keys(STATUS_LABELS).map((s) => h("option", { key: s, value: s }, STATUS_LABELS[s])))
      : h("input", {
          id: `field-${f.key}`, className: "loginInput", type: f.type, maxLength: f.maxLength,
          value: draft[f.key], disabled: saving, onChange: edit(f.key),
        }));

  const copyCode = () => {
    if (!company.joinCode || !navigator.clipboard) return;
    navigator.clipboard.writeText(company.joinCode).then(() => toast("Join code copied."), () => {});
  };
  const contact = [company.contactName, company.contactEmail, company.contactPhone].filter(Boolean).join(" · ");
  const TABS = [["setup", "Setup"], ["details", "Details"], ["staff", "Staff"], ["features", "Features"], ["billing", "Billing"], ["danger", "Danger zone"]];

  return h(React.Fragment, null,
    back,
    h("div", { className: "card hero" },
      h(Avatar, { name: company.name, size: "lg" }),
      h("div", { className: "hero__main" },
        h("h1", { className: "pageTitle hero__name" }, company.name),
        h("div", { className: "hero__badges" },
          h(StatusBadge, { status: company.status }), h(SetupBadge, { company }),
          company.planTier && h("span", { className: "pill pill--setup" }, company.planTier)),
        h("div", { className: "muted hero__contact" }, contact || "No contact on record")),
      h("div", { className: "hero__code" },
        h("span", { className: "hero__codeLabel" }, "Join code"),
        h("div", { className: "codeChip" },
          h("span", null, company.joinCode || "None"),
          company.joinCode && h("button", { type: "button", className: "iconBtn", "aria-label": "Copy join code", title: "Copy", onClick: copyCode },
            h(Icon, { name: "copy", size: 15 }))))),

    h("div", { className: "tabs", role: "tablist", "aria-label": "Company" },
      TABS.map(([key, label]) => h("button", {
        key, type: "button", role: "tab", "aria-selected": tab === key, className: `tab${tab === key ? " tab--on" : ""}${key === "danger" ? " tab--danger" : ""}`,
        onClick: () => setTab(key),
      }, label, key === "features" && unsaved > 0 && h("span", { className: "tab__dot", "aria-label": "unsaved changes" })))),

    tab === "details" && h("section", { className: "detailSection" },
      h("h2", { className: "sectionTitle" }, "Details"),
      h("form", { onSubmit: save, noValidate: true },
        h("div", { className: "detailGrid" }, DETAIL_FIELDS.map(field)),
        h("div", { className: "saveRow" },
          h("button", { type: "submit", className: "primaryBtn", disabled: saving || !dirty },
            saving ? "Saving…" : "Save"),
          !dirty && !saveMsg && h("span", { className: "muted" }, "No changes")),
        saveMsg && h("div", { className: saveMsg.ok ? "successMsg" : "loginError", role: "status" }, saveMsg.text))),

    tab === "setup" && h(SetupProgress, { key: setupKey, id }),

    tab === "staff" && h(CompanyStaff, { id, company, onChanged: () => setSetupKey((n) => n + 1) }),

    tab === "features" && h("section", { className: "detailSection" },
      h("h2", { className: "sectionTitle" }, "Features"),
      h("p", { className: "muted sectionSub" }, "Parts of fleetr this company can use. Flip any, then save them together."),
      FEATURES.map((f) => h(FeatureToggle, {
        key: f.key, feature: f, enabled: shownFeature(f.key), changed: f.key in featDraft,
        pending: featSaving, onToggle: () => toggle(f.key),
      })),
      h("div", { className: "saveRow", style: { marginTop: "16px" } },
        h("button", { type: "button", className: "primaryBtn", disabled: featSaving || !unsaved, onClick: saveFeatures },
          featSaving ? "Saving…" : "Save changes"),
        h("span", { className: "muted", role: "status" },
          unsaved ? `${unsaved} unsaved ${unsaved === 1 ? "change" : "changes"}` : "No changes"),
        unsaved > 0 && h("button", {
          type: "button", className: "linkBtn", disabled: featSaving,
          onClick: () => { setFeatDraft({}); setFeatErr(""); setFeatMsg(""); },
        }, "Discard")),
      featMsg && h("div", { className: "successMsg", role: "status" }, featMsg),
      featErr && h("div", { className: "loginError", role: "alert" }, featErr)),

    tab === "billing" && h(RevenueShare, { id, onChanged: () => setSetupKey((n) => n + 1) }),

    tab === "danger" && h(DeleteCompany, { id, company, onDeleted }));
}

// ─── Billing ──────────────────────────────────────────────────────────────────
// Revenue share billing (revenue_share.sql, through the reset worker). Money
// is in dollars and cents; months are YYYY-MM, each agreement's in its own
// branch's time.
const money = (n) => `$${Number(n || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m) => { const [y, mo] = String(m).split("-").map(Number); return y && mo ? `${MONTHS_LONG[mo - 1]} ${y}` : m; };
const shortMonth = (m) => { const [y, mo] = String(m).split("-").map(Number); return y && mo ? `${MONTHS_LONG[mo - 1].slice(0, 3)} ${String(y).slice(2)}` : m; };
// This month in Newfoundland, fleetr's calendar, and the one before it.
const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/St_Johns", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const monthBefore = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; };
const percentList = (list) => (Array.isArray(list) && list.length ? list.map((x) => `${Number(x)}%`).join(", ") : "Not set");
const BILLING_REASONS = {
  bad_percent: "Enter a % from 1 to 10, to two decimal places at most.",
  month_not_ended: "That month has not ended yet. It can be marked paid once it has.",
  already_paid: "That month is already marked paid.",
  bad_date: "Enter the date it was paid, today or earlier.",
  bad_note: "Keep the note to 500 characters.",
  number_required: "Enter fleetr's HST number to switch HST on.",
  bad_number: "Keep the HST number to 40 characters.",
  bad_rate: "Enter an HST rate from 0 to 30.",
  not_found: "That company was not found.",
};
const billingRefusal = (r) => BILLING_REASONS[r.reason] || r.message;

// A company's revenue share: the % now, a new one from now on, and every
// one it has had. Never applies to agreements already closed.
function RevenueShare({ id, onChanged }) {
  const [history, setHistory] = React.useState(undefined);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const load = () => adminRequest(`/admin/companies/${encodeURIComponent(id)}/revenue-share`).then((r) => {
    setHistory(r.ok ? r.body.history || [] : { error: r.message });
  });
  React.useEffect(() => { load(); }, [id]);
  const save = (e) => {
    e.preventDefault();
    const percent = Number(draft);
    if (!draft.trim() || !Number.isFinite(percent)) { setMsg({ ok: false, text: BILLING_REASONS.bad_percent }); return; }
    setBusy(true); setMsg(null);
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/revenue-share`, { method: "PUT", body: { percent } }).then((r) => {
      setBusy(false);
      if (!r.ok) { setMsg({ ok: false, text: billingRefusal(r) }); return; }
      setDraft("");
      toast(`Revenue share set to ${percent}% for agreements closing from now on.`);
      load(); onChanged && onChanged();
    });
  };
  if (history === undefined) return h("div", { className: "card" }, h(Skeleton, { lines: 3 }));
  if (history.error) return h("div", { className: "loginError", role: "alert" }, history.error);
  const now = history[0];
  return h("section", { className: "detailSection" },
    h("h2", { className: "sectionTitle" }, "Revenue share"),
    h("p", { className: "muted sectionSub" },
      now ? `${Number(now.percent)}% of vehicle rental revenue on agreements closed since ${new Date(now.effectiveFrom).toLocaleString("en-CA")}.`
          : "Not set. The company cannot launch until it is."),
    h("form", { onSubmit: save, noValidate: true, className: "saveRow" },
      h("input", { className: "loginInput", style: { maxWidth: "120px" }, inputMode: "decimal", placeholder: "1 to 10",
        "aria-label": "Revenue share %", value: draft, disabled: busy, onChange: (e) => { setDraft(e.target.value); setMsg(null); } }),
      h("span", { className: "muted" }, "%"),
      h("button", { type: "submit", className: "primaryBtn", disabled: busy || !draft.trim() }, busy ? "Saving…" : now ? "Change from now on" : "Set")),
    msg && h("div", { className: msg.ok ? "successMsg" : "loginError", role: "status" }, msg.text),
    history.length > 0 && h("table", { className: "companyTable", style: { marginTop: "16px" } },
      h("thead", null, h("tr", null, h("th", null, "%"), h("th", null, "From"), h("th", null, "Set by"))),
      h("tbody", null, history.map((x, i) => h("tr", { key: i },
        h("td", null, `${Number(x.percent)}%`), h("td", null, new Date(x.effectiveFrom).toLocaleString("en-CA")), h("td", null, x.setBy || ""))))));
}

const csvCell = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function downloadCsv(name, rows) {
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// fleetr's HST on statements: off until switched on, with fleetr's number.
function HstSettings() {
  const [s, setS] = React.useState(undefined);
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  React.useEffect(() => {
    adminRequest("/admin/billing/settings").then((r) => {
      if (!r.ok) { setS({ error: r.message }); return; }
      setS(r.body.settings);
      setDraft({ hstOn: !!r.body.settings.hstOn, hstNumber: r.body.settings.hstNumber || "", hstRate: String(r.body.settings.hstRate ?? 15) });
    });
  }, []);
  if (s === undefined) return h("div", { className: "card" }, h(Skeleton, { lines: 2 }));
  if (s.error) return h("div", { className: "loginError", role: "alert" }, s.error);
  const save = (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    adminRequest("/admin/billing/settings", { method: "PUT", body: { hstOn: draft.hstOn, hstNumber: draft.hstNumber || null, hstRate: Number(draft.hstRate) } })
      .then((r) => {
        setBusy(false);
        if (!r.ok) { setMsg({ ok: false, text: billingRefusal(r) }); return; }
        setS(r.body.settings);
        toast(draft.hstOn ? "HST is on for statements." : "HST is off for statements.");
      });
  };
  return h("section", { className: "detailSection" },
    h("h2", { className: "sectionTitle" }, "HST on statements"),
    h("p", { className: "muted sectionSub" }, `Statements are issued by ${s.legalName}. HST is added to the amount owed only while it is on.`),
    h("form", { onSubmit: save, noValidate: true },
      h("label", { style: { display: "inline-flex", gap: "8px", alignItems: "center", marginBottom: "12px" } },
        h("input", { type: "checkbox", checked: draft.hstOn, disabled: busy, onChange: (e) => setDraft({ ...draft, hstOn: e.target.checked }) }),
        "Show an HST line on statements"),
      h("div", { className: "detailGrid" },
        h("div", { className: "detailField" },
          h("label", { className: "loginLabel", htmlFor: "hst-number" }, "fleetr's HST number"),
          h("input", { id: "hst-number", className: "loginInput", maxLength: 40, value: draft.hstNumber, disabled: busy,
            onChange: (e) => setDraft({ ...draft, hstNumber: e.target.value }) })),
        h("div", { className: "detailField" },
          h("label", { className: "loginLabel", htmlFor: "hst-rate" }, "HST rate (%)"),
          h("input", { id: "hst-rate", className: "loginInput", inputMode: "decimal", value: draft.hstRate, disabled: busy,
            onChange: (e) => setDraft({ ...draft, hstRate: e.target.value }) }))),
      h("div", { className: "saveRow" }, h("button", { type: "submit", className: "primaryBtn", disabled: busy }, busy ? "Saving…" : "Save")),
      msg && h("div", { className: msg.ok ? "successMsg" : "loginError", role: "status" }, msg.text)));
}

// A month's billing: each company's rentals closed, revenue, %, amount owed
// and status. Last month by default, the one most likely to be billed.
function BillingScreen() {
  const [month, setMonth] = React.useState(monthBefore(thisMonth()));
  const [data, setData] = React.useState(undefined);
  React.useEffect(() => {
    let live = true;
    setData(undefined);
    adminRequest(`/admin/billing?month=${month}`).then((r) => { if (live) setData(r.ok ? r.body : { error: r.message }); });
    return () => { live = false; };
  }, [month]);
  const rows = data && !data.error ? data.companies : [];
  const totals = rows.reduce((t, c) => ({ rentals: t.rentals + Number(c.rentals), revenue: t.revenue + Number(c.revenue), owed: t.owed + Number(c.owed) }),
    { rentals: 0, revenue: 0, owed: 0 });
  const exportCsv = () => downloadCsv(`fleetr-billing-${month}.csv`, [
    ["Company", "Month", "Rentals closed", "Revenue", "Revenue share", "Amount owed", "Status", "Paid on", "Due", "Note"],
    ...rows.map((c) => [c.company, month, c.rentals, Number(c.revenue).toFixed(2), percentList(c.percents), Number(c.owed).toFixed(2),
      c.status === "paid" ? "Paid" : "Unpaid", c.paidOn || "", c.dueDate, c.note || ""]),
  ]);
  return h(React.Fragment, null,
    h("h1", { className: "pageTitle" }, "Billing"),
    h("div", { className: "saveRow", style: { marginBottom: "16px" } },
      h("label", { className: "loginLabel", htmlFor: "billing-month", style: { margin: 0 } }, "Month"),
      h("input", { id: "billing-month", type: "month", className: "loginInput", style: { maxWidth: "200px" }, value: month, max: thisMonth(),
        onChange: (e) => e.target.value && setMonth(e.target.value) }),
      h("button", { type: "button", className: "linkBtn", disabled: !rows.length, onClick: exportCsv }, "Export CSV")),
    data === undefined ? h("div", { className: "card" }, h(Skeleton, { lines: 4 }))
    : data.error ? h("div", { className: "loginError", role: "alert" }, data.error)
    : h("div", { className: "card" },
        h("p", { className: "muted", style: { marginTop: 0 } }, `${monthLabel(month)}. Due ${data.dueDate}.`),
        h("table", { className: "companyTable" },
          h("thead", null, h("tr", null, ["Company", "Rentals closed", "Revenue", "%", "Amount owed", "Status"].map((x) => h("th", { key: x }, x)))),
          h("tbody", null,
            rows.map((c) => h("tr", { key: c.operatorId, style: { cursor: "pointer" },
              onClick: () => { window.location.hash = `#/billing/${encodeURIComponent(c.operatorId)}/${month}`; } },
              h("td", null, h("a", { href: `#/billing/${encodeURIComponent(c.operatorId)}/${month}` }, c.company)),
              h("td", null, c.rentals), h("td", null, money(c.revenue)), h("td", null, percentList(c.percents)),
              h("td", null, money(c.owed)),
              h("td", null, h("span", { className: `pill pill--${c.status === "paid" ? "live" : "setup"}` }, c.status === "paid" ? `Paid ${c.paidOn}` : "Unpaid")))),
            rows.length > 0 && h("tr", null, h("td", null, h("b", null, "Total")), h("td", null, totals.rentals),
              h("td", null, money(totals.revenue)), h("td", null), h("td", null, h("b", null, money(totals.owed))), h("td", null)))),
        !rows.length && h("p", { className: "muted" }, "No company was billed this month.")),
    h(HstSettings));
}

// One company's month: the agreements behind it, and marking it paid.
function BillingCompanyScreen({ id, month }) {
  const [data, setData] = React.useState(undefined);
  const [paidOn, setPaidOn] = React.useState(new Intl.DateTimeFormat("en-CA", { timeZone: "America/St_Johns" }).format(new Date()));
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const load = () => adminRequest(`/admin/billing/${encodeURIComponent(id)}?month=${month}`).then((r) => setData(r.ok ? r.body : { error: r.message }));
  React.useEffect(() => { load(); }, [id, month]);
  const back = h("nav", { className: "crumbs", "aria-label": "Breadcrumb" },
    h("a", { href: "#/billing" }, "Billing"), h(Icon, { name: "chevron", size: 14 }),
    h("span", { "aria-current": "page" }, data && data.summary ? `${data.summary.company}, ${monthLabel(month)}` : monthLabel(month)));
  if (data === undefined) return h(React.Fragment, null, back, h("div", { className: "card" }, h(Skeleton, { lines: 5 })));
  if (data.error) return h(React.Fragment, null, back, h("div", { className: "loginError", role: "alert" }, data.error));
  const sm = data.summary;
  const markPaid = (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    adminRequest(`/admin/billing/${encodeURIComponent(id)}/paid`, { method: "POST", body: { month, paidOn, note: note.trim() || null } }).then((r) => {
      setBusy(false);
      if (!r.ok) { setMsg({ ok: false, text: billingRefusal(r) }); return; }
      toast(`${sm.company}, ${monthLabel(month)} marked paid.`);
      load();
    });
  };
  return h(React.Fragment, null, back,
    h("h1", { className: "pageTitle" }, `${sm.company}, ${monthLabel(month)}`),
    h("div", { className: "card" },
      h("p", { style: { marginTop: 0 } },
        `${sm.rentals} rental${Number(sm.rentals) === 1 ? "" : "s"} closed, ${money(sm.revenue)} revenue at ${percentList(sm.percents)}: `,
        h("b", null, `${money(sm.owed)} owed`), `, due ${sm.dueDate}.`),
      Number(sm.overrides) > 0 && h("p", { className: "muted" }, `${sm.overrides} with a manual rate, flagged below.`),
      sm.status === "paid"
        ? h("p", null, h("span", { className: "pill pill--live" }, `Paid ${sm.paidOn}`), sm.note ? ` ${sm.note}` : "")
        : !sm.ended
          ? h("p", { className: "muted" }, "This month can be marked paid once it has ended.")
          : h("form", { onSubmit: markPaid, noValidate: true, className: "saveRow" },
              h("input", { type: "date", className: "loginInput", style: { maxWidth: "180px" }, "aria-label": "Paid on", value: paidOn, disabled: busy,
                onChange: (e) => setPaidOn(e.target.value) }),
              h("input", { className: "loginInput", style: { maxWidth: "320px" }, placeholder: "Note, like e-transfer", maxLength: 500, value: note, disabled: busy,
                onChange: (e) => setNote(e.target.value) }),
              h("button", { type: "submit", className: "primaryBtn", disabled: busy || !paidOn }, busy ? "Saving…" : "Mark paid")),
      msg && h("div", { className: msg.ok ? "successMsg" : "loginError", role: "status" }, msg.text)),
    h("div", { className: "card" },
      data.agreements.length === 0 ? h("p", { className: "muted" }, "No agreements closed this month.")
      : h("table", { className: "companyTable" },
          h("thead", null, h("tr", null, ["Closed", "Reservation", "Branch", "Class", "Revenue", "%", "Owed", "Flags"].map((x) => h("th", { key: x }, x)))),
          h("tbody", null, data.agreements.map((a) => h("tr", { key: a.agreementId },
            h("td", null, a.closedOn), h("td", null, a.resCode || ""), h("td", null, a.branch || ""), h("td", null, a.vehicleClass || ""),
            h("td", null, money(a.revenue)), h("td", null, a.percent == null ? "Not set" : `${Number(a.percent)}%`), h("td", null, money(a.owed)),
            h("td", null, [
              a.override && `Manual rate (rates give ${money(a.expectedRevenue)})`,
              a.source === "rates" && "No charges saved, priced from rates",
              a.changedAfterPaid && "Changed after paid",
            ].filter(Boolean).join(". "))))))));
}

// A 12-month bar chart: one bar a month, a second series drawn inside it
// when given (collected inside owed). Plain SVG, sized to its box.
function MonthBars({ months, value, inner, format, label }) {
  const W = 640, H = 180, pad = 28, gap = 6;
  const max = Math.max(1, ...months.map((m) => Number(value(m)) || 0));
  const bw = (W - pad) / months.length - gap;
  return h("figure", { style: { margin: 0 } },
    h("figcaption", { className: "muted", style: { fontSize: "0.85rem", marginBottom: "6px" } }, label),
    h("svg", { viewBox: `0 0 ${W} ${H + 22}`, width: "100%", role: "img", "aria-label": label },
      months.map((m, i) => {
        const v = Number(value(m)) || 0, x = pad + i * (bw + gap);
        const bh = (v / max) * H, ih = inner ? ((Number(inner(m)) || 0) / max) * H : 0;
        return h("g", { key: m.month },
          h("title", null, `${monthLabel(m.month)}: ${format(v)}${inner ? `, ${format(inner(m))} collected` : ""}`),
          h("rect", { x, y: H - bh, width: bw, height: bh, rx: 3, fill: "var(--terracotta-soft)" }),
          inner && h("rect", { x, y: H - ih, width: bw, height: ih, rx: 3, fill: "var(--terracotta)" }),
          h("text", { x: x + bw / 2, y: H + 16, textAnchor: "middle", fontSize: 11, fill: "var(--muted)" }, shortMonth(m.month)));
      })));
}

// fleetr's own numbers, month by month.
function DashboardScreen() {
  const [d, setD] = React.useState(undefined);
  React.useEffect(() => { adminRequest("/admin/dashboard?months=12").then((r) => setD(r.ok ? r.body : { error: r.message })); }, []);
  const title = h("h1", { className: "pageTitle" }, "Dashboard");
  if (d === undefined) return h(React.Fragment, null, title, h("div", { className: "card" }, h(Skeleton, { lines: 5 })));
  if (d.error) return h(React.Fragment, null, title, h("div", { className: "loginError", role: "alert" }, d.error));
  const ms = d.months, cur = ms[ms.length - 1], prev = ms[ms.length - 2] || {};
  const change = (pct) => (pct == null ? "No change to compare" : `${pct > 0 ? "+" : ""}${pct}% on last month`);
  const tile = (label, value, sub) => h("div", { className: "card", style: { margin: 0 } },
    h("div", { className: "muted", style: { fontSize: "0.85rem" } }, label),
    h("div", { style: { fontSize: "1.6rem", fontWeight: 700, margin: "4px 0" } }, value),
    sub && h("div", { className: "muted", style: { fontSize: "0.8rem" } }, sub));
  return h(React.Fragment, null, title,
    h("p", { className: "muted", style: { marginTop: 0 } }, `${monthLabel(cur.month)} so far, in Newfoundland time.`),
    h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "16px" } },
      tile("fleetr revenue owed", money(cur.owed), change(d.change.owed)),
      tile("Collected", money(cur.collected), `Last month: ${money(prev.collected)} of ${money(prev.owed)}`),
      tile("Outstanding", money(d.outstanding), "Unpaid on months that have ended"),
      tile("Rental revenue processed", money(cur.processed), change(d.change.processed)),
      tile("Effective take rate", cur.takeRate == null ? "None yet" : `${Number(cur.takeRate)}%`, "fleetr revenue over rental revenue processed"),
      tile("Vehicles under management", cur.snapshot ? Number(cur.vehicles).toLocaleString("en-CA") : "Recorded daily", cur.snapshot ? change(d.change.vehicles) : "The first count is taken at 07:00 UTC"),
      tile("Active companies", cur.snapshot ? cur.activeCompanies : "Recorded daily", "Launched, not paused or suspended"),
      tile("Rentals closed", Number(cur.rentals).toLocaleString("en-CA"), `Last month: ${Number(prev.rentals || 0).toLocaleString("en-CA")}`)),
    h("div", { className: "card" }, h(MonthBars, { months: ms, value: (m) => m.owed, inner: (m) => m.collected, format: money,
      label: "fleetr revenue by month: owed (light), collected (dark)" })),
    h("div", { className: "card" }, h(MonthBars, { months: ms, value: (m) => m.processed, format: money, label: "Rental revenue processed by month" })),
    h("div", { className: "card" }, h(MonthBars, { months: ms, value: (m) => m.vehicles, format: (v) => `${v} vehicles`, label: "Vehicles under management by month" })),
    h("div", { className: "card" }, h(MonthBars, { months: ms, value: (m) => m.rentals, format: (v) => `${v} rentals`, label: "Rentals closed by month" })));
}

// ─── Customer texts ───────────────────────────────────────────────────────────
// fleetr's seven customer texts, the same for every company
// (fleetr_message_templates). Each shows with sample values filled in, the
// parts the texting Worker adds after the wording, and its footer, then its
// length and how many message parts it is sent as. The preview mirrors
// worker.js (fleetr-infra): fillTemplate, fillReturn, codeSuffix, appSuffix,
// cancelSuffix, rescheduleSuffix, extendSuffix, footerLine, isGsm7 and
// gsm7Length. If the
// Worker's copy changes, change this one. The tokens are stand-ins of the real
// length, so the count is the real count.
const TEXT_SAMPLE = {
  "[first name]": "Alex", "[company]": "Avalon Rentals", "[location]": "40 Harbour Dr",
  "[date]": "Oct 6", "[time]": "10:00 AM", "[return date]": "Oct 9", "[return time]": "2:00 PM",
};
const TEXT_URL = (mark) => `https://app.fleetr.ai/#${mark}=XXXXXXXXXXXXXXXXXXXXXX`;
const TEXT_LINK = (label, mark) => ` ${label} ${TEXT_URL(mark)}`;
// The parts the system adds, which a text can also place in its wording. A
// part the wording leaves out is added after it, labelled, as the Worker does.
const TEXT_PART = {
  code:   { label: "Reservation code", placeholder: "[reservation code]", sample: "ABC 123 456", tail: " Reservation code: ABC 123 456." },
  app:    { label: "App link", placeholder: "[app link]", sample: TEXT_URL("a"), tail: TEXT_LINK("App:", "a") },
  cancel: { label: "Cancel link", placeholder: "[cancel link]", sample: TEXT_URL("c"), tail: TEXT_LINK("Cancel:", "c") },
  change: { label: "Change pickup link", placeholder: "[change link]", sample: TEXT_URL("r"), tail: TEXT_LINK("Change pickup time:", "r") },
  extend: { label: "Extend link", placeholder: "[extend link]", sample: TEXT_URL("e"), tail: TEXT_LINK("Need more time? Extend:", "e") },
};
// Placeholders only some texts have.
const TEXT_RETURN_PLACEHOLDERS = [["Return date", "[return date]"], ["Return time", "[return time]"]];
const TEXT_KINDS = [
  { kind: "confirmation", title: "Reservation confirmation", when: "Sent when a reservation is made.",
    parts: [TEXT_PART.code, TEXT_PART.app, TEXT_PART.cancel, { ...TEXT_PART.extend, tail: "" }] },
  // The pre-rental never carried the code: it is only where it is placed.
  // The extend link is only where it is placed in both.
  { kind: "pre_rental", title: "Pre-rental", when: "Sent the day before pickup.",
    parts: [{ ...TEXT_PART.code, tail: "" }, TEXT_PART.app, TEXT_PART.cancel, { ...TEXT_PART.extend, tail: "" }] },
  { kind: "no_show_2hr", title: "No-show, after 2 hours", when: "Sent 2 hours after the pickup time when the customer has not arrived. [time] is the pickup time.",
    parts: [TEXT_PART.change] },
  { kind: "no_show_24hr", title: "No-show, the next day", when: "Sent a day after the 2 hour text, if the customer still has not arrived.",
    parts: [TEXT_PART.change] },
  // The fuel note goes straight after the wording, when the fuel level at
  // pickup is known.
  { kind: "return_reminder", title: "Return reminder", when: "Sent the day before a rental is due back. [date] and [time] are when it is due back. The extend link opens Extend my rental.",
    fuel: " Return fuel at Full to avoid a charge.",
    parts: [{ ...TEXT_PART.app, tail: TEXT_LINK("When you return, open the app to check the vehicle in:", "a") }, TEXT_PART.extend] },
  { kind: "rescheduled", title: "Pickup time changed", when: "Sent when a customer changes their own pickup time in the customer app. [date] and [time] are the new pickup, [return date] and [return time] the new return.",
    extra: TEXT_RETURN_PLACEHOLDERS,
    parts: [TEXT_PART.code, TEXT_PART.app, TEXT_PART.cancel] },
  // The extension never carried the code: it is only where it is placed.
  { kind: "extended", title: "Rental extended", when: "Sent when a customer extends their own rental in the customer app. [date] and [time] are the new return.",
    parts: [{ ...TEXT_PART.code, tail: "" }, TEXT_PART.app] },
];
// The wording with its parts in place, and what is added after it.
function placeTextParts(body, parts) {
  let text = String(body), tail = "";
  for (const p of parts) {
    const re = new RegExp(p.placeholder.replace(/[[\]]/g, "\\$&"), "gi");
    if (re.test(text)) text = text.replace(new RegExp(re.source, "gi"), () => p.sample);
    else tail += p.tail;
  }
  return { text, tail };
}
const TEXT_PLACEHOLDERS = [["First name", "[first name]"], ["Company", "[company]"], ["Location", "[location]"], ["Date", "[date]"], ["Time", "[time]"]];
const TEXT_MAX = 240;
const textFooter = (company) => `\nFrom ${company} via fleetr. Reply STOP to opt out.`;
const fillText = (body) => String(body).replace(/\[(first name|company|location|date|time|return date|return time)\]/gi, (m) => TEXT_SAMPLE[m.toLowerCase()]);
const TEXT_GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
  + "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
  + "\f^{}\\[~]|€");
const TEXT_GSM7_DOUBLE = new Set("^{}\\[~]|€");
// Its length as the carrier counts it, and how many message parts that is.
function measureText(text) {
  const chars = [...String(text)];
  const costly = [...new Set(chars.filter((ch) => !TEXT_GSM7.has(ch)))];
  if (!costly.length) {
    const length = chars.reduce((n, ch) => n + (TEXT_GSM7_DOUBLE.has(ch) ? 2 : 1), 0);
    return { length, parts: length <= 160 ? 1 : Math.ceil(length / 153), perPart: 160, costly };
  }
  const length = String(text).length;
  return { length, parts: length <= 70 ? 1 : Math.ceil(length / 67), perPart: 70, costly };
}
const TEXT_REFUSALS = {
  repeated: "Put each code or link in once.",
  empty: "A text cannot be empty: every company sends it.",
  too_long: `Keep the wording to ${TEXT_MAX} characters.`,
  no_links: "Links are not allowed in the wording. The texting system adds its own.",
  bad_kind: "That text does not exist.",
};
const textRefusal = (r) => (r.reason === "not_in_this_text"
  ? `${(r.refusal && r.refusal.placeholder) || "That"} is not sent with this text.`
  : r.reason === "bad_placeholder"
  ? (r.refusal && r.refusal.placeholder ? `${r.refusal.placeholder} is not a placeholder.` : "There is a stray square bracket.")
    + ` Use only ${TEXT_PLACEHOLDERS.map(([, p]) => p).join(", ")}.`
  : TEXT_REFUSALS[r.reason] || r.message);

function CustomerTextsScreen() {
  const [saved, setSaved] = React.useState(undefined);   // kind -> wording, or { error }
  const [drafts, setDrafts] = React.useState({});
  const [busy, setBusy] = React.useState("");
  const [notes, setNotes] = React.useState({});
  const boxes = React.useRef({});

  React.useEffect(() => {
    let live = true;
    adminRequest("/admin/texts").then((r) => {
      if (!live) return;
      if (!r.ok) { setSaved({ error: r.message }); return; }
      const byKind = Object.fromEntries((r.body.texts || []).map((t) => [t.kind, t.body]));
      setSaved(byKind);
      setDrafts(byKind);
    });
    return () => { live = false; };
  }, []);

  const unsaved = saved && !saved.error ? TEXT_KINDS.filter((k) => (drafts[k.kind] ?? "") !== (saved[k.kind] ?? "")).length : 0;
  React.useEffect(() => {
    leaveGuard = () => (unsaved ? `${unsaved} customer ${unsaved === 1 ? "text has" : "texts have"} unsaved changes. Leave anyway?` : null);
    return () => { leaveGuard = null; };
  }, [unsaved]);

  if (saved === undefined) return h(React.Fragment, null, h("h1", { className: "pageTitle" }, "Customer texts"), h("div", { className: "card" }, h(Skeleton, { lines: 4 })));
  if (saved.error) {
    return h(React.Fragment, null, h("h1", { className: "pageTitle" }, "Customer texts"),
      h("div", { className: "loginError", role: "alert" }, saved.error));
  }

  const save = (k) => {
    setBusy(k.kind);
    setNotes((p) => ({ ...p, [k.kind]: null }));
    adminRequest(`/admin/texts/${k.kind}`, { method: "PUT", body: { body: drafts[k.kind] ?? "" } }).then((r) => {
      setBusy("");
      if (!r.ok) { setNotes((p) => ({ ...p, [k.kind]: { ok: false, text: textRefusal(r) } })); return; }
      setSaved((p) => ({ ...p, [k.kind]: r.body.body }));
      setDrafts((p) => ({ ...p, [k.kind]: r.body.body }));
      toast(`${k.title} saved. Every company sends this wording from now on.`);
    });
  };

  // Puts a placeholder where the cursor is, and leaves the cursor after it.
  const insert = (kind, ph) => {
    const box = boxes.current[kind];
    const value = drafts[kind] ?? "";
    const start = box ? box.selectionStart : value.length, end = box ? box.selectionEnd : value.length;
    setDrafts((p) => ({ ...p, [kind]: value.slice(0, start) + ph + value.slice(end) }));
    setTimeout(() => { const b = boxes.current[kind]; if (b) { b.focus(); b.setSelectionRange(start + ph.length, start + ph.length); } }, 0);
  };

  return h(React.Fragment, null,
    h("h1", { className: "pageTitle" }, "Customer texts"),
    h("p", { className: "muted textsIntro" },
      "The texts every company's customers receive. The placeholders fill in for each company, branch and customer: ",
      h("strong", null, TEXT_PLACEHOLDERS.map(([, p]) => p).join(", ")),
      ". Each text's reservation code and links can be placed in the wording too, with the buttons under its name; one left out is added at the end, labelled, so it is never lost. The footer is always added last and cannot be edited. The previews use a made-up customer at a made-up company."),
    TEXT_KINDS.map((k) => {
      const draft = drafts[k.kind] ?? "";
      const trimmed = draft.trim();
      const changed = draft !== (saved[k.kind] ?? "");
      const footer = textFooter(TEXT_SAMPLE["[company]"]);
      const placed = placeTextParts(trimmed, k.parts);
      const added = (k.fuel || "") + placed.tail;
      const full = fillText(placed.text) + added + footer;
      const m = measureText(full);
      const placeholders = [...TEXT_PLACEHOLDERS, ...(k.extra || [])];
      const allowed = [...placeholders.map(([, p]) => p), ...k.parts.map((p) => p.placeholder)];
      const unknown = (trimmed.match(/\[[^\][]*\]/g) || []).filter((ph) => !allowed.includes(ph.toLowerCase()));
      const repeated = k.parts.filter((p) => (trimmed.toLowerCase().split(p.placeholder).length - 1) > 1).map((p) => p.placeholder);
      const addsList = [k.fuel && "the fuel note", ...k.parts.filter((p) => p.tail && placed.tail.includes(p.tail)).map((p) => `the ${p.label.toLowerCase()}`)].filter(Boolean);
      const addsWords = addsList.length > 1 ? [`${addsList.slice(0, -1).join(", ")} and ${addsList[addsList.length - 1]}`] : addsList;
      const note = notes[k.kind];
      return h("section", { key: k.kind, className: "detailSection" },
        h("h2", { className: "sectionTitle" }, k.title),
        h("p", { className: "muted textWhen" }, k.when),
        h("div", { className: "textInserts" },
          placeholders.map(([label, ph]) => h("button", {
            key: ph, type: "button", className: "chipBtn",
            onMouseDown: (e) => e.preventDefault(), onClick: () => insert(k.kind, ph),
          }, `+ ${label}`)),
          k.parts.map((p) => h("button", {
            key: p.placeholder, type: "button", className: "chipBtn chipBtn--part",
            disabled: trimmed.toLowerCase().includes(p.placeholder),
            title: trimmed.toLowerCase().includes(p.placeholder) ? "Already in the wording" : `Place the ${p.label.toLowerCase()} here`,
            onMouseDown: (e) => e.preventDefault(), onClick: () => insert(k.kind, p.placeholder),
          }, `+ ${p.label}`))),
        h("textarea", {
          className: "loginInput textBox", rows: 3, value: draft, "aria-label": `${k.title} wording`,
          ref: (n) => { boxes.current[k.kind] = n; },
          onChange: (e) => { setDrafts((p) => ({ ...p, [k.kind]: e.target.value })); setNotes((p) => ({ ...p, [k.kind]: null })); },
        }),
        h("div", { className: "muted textCount" }, `${trimmed.length} of ${TEXT_MAX} characters of wording`),
        h("div", { className: "textPreviewLabel" }, "What a customer receives"),
        h("div", { className: "textPreview" },
          h("span", null, fillText(placed.text)),
          h("span", { className: "textAdded" }, added),
          h("span", { className: "textAdded" }, footer)),
        h("div", { className: "textMeasure" },
          h("span", { className: `textChip${m.parts > 1 ? " textChip--warn" : ""}` }, `${m.parts} message part${m.parts === 1 ? "" : "s"}`),
          h("span", { className: "muted" }, `${m.length} characters${addsWords.length ? `, counting ${addsWords[0]}, added at the end` : ""}, plus the footer. ${m.perPart} fit in one part; a longer company name, branch or customer name adds to this.`)),
        m.parts > 1 && h("div", { className: "loginError" }, `This is sent as ${m.parts} message parts, and each part is billed as a text. Shorten the wording to bring it back to one.`),
        m.costly.length > 0 && h("div", { className: "loginError" },
          `These characters make each part hold 70 characters instead of 160: ${m.costly.map((ch) => (ch === "\n" ? "line break" : ch)).join("  ")}. Curly quotes are saved as straight ones.`),
        trimmed.length > TEXT_MAX && h("div", { className: "loginError" }, `${trimmed.length - TEXT_MAX} characters over the ${TEXT_MAX} allowed.`),
        unknown.length > 0 && h("div", { className: "loginError" }, `${unknown.join(", ")} ${unknown.length === 1 ? "is not a placeholder for this text" : "are not placeholders for this text"}.`),
        repeated.length > 0 && h("div", { className: "loginError" }, `${repeated.join(", ")} can go in once.`),
        h("div", { className: "saveRow", style: { marginTop: "12px" } },
          h("button", {
            type: "button", className: "primaryBtn",
            disabled: busy === k.kind || !changed || !trimmed || trimmed.length > TEXT_MAX || unknown.length > 0 || repeated.length > 0,
            onClick: () => save(k),
          }, busy === k.kind ? "Saving…" : "Save"),
          changed && h("button", {
            type: "button", className: "linkBtn", disabled: busy === k.kind,
            onClick: () => { setDrafts((p) => ({ ...p, [k.kind]: saved[k.kind] ?? "" })); setNotes((p) => ({ ...p, [k.kind]: null })); },
          }, "Discard")),
        note && h("div", { className: note.ok ? "successMsg" : "loginError", role: note.ok ? "status" : "alert" }, note.text));
    }));
}

// The staff app's dark sidebar on a wide screen, with the highlight behind
// the current page; on a phone, the website's top bar and its drop-down menu.
const NAV = [
  { key: "dashboard", label: "Dashboard", href: "#/dashboard", icon: "dashboard" },
  { key: "companies", label: "Companies", href: "#/", icon: "companies" },
  { key: "billing", label: "Billing", href: "#/billing", icon: "billing" },
  { key: "texts", label: "Customer texts", href: "#/texts", icon: "texts" },
];

function SignedInShell({ companies, onCreated, onUpdated, onDeleted, onSignOut }) {
  const route = useHashRoute();
  const [menu, setMenu] = React.useState(false);
  const signOut = () => {
    if (!confirmLeave()) return;
    leaveGuard = null;
    // So the next sign-in starts on the list, not on whichever company was open.
    if (window.location.hash) window.location.hash = "";
    onSignOut();
  };
  React.useEffect(() => { setMenu(false); }, [route.name, route.id]);
  const current = route.name === "texts" ? "texts" : route.name === "dashboard" ? "dashboard"
    : route.name === "billing" || route.name === "billingCompany" ? "billing" : "companies";
  const email = (supabase.auth.session() && supabase.auth.session().user && supabase.auth.session().user.email) || "";
  const navLinks = (cls) => NAV.map((n) => h("a", {
    key: n.key, href: n.href, className: `${cls}${current === n.key ? ` ${cls}--on` : ""}`, "aria-current": current === n.key ? "page" : undefined,
  }, h(Icon, { name: n.icon, size: 18 }), h("span", null, n.label)));

  return h("div", { className: "shell" },
    h("aside", { className: "side" },
      h("a", { href: "#/", className: "side__brand homeLink" }, h(Wordmark, { tone: "dark" })),
      h("div", { className: "side__label" }, "Platform"),
      h("nav", { className: "side__nav" }, navLinks("side__item")),
      h("div", { className: "side__foot" },
        h(Avatar, { name: email.split("@")[0].replace(/[._-]+/g, " ") }),
        h("div", { className: "side__user" },
          h("div", { className: "side__email", title: email }, email || "Signed in"),
          h("div", { className: "side__role" }, "Platform admin")),
        h("button", { type: "button", className: "iconBtn iconBtn--dark", "aria-label": "Sign out", title: "Sign out", onClick: signOut },
          h(Icon, { name: "signOut", size: 17 })))),

    h("header", { className: "topbar" },
      h("a", { href: "#/", className: "homeLink" }, h(Wordmark)),
      h("button", { type: "button", className: "menuBtn", "aria-expanded": menu, onClick: () => setMenu((m) => !m) },
        h(Icon, { name: menu ? "close" : "menu", size: 16 }), "Menu"),
      h("div", { className: `sheet${menu ? " sheet--open" : ""}` },
        navLinks("sheet__item"),
        h("hr", null),
        h("button", { type: "button", className: "sheet__item sheet__signOut", onClick: signOut }, h(Icon, { name: "signOut", size: 18 }), h("span", null, "Sign out")))),

    h("main", { className: "main" },
      h("div", { className: "main__inner" },
        route.name === "texts" ? h(CustomerTextsScreen) :
        route.name === "dashboard" ? h(DashboardScreen) :
        route.name === "billing" ? h(BillingScreen) :
        route.name === "billingCompany" ? h(BillingCompanyScreen, { key: `${route.id}:${route.month}`, id: route.id, month: route.month }) :
        route.name === "company"
          ? h(CompanyDetailScreen, { key: route.id, id: route.id, onUpdated, onDeleted: (gone) => {
              // Nothing is left to save, so leave without asking.
              leaveGuard = null;
              onDeleted(gone);
              toast("The company was deleted.");
              window.location.hash = "";
            } })
          : h(CompanyListScreen, { companies, onCreated }))),
    h(Toaster));
}

function App() {
  // undefined while a stored session is being checked, null when signed out.
  const [companies, setCompanies] = React.useState(undefined);
  const [notice,    setNotice]    = React.useState("");

  React.useEffect(() => {
    resumeSession().then((gate) => {
      if (gate && gate.ok) { setCompanies(gate.companies); return; }
      if (gate) {
        console.warn("fleetr hq session refused:", gate.reason, gate.error);
        setNotice(reasonMessage(gate.reason));
      }
      setCompanies(null);
    });
  }, []);

  const signOut = () => {
    supabase.auth.signOut().catch((e) => console.warn("sign out:", e));
    setNotice("");
    setCompanies(null);
  };

  if (companies === undefined) return h("div", { className: "loginWrap muted" }, "Loading…");
  if (companies === null) {
    return h(LoginScreen, { onSuccess: (list) => { setNotice(""); setCompanies(list); }, notice });
  }
  return h(SignedInShell, {
    companies,
    // Appended, since the Worker lists in creation order.
    onCreated: (company) => setCompanies((list) => [...list, company]),
    // So the list is current on the way back from an edit, without a refetch.
    onUpdated: (company) => setCompanies((list) => list.map((c) => (c.id === company.id ? company : c))),
    onDeleted: (gone) => setCompanies((list) => list.filter((c) => c.id !== gone)),
    onSignOut: signOut,
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Tokens live in index.html: the neutral and terracotta palette of the staff
// app. Terracotta carries dark ink text, never white, which is not readable on
// it; text in terracotta uses the deeper --terracotta-text.
const css = `
.textsIntro{line-height:1.5;margin:0 0 8px}
.textWhen{margin:-4px 0 10px;font-size:0.9rem}
.textInserts{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chipBtn{font:inherit;font-size:0.8rem;font-weight:500;color:var(--text);background:var(--card);border:1px solid var(--border);
  border-radius:999px;padding:4px 10px;cursor:pointer}
.chipBtn:hover:not(:disabled){border-color:var(--terracotta);color:var(--terracotta-text)}
.chipBtn--part{background:var(--terracotta-soft, #FDEEE8);border-color:transparent}
.chipBtn:disabled{opacity:0.45;cursor:default}
.textBox{display:block;width:100%;box-sizing:border-box;margin-bottom:4px;resize:vertical;line-height:1.45}
.textCount{font-size:0.8rem;margin-bottom:12px}
.textPreviewLabel{font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:6px}
.textPreview{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--border);border-radius:14px 14px 14px 4px;
  padding:12px 14px;line-height:1.45;font-size:0.92rem;max-width:520px}
.textAdded{color:var(--muted)}
.textMeasure{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-top:10px;font-size:0.85rem}
.textChip{font-weight:600;font-size:0.8rem;padding:2px 10px;border-radius:999px;background:var(--border)}
.textChip--warn{background:var(--terracotta)}
/* The wordmark, drawn as a mask in the colour for its background, 30px
   tall; its width follows the wordmark's shape. */
.wordmark{display:inline-flex;align-items:center;gap:10px;padding:8px 0;font-size:1.75rem;font-weight:700;letter-spacing:-0.02em;line-height:1}
.wordmarkLogo{display:block;height:30px;width:calc(30px * 3.1099);background-color:#F4845F;-webkit-mask:url(./wordmark.svg) center / contain no-repeat;mask:url(./wordmark.svg) center / contain no-repeat}
.wordmarkLogo--dark{background-color:#F9F9F7}
.wordmarkHq{font-weight:500;color:var(--muted);margin-left:6px}
.muted{color:var(--muted)}
.setupHeading{font-size:0.95rem;margin:16px 0 6px}
.setupList{list-style:none;margin:0;padding:0}
.setupItem{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--border)}
.setupDone,.setupLeft{flex:0 0 44px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
.setupLeft{color:var(--muted)}
.staffActions{display:flex;gap:14px;flex-wrap:wrap;white-space:nowrap}

.loginWrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
/* The sign-in page, as the staff app draws its own: the same card, wordmark,
   fields, spacing and terracotta pill, with no animation. */
.hqSignIn{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F9F9F7;font-family:'Inter',sans-serif}
.hqSignIn__card{background:#F9F9F7;border-radius:16px;padding:40px;width:340px;max-width:calc(100% - 32px);box-sizing:border-box;
  box-shadow:0 4px 24px rgba(0,0,0,0.10),0 1.5px 6px rgba(0,0,0,0.06)}
.hqSignIn__brand{display:flex;justify-content:center;align-items:center;gap:8px;padding:8px 0;margin:0 0 28px;line-height:1}
.hqSignIn__wordmark{height:35px;width:calc(35px * 3.1099)}
.hqSignIn__hq{font-size:26px;font-weight:600;letter-spacing:-0.02em;color:#1F1E1D}
.hqSignIn__form{display:flex;flex-direction:column;gap:12px;margin:0}
.hqSignIn__input{border:1px solid #E3E2DE;border-radius:8px;padding:12px 14px;font-size:14.5px;font-family:inherit;
  color:#1F1E1D;background:#fff;outline:none}
.hqSignIn__input:focus{border-color:#F4845F;box-shadow:0 0 0 3px rgba(244,132,95,0.18)}
.hqSignIn__btn{display:flex;align-items:center;justify-content:center;width:100%;margin-top:8px;padding:13px 16px;
  border:none;border-radius:999px;background:#F4845F;color:#F9F9F7;font-family:inherit;font-size:15px;font-weight:700;
  letter-spacing:0.01em;cursor:pointer}
.hqSignIn__btn:hover:not(:disabled){background:#E06D47}
.hqSignIn__btn:disabled{opacity:0.6;cursor:default}
.hqSignIn__error{font-size:13px;color:#c0392b;text-align:center;font-weight:500}
.loginForm{display:flex;flex-direction:column;text-align:left}
.loginLabel{font-size:0.8rem;font-weight:600;margin:0 0 6px}
.loginInput{font:inherit;color:var(--text);background:var(--card);padding:10px 12px;margin-bottom:16px;
  border:1px solid var(--border);border-radius:8px}
.loginInput:focus{outline:2px solid var(--terracotta);outline-offset:1px;border-color:var(--terracotta)}
.loginBtn{font:inherit;font-weight:600;color:var(--text);background:var(--terracotta);border:0;
  border-radius:999px;padding:11px;cursor:pointer;margin-top:4px}
.loginBtn:hover:not(:disabled){background:var(--terracotta-hover)}
.loginBtn:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.loginBtn:disabled{opacity:0.6;cursor:default}
.loginError{margin-top:16px;padding:10px 12px;font-size:0.9rem;font-weight:500;
  background:rgba(192,57,43,0.08);border-left:3px solid #c0392b;border-radius:6px}

.page{max-width:880px;margin:0 auto;padding:24px}
.pageHeader{display:flex;align-items:center;justify-content:space-between;
  padding-bottom:16px;border-bottom:2px solid var(--terracotta)}
.pageBody{padding-top:24px}
.pageTitle{font-size:1.25rem;font-weight:600;margin:0 0 16px}
.linkBtn{font:inherit;font-weight:500;color:var(--text);background:none;border:0;cursor:pointer;
  text-decoration:underline;text-decoration-color:var(--terracotta);text-decoration-thickness:2px;
  text-underline-offset:4px}
.linkBtn:hover:not(:disabled){color:var(--terracotta-text)}
.linkBtn:disabled{opacity:0.5;cursor:default}
.homeLink{color:inherit;text-decoration:none}
.backLink{display:inline-block;margin-bottom:16px}

.titleRow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.titleRow .pageTitle{margin:0}
.primaryBtn{font:inherit;font-weight:600;color:var(--text);background:var(--terracotta);border:0;
  border-radius:999px;padding:9px 18px;cursor:pointer;white-space:nowrap}
.primaryBtn:hover:not(:disabled){background:var(--terracotta-hover)}
.primaryBtn:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.primaryBtn:disabled{opacity:0.6;cursor:default}

.newCompany{margin-bottom:24px;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
.newCompanyRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.newCompanyRow .loginInput{flex:1;min-width:200px;margin:0}
.newCompany .loginError{margin-top:12px}

.tableWrap{overflow-x:auto}
.companyTable{width:100%;border-collapse:collapse}
.companyTable th{text-align:left;font-size:0.75rem;font-weight:600;text-transform:uppercase;
  letter-spacing:0.04em;color:var(--muted);padding:0 12px 10px;border-bottom:1px solid var(--border)}
.companyTable td{padding:12px;border-bottom:1px solid var(--border);vertical-align:middle}
.companyTable th:first-child,.companyTable td:first-child{padding-left:0}
.companyTable tbody tr:hover{background:rgba(244,132,95,0.06)}
.companyLink{color:var(--text);font-weight:500;text-decoration:none}
.companyLink:hover,.companyLink:focus-visible{text-decoration:underline;
  text-decoration-color:var(--terracotta);text-decoration-thickness:2px;text-underline-offset:4px}

.badge{display:inline-block;font-size:0.8rem;font-weight:500;padding:2px 10px;border-radius:999px;
  border:1px solid transparent}
.badge-trial{background:#F1F0EC;border-color:rgba(31,30,29,0.28)}
.badge-active{background:rgba(107,203,119,0.18);border-color:var(--green)}
.badge-suspended{background:rgba(244,132,95,0.16);border-color:var(--terracotta)}
.badge-unknown{background:rgba(31,30,29,0.05);border-color:var(--border)}

.titleRow .badge{margin-right:auto}
.detailSection{padding:24px 0;border-top:1px solid var(--border)}
.detailSection:first-of-type{border-top:0;padding-top:8px}
.sectionTitle{font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;
  color:var(--muted);margin:0 0 16px}
.detailGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));column-gap:20px}
.detailField{display:flex;flex-direction:column}
select.loginInput{appearance:auto}
.loginInput:disabled{opacity:0.6}
.readOnlyValue{font-weight:600;letter-spacing:0.12em;padding:10px 0;margin-bottom:16px}
.saveRow{display:flex;align-items:center;gap:12px}
.successMsg{margin-top:16px;padding:10px 12px;font-size:0.9rem;font-weight:500;
  background:rgba(107,203,119,0.16);border-left:3px solid var(--green);border-radius:6px}

.featureRow{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 0;border-bottom:1px solid var(--border)}
.featureRow:first-of-type{border-top:1px solid var(--border)}
.featureLabel{font-weight:500}
.featureControl{display:flex;align-items:center;gap:10px}
.featureState{font-size:0.85rem;color:var(--muted);min-width:3.5em;text-align:right}
.toggle{position:relative;width:44px;height:24px;border-radius:999px;border:1px solid rgba(31,30,29,0.25);
  background:rgba(31,30,29,0.08);cursor:pointer;padding:0;transition:background .15s,border-color .15s}
.toggleOn{background:var(--terracotta);border-color:var(--terracotta)}
.toggleKnob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(31,30,29,0.3);transition:transform .15s}
.toggleOn .toggleKnob{transform:translateX(20px)}
.toggle:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px}
.toggle:disabled{opacity:0.6;cursor:default}

/* Dark, not terracotta: terracotta is the ordinary action now, and a delete
   must not look like one. */
.dangerBtn{font:inherit;font-weight:600;color:var(--bg);background:var(--text);border:0;
  border-radius:999px;padding:9px 18px;cursor:pointer;white-space:nowrap}
.dangerBtn:hover:not(:disabled){background:#3A3936}
.dangerBtn:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px}
.dangerBtn:disabled{opacity:0.5;cursor:default}
.deleteBox{padding:16px;background:var(--card);border:1px solid var(--terracotta);border-radius:var(--radius);display:flex;flex-direction:column}
.deleteBox .loginError{margin:0 0 16px}
.deleteTitle{font-weight:600;margin:0 0 8px}
.deleteList{margin:0 0 16px;padding-left:20px}
.deleteList li{margin:2px 0}

/* ── The look: the staff app's shell, the website's buttons and cards ─────── */
:root{--ink:#1F1E1D;--ink-06:#F1F0EC;--shadow:0 1px 2px rgba(31,30,29,0.05),0 8px 24px rgba(31,30,29,0.07);
  --shadow-lg:0 2px 4px rgba(31,30,29,0.06),0 18px 48px rgba(31,30,29,0.16)}
.small{font-size:0.8rem}
.shell{min-height:100%;display:flex}
.main{flex:1;min-width:0}
.main__inner{max-width:1080px;margin:0 auto;padding:32px 32px 64px}

/* Sidebar, as the staff app's: dark, terracotta tint on the current page. */
.side{position:sticky;top:0;height:100vh;width:236px;flex:none;display:flex;flex-direction:column;
  background:#1F1E1D;color:#F9F9F7;padding:20px 14px}
.side__brand{padding:4px 10px 22px}
.side .wordmark{color:#F9F9F7;font-size:1.6rem}
.side .wordmarkLogo{height:28px;width:calc(28px * 3.1099)}
.side .wordmarkHq{color:rgba(249,249,247,0.55)}
.side__label{font-size:0.68rem;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:rgba(249,249,247,0.45);padding:0 10px 8px}
.side__nav{display:flex;flex-direction:column;gap:2px}
.side__item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:9px;color:rgba(249,249,247,0.78);
  text-decoration:none;font-weight:500;font-size:0.92rem;border-left:3px solid transparent;transition:background .15s,color .15s}
.side__item:hover{background:rgba(249,249,247,0.07);color:#F9F9F7}
.side__item--on{background:rgba(244,132,95,0.22);border-left-color:#F4845F;color:#F9F9F7}
.side__foot{margin-top:auto;display:flex;align-items:center;gap:10px;padding:12px 8px 2px;border-top:1px solid rgba(249,249,247,0.1)}
.side__foot .avatar{background:rgba(244,132,95,0.25);color:#F9F9F7}
.side__user{min-width:0;flex:1}
.side__email{font-size:0.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side__role{font-size:0.72rem;color:rgba(249,249,247,0.5)}

/* Phone: the website's top bar, with a drop-down sheet. */
.topbar{display:none}
@media (max-width:899px){
  .shell{flex-direction:column}
  .side{display:none}
  .topbar{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;height:60px;padding:0 16px;
    background:rgba(249,249,247,0.8);-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--border)}
  .topbar .wordmark{font-size:1.4rem}
  .topbar .wordmarkLogo{height:26px;width:calc(26px * 3.1099)}
  .main__inner{padding:20px 16px 48px}
}
.menuBtn{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 14px;border:1px solid var(--border);border-radius:999px;
  background:var(--bg);font:inherit;font-size:0.88rem;font-weight:600;color:var(--text);cursor:pointer}
.sheet{position:absolute;top:calc(100% + 6px);left:12px;right:12px;padding:8px;background:var(--bg);border:1px solid var(--border);
  border-radius:20px;box-shadow:var(--shadow-lg);opacity:0;visibility:hidden;transform:translateY(-8px);transition:opacity .25s,transform .25s,visibility .25s}
.sheet--open{opacity:1;visibility:visible;transform:none}
.sheet__item{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;border-radius:14px;text-decoration:none;color:var(--text);
  font:inherit;font-size:1rem;font-weight:500;background:none;border:0;cursor:pointer;text-align:left}
.sheet__item:hover,.sheet__item--on{background:var(--ink-06)}
.sheet hr{border:0;border-top:1px solid var(--border);margin:6px 8px}

/* Page heads */
.titleRow{align-items:flex-end;margin-bottom:22px}
.pageTitle{font-size:1.6rem;font-weight:700;letter-spacing:-0.02em}
.pageSub{margin:4px 0 0;font-size:0.92rem}
.crumbs{display:flex;align-items:center;gap:6px;font-size:0.88rem;color:var(--muted);margin-bottom:14px}
.crumbs a{color:var(--muted);text-decoration:none}
.crumbs a:hover{color:var(--terracotta-text)}
.crumbs span[aria-current]{color:var(--text);font-weight:500}

/* Cards: every section sits on one. */
.card,.detailSection{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:22px 24px;margin-bottom:16px}
.detailSection:first-of-type{padding-top:22px;border-top:1px solid var(--border)}
.sectionTitle{font-size:0.78rem;margin-bottom:6px}
.sectionSub{margin:0 0 14px;font-size:0.9rem}

/* Buttons: the website's tactile primary with its shine, and an outline one. */
.primaryBtn,.secondaryBtn{position:relative;overflow:hidden;isolation:isolate;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  border-radius:12px;padding:10px 18px;font:inherit;font-weight:600;font-size:0.92rem;cursor:pointer;white-space:nowrap;transition:transform .15s,box-shadow .15s,background .15s,border-color .15s}
.primaryBtn{border:0;background:var(--terracotta);color:var(--text);box-shadow:inset 0 -3px 0 rgba(31,30,29,0.16),0 1px 2px rgba(31,30,29,0.12)}
.primaryBtn:hover:not(:disabled){background:var(--terracotta-hover);transform:translateY(-1px);box-shadow:inset 0 -3px 0 rgba(31,30,29,0.16),0 6px 14px rgba(31,30,29,0.14)}
.primaryBtn:active:not(:disabled){transform:translateY(1px);box-shadow:inset 0 -1px 0 rgba(31,30,29,0.16)}
.primaryBtn::after{content:"";position:absolute;inset:0;pointer-events:none;transform:translateX(-110%);
  background:linear-gradient(110deg,transparent 35%,rgba(249,249,247,0.5) 50%,transparent 65%)}
@media (hover:hover){.primaryBtn:hover:not(:disabled)::after{transform:translateX(110%);transition:transform .7s ease}}
.primaryBtn:disabled{background:var(--ink-06);color:var(--muted);box-shadow:none;opacity:1}
.secondaryBtn{border:1px solid var(--border);background:var(--card);color:var(--text)}
.secondaryBtn:hover:not(:disabled){border-color:rgba(31,30,29,0.3);background:var(--ink-06)}
.secondaryBtn:disabled{opacity:0.5;cursor:default}
.iconBtn{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:9px;border:0;background:none;color:var(--muted);cursor:pointer}
.iconBtn:hover:not(:disabled){background:var(--ink-06);color:var(--text)}
.iconBtn--dark{color:rgba(249,249,247,0.6)}
.iconBtn--dark:hover:not(:disabled){background:rgba(249,249,247,0.1);color:#F9F9F7}

/* The website's motion button: the ink circle grows across on hover. */
.motionBtn{position:relative;isolation:isolate;overflow:hidden;display:inline-flex;align-items:center;gap:12px;padding:5px 22px 5px 5px;
  border:0;border-radius:999px;background:var(--terracotta);color:var(--text);font:inherit;font-weight:600;font-size:0.92rem;cursor:pointer;transition:color .3s}
.motionBtn__fill{position:absolute;z-index:-1;left:5px;top:5px;bottom:5px;width:36px;border-radius:999px;background:var(--ink);transition:width .45s cubic-bezier(.22,1,.36,1)}
.motionBtn__icon{width:36px;height:36px;display:grid;place-items:center;color:#F9F9F7;flex:none}
@media (hover:hover){.motionBtn:hover{color:#F9F9F7}.motionBtn:hover .motionBtn__fill{width:calc(100% - 10px)}}
.motionBtn:focus-visible{outline:2px solid var(--text);outline-offset:2px}

/* Stat tiles, as the staff app's Home: click one to filter by it. */
.statRow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
@media (max-width:720px){.statRow{grid-template-columns:repeat(2,minmax(0,1fr))}}
.statTile{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:16px 18px;text-align:left;font:inherit;color:var(--text);cursor:pointer;
  background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);transition:transform .15s,border-color .15s,box-shadow .15s}
.statTile:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg)}
.statTile--on{border-color:var(--terracotta);box-shadow:0 0 0 3px var(--terracotta-soft),var(--shadow)}
.statTile__value{font-size:1.9rem;font-weight:700;letter-spacing:-0.02em;line-height:1.1;font-variant-numeric:tabular-nums}
.statTile__label{font-size:0.85rem;color:var(--muted);font-weight:500}

/* The list: search, the website's chip group, then the table. */
.listCard{padding:0;overflow:hidden}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border)}
.searchBox{display:flex;align-items:center;gap:8px;flex:1;min-width:200px;max-width:340px;height:40px;padding:0 12px;border:1px solid var(--border);
  border-radius:10px;background:var(--bg);color:var(--muted);transition:border-color .15s,box-shadow .15s}
.searchBox:focus-within{border-color:var(--terracotta);box-shadow:0 0 0 3px var(--terracotta-soft)}
.searchBox input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:0.92rem;color:var(--text)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border:1px solid var(--border);border-radius:999px;background:var(--card);
  font:inherit;font-size:0.85rem;font-weight:500;color:var(--text);cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.chip:hover{border-color:var(--text);transform:translateY(-1px)}
.chip--on{background:var(--terracotta);border-color:var(--terracotta)}
.chip__count{min-width:20px;padding:0 6px;border-radius:999px;background:var(--ink-06);font-size:0.75rem;font-weight:600;text-align:center}
.chip--on .chip__count{background:rgba(31,30,29,0.12)}
.listCard .companyTable th{padding:12px 16px;background:#FCFCFB}
.listCard .companyTable td{padding:12px 16px}
.listCard .companyTable th:first-child,.listCard .companyTable td:first-child{padding-left:18px}
.companyTable tbody tr:last-child td{border-bottom:0}
.rowLink{cursor:pointer}
.rowChevron{color:var(--muted);width:32px;text-align:right}
.rowLink:hover .rowChevron{color:var(--terracotta-text)}
.sortBtn{display:inline-flex;align-items:center;gap:4px;border:0;background:none;padding:0;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer}
.nameCell{display:flex;align-items:center;gap:12px}
.avatar{display:inline-grid;place-items:center;flex:none;width:34px;height:34px;border-radius:50%;background:var(--terracotta-soft);
  color:var(--terracotta-text);font-size:0.78rem;font-weight:700;letter-spacing:0.02em}
.avatar--lg{width:56px;height:56px;font-size:1.15rem}
.emptyState{padding:48px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.emptyState__icon{width:48px;height:48px;display:grid;place-items:center;border-radius:50%;background:var(--ink-06);color:var(--muted);margin-bottom:6px}
.emptyState__title{font-weight:600;margin:0 0 6px}

/* Pills: status with a dot, setup state plain. */
.badge{display:inline-flex;align-items:center;gap:6px;border:0;padding:3px 10px;font-size:0.78rem;font-weight:600}
.badge__dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:0.8}
.badge-trial{background:var(--ink-06);color:#5C5B57}
.badge-active{background:rgba(107,203,119,0.16);color:#2E7D3A}
.badge-suspended{background:var(--terracotta-soft);color:var(--terracotta-text)}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:0.78rem;font-weight:600;background:var(--ink-06);color:#5C5B57}
.pill--live{background:rgba(107,203,119,0.16);color:#2E7D3A}
.pill--paused{background:var(--terracotta-soft);color:var(--terracotta-text)}

/* Company header and tabs */
.hero{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.hero__main{flex:1;min-width:200px}
.hero__name{margin:0 0 8px}
.hero__badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.hero__contact{font-size:0.88rem}
.hero__code{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.hero__codeLabel{font-size:0.72rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted)}
.codeChip{display:inline-flex;align-items:center;gap:4px;padding:4px 4px 4px 12px;border:1px dashed rgba(31,30,29,0.25);border-radius:10px;
  font-weight:700;letter-spacing:0.14em;background:var(--bg)}
.tabs{display:flex;gap:2px;overflow-x:auto;padding:4px;margin:0 0 16px;background:var(--card);border:1px solid var(--border);border-radius:999px;width:max-content;max-width:100%}
.tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:0;border-radius:999px;background:none;
  font:inherit;font-size:0.88rem;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap;transition:background .2s,color .2s}
.tab:hover{color:var(--text)}
.tab--on{background:var(--terracotta);color:var(--text)}
.tab--danger.tab--on{background:var(--text);color:var(--bg)}
.tab__dot{width:7px;height:7px;border-radius:50%;background:var(--terracotta-text)}
.tab--on .tab__dot{background:var(--text)}

/* Setup: a progress bar, then the website's timeline. */
.progress{margin:8px 0 14px}
.progress__top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.progress__count{font-weight:600}
.progress__pct{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
.progress__bar{height:8px;border-radius:999px;background:var(--ink-06);overflow:hidden}
.progress__bar span{display:block;height:100%;border-radius:inherit;background:var(--terracotta);transition:width .6s cubic-bezier(.22,1,.36,1)}
.setupWhere{margin:0 0 6px;color:var(--muted);font-size:0.92rem}
.setupHeading{font-size:0.78rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin:20px 0 4px}
.steps{list-style:none;margin:0;padding:0}
.step{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:14px;padding:10px 0}
.step:not(:last-child)::before{content:"";position:absolute;left:13.5px;top:40px;bottom:-10px;width:1px;background:var(--border)}
.step__node{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--card);box-shadow:inset 0 0 0 1.5px rgba(31,30,29,0.22)}
.step--done .step__node{background:var(--terracotta);color:var(--text);box-shadow:none}
.step--skipped .step__node{background:var(--ink-06);color:var(--muted);box-shadow:none}
.step__title{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-weight:500;padding-top:3px}
.step__state{font-size:0.75rem;font-weight:600;color:var(--muted)}
.step--done .step__state{color:#2E7D3A}
.step__why{font-size:0.88rem;margin-top:2px}

/* Inputs, as the staff app's boxes. */
.loginInput{border-radius:10px;border-color:rgba(31,30,29,0.14);box-shadow:0 1px 2px rgba(31,30,29,0.04);transition:border-color .15s,box-shadow .15s}
.loginInput:hover:not(:disabled){border-color:rgba(31,30,29,0.28)}
.loginInput:focus{outline:none;border-color:var(--terracotta);box-shadow:0 0 0 3px var(--terracotta-soft)}

/* Dialog */
.dialogBackdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:16px;background:rgba(31,30,29,0.32);animation:fadeIn .15s ease}
.dialog{width:100%;max-width:440px;display:flex;flex-direction:column;padding:22px 24px;background:var(--card);border-radius:18px;box-shadow:var(--shadow-lg);animation:popIn .2s cubic-bezier(.22,1,.36,1)}
.dialog__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.dialog__title{font-size:1.15rem;margin:0}
.dialog__sub{margin:0 0 18px;font-size:0.9rem;line-height:1.5}
.dialog__actions{display:flex;justify-content:flex-end;gap:10px}
@keyframes fadeIn{from{opacity:0}}
@keyframes popIn{from{opacity:0;transform:translateY(8px) scale(0.98)}}

/* Toasts */
.toaster{position:fixed;right:20px;bottom:20px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px))}
.toast{display:flex;align-items:center;gap:10px;padding:12px 12px 12px 14px;background:var(--ink);color:#F9F9F7;border-radius:12px;
  box-shadow:var(--shadow-lg);font-size:0.9rem;animation:popIn .25s cubic-bezier(.22,1,.36,1)}
.toast__icon{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--terracotta);color:var(--ink)}
.toast__text{flex:1}
.toast__close{border:0;background:none;color:rgba(249,249,247,0.6);cursor:pointer;display:grid;place-items:center;padding:4px;border-radius:6px}
.toast__close:hover{color:#F9F9F7;background:rgba(249,249,247,0.1)}

/* Skeleton: the website's sheen. */
.skel{display:flex;flex-direction:column;gap:12px}
.sk{position:relative;overflow:hidden;background:var(--ink-06);border-radius:8px}
.sk::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(249,249,247,0.8),transparent);animation:shimmer 1.4s ease-in-out infinite}
.sk--title{height:22px;width:40%}
.sk--row{height:44px;border-radius:10px}
@keyframes shimmer{to{transform:translateX(100%)}}

/* Customer texts: the preview as a message bubble on a phone-coloured strip. */
.textPreview{background:#E9E9EB;border:0;border-radius:18px 18px 18px 6px;color:var(--text)}
@media (prefers-reduced-motion:reduce){
  .sk::after,.toast,.dialog,.dialogBackdrop{animation:none}
  .motionBtn__fill,.progress__bar span{transition:none}
}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
