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

// ─── Screens ──────────────────────────────────────────────────────────────────
function Wordmark() {
  return h("div", { className: "wordmark" },
    "fleetr", h("span", { className: "wordmarkHq" }, "hq"));
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

  return h("div", { className: "loginWrap" },
    h("div", { className: "loginCard" },
      h("div", { className: "accentBar", "aria-hidden": "true" },
        h("span", { style: { background: "var(--terracotta)" } }),
        h("span", { style: { background: "var(--periwinkle)" } }),
        h("span", { style: { background: "var(--green)" } })),
      h(Wordmark),
      h("div", { className: "loginSubtitle" }, "Platform admins only."),
      h("form", { className: "loginForm", onSubmit: handleSubmit },
        h("label", { className: "loginLabel", htmlFor: "email" }, "Email"),
        h("input", {
          id: "email", className: "loginInput", type: "email", required: true,
          autoComplete: "username", value: email,
          onChange: (e) => { setEmail(e.target.value); setError(""); },
        }),
        h("label", { className: "loginLabel", htmlFor: "password" }, "Password"),
        h("input", {
          id: "password", className: "loginInput", type: "password", required: true,
          maxLength: PASSWORD_MAX, autoComplete: "current-password", value: password,
          onChange: (e) => { setPassword(e.target.value); setError(""); },
        }),
        h("button", { type: "submit", className: "loginBtn", disabled: loading },
          loading ? "Signing in…" : "Sign in"),
        error && h("div", { className: "loginError", role: "alert" }, error))));
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
function useHashRoute() {
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const m = hash.match(/^#\/company\/([^/?#]+)$/);
  return m ? { name: "company", id: decodeURIComponent(m[1]) } : { name: "list" };
}

// ─── Screens: signed in ───────────────────────────────────────────────────────
const STATUS_LABELS = { trial: "Trial", active: "Active", suspended: "Suspended" };

function StatusBadge({ status }) {
  return h("span", { className: `badge badge-${STATUS_LABELS[status] ? status : "unknown"}` },
    STATUS_LABELS[status] || status || "Unknown");
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

  return h("form", { className: "newCompany", onSubmit: handleSubmit },
    h("label", { className: "loginLabel", htmlFor: "newCompanyName" }, "Company name"),
    h("div", { className: "newCompanyRow" },
      h("input", {
        id: "newCompanyName", className: "loginInput", type: "text", autoFocus: true,
        maxLength: 200, value: name, disabled: saving,
        onChange: (e) => { setName(e.target.value); setError(""); },
        onKeyDown: (e) => { if (e.key === "Escape") onCancel(); },
      }),
      h("button", { type: "submit", className: "primaryBtn", disabled: saving },
        saving ? "Creating…" : "Create"),
      h("button", { type: "button", className: "linkBtn", onClick: onCancel, disabled: saving }, "Cancel")),
    error && h("div", { className: "loginError", role: "alert" }, error));
}

function CompanyListScreen({ companies, onCreated }) {
  const [creating, setCreating] = React.useState(false);

  return h(React.Fragment, null,
    h("div", { className: "titleRow" },
      h("h1", { className: "pageTitle" }, "Companies"),
      !creating && h("button", { type: "button", className: "primaryBtn", onClick: () => setCreating(true) },
        "New Company")),
    creating && h(NewCompanyForm, {
      onCreated: (company) => { onCreated(company); setCreating(false); },
      onCancel: () => setCreating(false),
    }),
    companies.length === 0
      ? h("p", { className: "muted" }, "No companies yet.")
      : h("div", { className: "tableWrap" },
          h("table", { className: "companyTable" },
            h("thead", null,
              h("tr", null,
                h("th", { scope: "col" }, "Name"),
                h("th", { scope: "col" }, "Status"),
                h("th", { scope: "col" }, "Plan"))),
            h("tbody", null,
              companies.map((c) => h("tr", { key: c.id },
                h("td", null,
                  h("a", { className: "companyLink", href: `#/company/${encodeURIComponent(c.id)}` }, c.name)),
                h("td", null, h(StatusBadge, { status: c.status })),
                h("td", null, c.planTier || h("span", { className: "muted" }, "Not set"))))))));
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
  return { ok: false, message: (json && json.message) || `The request failed (${res.status}).` };
}

// Hardcoded until there is a feature catalogue. A key with no company_features
// row is off, which is what the table's default means too.
const FEATURES = [
  { key: "ai_command_bar",      label: "AI command bar" },
  { key: "insurance_rentals",   label: "Insurance rentals" },
  { key: "damage_claims",       label: "Damage claims" },
  { key: "non_drive_intake",    label: "Non-drive intake" },
  { key: "pre_rental_check",    label: "Pre-rental check" },
  { key: "unknown_repair_date", label: "Unknown repair date" },
  { key: "no_shows",            label: "No-shows" },
  { key: "reports",             label: "Reports" },
  { key: "audit_log",           label: "Audit log" },
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

function FeatureToggle({ feature, enabled, pending, onToggle }) {
  const id = `feature-${feature.key}`;
  return h("div", { className: "featureRow" },
    h("label", { className: "featureLabel", htmlFor: id }, feature.label),
    h("div", { className: "featureControl" },
      h("span", { className: "featureState" }, pending ? "Saving…" : enabled ? "On" : "Off"),
      h("button", {
        id, type: "button", role: "switch", "aria-checked": enabled,
        className: `toggle${enabled ? " toggleOn" : ""}`, disabled: pending,
        onClick: onToggle,
      }, h("span", { className: "toggleKnob" }))));
}

function CompanyDetailScreen({ id, onUpdated }) {
  // undefined while loading; { error } when the load failed.
  const [loaded,   setLoaded]   = React.useState(undefined);
  const [draft,    setDraft]    = React.useState(null);
  const [saving,   setSaving]   = React.useState(false);
  const [saveMsg,  setSaveMsg]  = React.useState(null);   // { ok, text }
  const [features, setFeatures] = React.useState({});
  const [pending,  setPending]  = React.useState({});
  const [featErr,  setFeatErr]  = React.useState("");

  React.useEffect(() => {
    let live = true;
    setLoaded(undefined);
    setSaveMsg(null);
    setFeatErr("");
    adminRequest(`/admin/companies/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (!r.ok) { setLoaded({ error: r.message }); return; }
      setLoaded({ company: r.body.company });
      setDraft(toDraft(r.body.company));
      setFeatures(Object.fromEntries((r.body.features || []).map((f) => [f.featureKey, f.enabled === true])));
    });
    return () => { live = false; };
  }, [id]);

  const back = h("a", { className: "linkBtn backLink", href: "#/" }, "Back to companies");
  if (loaded === undefined) return h(React.Fragment, null, back, h("p", { className: "muted" }, "Loading…"));
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
        setSaveMsg({ ok: true, text: "Saved." });
        onUpdated(r.body.company);
      })
      .finally(() => setSaving(false));
  };

  const toggle = (key) => {
    const next = !features[key];
    setPending({ ...pending, [key]: true });
    setFeatErr("");
    adminRequest(`/admin/companies/${encodeURIComponent(id)}/features/${encodeURIComponent(key)}`,
      { method: "PUT", body: { enabled: next } })
      .then((r) => {
        if (!r.ok) { setFeatErr(r.message); return; }
        // The switch shows what the Worker stored, not what was requested.
        setFeatures((f) => ({ ...f, [key]: r.body.feature && r.body.feature.enabled === true }));
      })
      .finally(() => setPending((p) => ({ ...p, [key]: false })));
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

  return h(React.Fragment, null,
    back,
    h("div", { className: "titleRow" },
      h("h1", { className: "pageTitle" }, company.name),
      h(StatusBadge, { status: company.status })),

    h("section", { className: "detailSection" },
      h("h2", { className: "sectionTitle" }, "Details"),
      h("form", { onSubmit: save, noValidate: true },
        h("div", { className: "detailGrid" }, DETAIL_FIELDS.map(field)),
        h("div", { className: "detailField" },
          h("span", { className: "loginLabel" }, "Join code"),
          h("div", { className: "readOnlyValue" }, company.joinCode || h("span", { className: "muted" }, "None"))),
        h("div", { className: "saveRow" },
          h("button", { type: "submit", className: "primaryBtn", disabled: saving || !dirty },
            saving ? "Saving…" : "Save"),
          !dirty && !saveMsg && h("span", { className: "muted" }, "No changes")),
        saveMsg && h("div", { className: saveMsg.ok ? "successMsg" : "loginError", role: "status" }, saveMsg.text))),

    h("section", { className: "detailSection" },
      h("h2", { className: "sectionTitle" }, "Features"),
      FEATURES.map((f) => h(FeatureToggle, {
        key: f.key, feature: f, enabled: features[f.key] === true, pending: pending[f.key] === true,
        onToggle: () => toggle(f.key),
      })),
      featErr && h("div", { className: "loginError", role: "alert" }, featErr)));
}

function SignedInShell({ companies, onCreated, onUpdated, onSignOut }) {
  const route = useHashRoute();
  const signOut = () => {
    // So the next sign-in starts on the list, not on whichever company was open.
    if (window.location.hash) window.location.hash = "";
    onSignOut();
  };
  return h("div", { className: "page" },
    h("header", { className: "pageHeader" },
      h("a", { href: "#/", className: "homeLink" }, h(Wordmark)),
      h("button", { type: "button", className: "linkBtn", onClick: signOut }, "Sign out")),
    h("main", { className: "pageBody" },
      route.name === "company"
        ? h(CompanyDetailScreen, { id: route.id, onUpdated })
        : h(CompanyListScreen, { companies, onCreated })));
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
    onSignOut: signOut,
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Tokens live in index.html. Accents carry black text, never white: none of the
// three reaches a readable contrast against white at body sizes.
const css = `
.wordmark{font-size:1.75rem;font-weight:700;letter-spacing:-0.02em}
.wordmarkHq{font-weight:500;color:var(--muted);margin-left:6px}
.muted{color:var(--muted)}

.loginWrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.loginCard{position:relative;width:100%;max-width:380px;padding:36px 28px 28px;
  border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;text-align:center}
.accentBar{position:absolute;top:0;left:0;right:0;display:flex;height:4px}
.accentBar span{flex:1}
.loginSubtitle{color:var(--muted);font-size:0.9rem;margin:4px 0 24px}
.loginForm{display:flex;flex-direction:column;text-align:left}
.loginLabel{font-size:0.8rem;font-weight:600;margin:0 0 6px}
.loginInput{font:inherit;color:var(--text);background:var(--bg);padding:10px 12px;margin-bottom:16px;
  border:1px solid var(--border);border-radius:8px}
.loginInput:focus{outline:2px solid var(--periwinkle);outline-offset:1px;border-color:var(--periwinkle)}
.loginBtn{font:inherit;font-weight:600;color:#000;background:var(--periwinkle);border:0;
  border-radius:999px;padding:11px;cursor:pointer;margin-top:4px}
.loginBtn:hover{filter:brightness(1.05)}
.loginBtn:focus-visible{outline:2px solid #000;outline-offset:2px}
.loginBtn:disabled{opacity:0.6;cursor:default}
.loginError{margin-top:16px;padding:10px 12px;font-size:0.9rem;font-weight:500;
  background:rgba(244,132,95,0.14);border-left:3px solid var(--terracotta);border-radius:6px}

.page{max-width:880px;margin:0 auto;padding:24px}
.pageHeader{display:flex;align-items:center;justify-content:space-between;
  padding-bottom:16px;border-bottom:2px solid var(--green)}
.pageBody{padding-top:24px}
.pageTitle{font-size:1.25rem;font-weight:600;margin:0 0 16px}
.linkBtn{font:inherit;font-weight:500;color:var(--text);background:none;border:0;cursor:pointer;
  text-decoration:underline;text-decoration-color:var(--periwinkle);text-decoration-thickness:2px;
  text-underline-offset:4px}
.linkBtn:disabled{opacity:0.5;cursor:default}
.homeLink{color:inherit;text-decoration:none}
.backLink{display:inline-block;margin-bottom:16px}

.titleRow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.titleRow .pageTitle{margin:0}
.primaryBtn{font:inherit;font-weight:600;color:#000;background:var(--periwinkle);border:0;
  border-radius:999px;padding:9px 18px;cursor:pointer;white-space:nowrap}
.primaryBtn:hover{filter:brightness(1.05)}
.primaryBtn:focus-visible{outline:2px solid #000;outline-offset:2px}
.primaryBtn:disabled{opacity:0.6;cursor:default}

.newCompany{margin-bottom:24px;padding:16px;border:1px solid var(--border);border-radius:var(--radius)}
.newCompanyRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.newCompanyRow .loginInput{flex:1;min-width:200px;margin:0}
.newCompany .loginError{margin-top:12px}

.tableWrap{overflow-x:auto}
.companyTable{width:100%;border-collapse:collapse}
.companyTable th{text-align:left;font-size:0.75rem;font-weight:600;text-transform:uppercase;
  letter-spacing:0.04em;color:var(--muted);padding:0 12px 10px;border-bottom:1px solid var(--border)}
.companyTable td{padding:12px;border-bottom:1px solid var(--border);vertical-align:middle}
.companyTable th:first-child,.companyTable td:first-child{padding-left:0}
.companyTable tbody tr:hover{background:rgba(123,147,255,0.06)}
.companyLink{color:var(--text);font-weight:500;text-decoration:none}
.companyLink:hover,.companyLink:focus-visible{text-decoration:underline;
  text-decoration-color:var(--periwinkle);text-decoration-thickness:2px;text-underline-offset:4px}

.badge{display:inline-block;font-size:0.8rem;font-weight:500;padding:2px 10px;border-radius:999px;
  border:1px solid transparent}
.badge-trial{background:rgba(123,147,255,0.16);border-color:var(--periwinkle)}
.badge-active{background:rgba(107,203,119,0.18);border-color:var(--green)}
.badge-suspended{background:rgba(244,132,95,0.16);border-color:var(--terracotta)}
.badge-unknown{background:rgba(0,0,0,0.05);border-color:var(--border)}

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
.toggle{position:relative;width:44px;height:24px;border-radius:999px;border:1px solid rgba(0,0,0,0.25);
  background:rgba(0,0,0,0.08);cursor:pointer;padding:0;transition:background .15s,border-color .15s}
.toggleOn{background:var(--green);border-color:var(--green)}
.toggleKnob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.3);transition:transform .15s}
.toggleOn .toggleKnob{transform:translateX(20px)}
.toggle:focus-visible{outline:2px solid var(--periwinkle);outline-offset:2px}
.toggle:disabled{opacity:0.6;cursor:default}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
