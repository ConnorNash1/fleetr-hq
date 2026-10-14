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
      // A short terracotta light runs round the edge of the card, one side
      // after the next. Still, as a plain top bar, for reduced motion.
      h("div", { className: "loginBeams", "aria-hidden": "true" },
        h("span", { className: "loginBeam loginBeam--top" }),
        h("span", { className: "loginBeam loginBeam--right" }),
        h("span", { className: "loginBeam loginBeam--bottom" }),
        h("span", { className: "loginBeam loginBeam--left" })),
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
  const m = hash.match(/^#\/company\/([^/?#]+)$/);
  return m ? { name: "company", id: decodeURIComponent(m[1]) } : { name: "list" };
}

// ─── Screens: signed in ───────────────────────────────────────────────────────
const STATUS_LABELS = { trial: "Trial", active: "Active", suspended: "Suspended" };

function StatusBadge({ status }) {
  return h("span", { className: `badge badge-${STATUS_LABELS[status] ? status : "unknown"}` },
    STATUS_LABELS[status] || status || "Unknown");
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
                h("th", { scope: "col" }, "Setup"),
                h("th", { scope: "col" }, "Plan"))),
            h("tbody", null,
              companies.map((c) => h("tr", { key: c.id },
                h("td", null,
                  h("a", { className: "companyLink", href: `#/company/${encodeURIComponent(c.id)}` }, c.name)),
                h("td", null, h(StatusBadge, { status: c.status })),
                h("td", null, setupStateLabel(c)),
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
  vehicle_classes:       "Vehicle classes",
  rates:                 "A daily rate for every vehicle class",
  vehicles:              "A vehicle at the default branch",
  protection:            "Protection and deductibles",
  contract:              "Contract terms",
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
    case "vehicle_classes":   return "None added.";
    case "rates":             return list.length ? `No rate for: ${list.join(", ")}.` : "No vehicle classes yet.";
    case "vehicles":          return "No vehicle with one of the company's classes at its default branch.";
    case "protection":        return list.length ? `Missing a price or decline wording: ${list.join(", ")}.` : "None added.";
    case "contract":          return "Not saved yet.";
    case "listing":           return list.length ? `Incomplete: ${list.join(", ")}.` : "No branch is listed.";
    case "staff":             return "Only the Exec so far.";
    case "test_rentals_finished": return `Still open: ${list.join(", ")}.`;
    default:                  return "";
  }
}

function SetupItem({ item }) {
  return h("li", { className: "setupItem" },
    h("span", { className: item.done ? "setupDone" : "setupLeft" }, item.done ? "Done" : item.skipped ? "Skip" : "Left"),
    h("span", null, SETUP_ITEMS[item.key] || item.key),
    !item.done && h("span", { className: "muted" }, ` ${setupReason(item)}`));
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
    if (state === undefined) return h("p", { className: "muted" }, "Loading…");
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
    return h(React.Fragment, null,
      h("p", null, where),
      h("h3", { className: "setupHeading" }, "Required before launch"),
      h("ul", { className: "setupList" }, required.map((i) => h(SetupItem, { key: i.key, item: i }))),
      h("h3", { className: "setupHeading" }, "Optional"),
      h("ul", { className: "setupList" }, optional.map((i) => h(SetupItem, { key: i.key, item: i }))));
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
        setActMsg(approve ? `${person.name} is now the Exec.`
          : r.body.removed ? `${person.name}'s sign-up was declined.`
          : `${person.name}'s sign-up was declined. Their account is kept, deactivated, because records point at it.`);
        refresh();
      })
      .finally(() => setBusyId(null));
  };

  const body = () => {
    if (state === undefined) return h("p", { className: "muted" }, "Loading…");
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
                    h("td", null, s.name, h("div", { className: "muted" }, s.username)),
                    h("td", null, s.recoveryEmail || h("span", { className: "muted" }, "None")),
                    h("td", null, s.role),
                    h("td", null, branchName(s)),
                    h("td", null, pending ? "Pending" : s.active ? "Approved" : "Approved, deactivated"),
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
          setFeatMsg(`Saved ${saved.length} ${saved.length === 1 ? "change" : "changes"}.`);
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

    h(SetupProgress, { key: setupKey, id }),

    h(CompanyStaff, { id, company, onChanged: () => setSetupKey((n) => n + 1) }),

    h("section", { className: "detailSection" },
      h("h2", { className: "sectionTitle" }, "Features"),
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

    h(DeleteCompany, { id, company, onDeleted }));
}

// ─── Customer texts ───────────────────────────────────────────────────────────
// fleetr's five customer texts, the same for every company
// (fleetr_message_templates). Each shows with sample values filled in, the
// parts the texting Worker adds after the wording, and its footer, then its
// length and how many message parts it is sent as. The preview mirrors
// worker.js (fleetr-infra): fillTemplate, codeSuffix, appSuffix,
// cancelSuffix, rescheduleSuffix, footerLine, isGsm7 and gsm7Length. If the
// Worker's copy changes, change this one. The tokens are stand-ins of the real
// length, so the count is the real count.
const TEXT_SAMPLE = {
  "[first name]": "Alex", "[company]": "Avalon Rentals", "[location]": "40 Harbour Dr",
  "[date]": "Oct 6", "[time]": "10:00 AM",
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
};
const TEXT_KINDS = [
  { kind: "confirmation", title: "Reservation confirmation", when: "Sent when a reservation is made.",
    parts: [TEXT_PART.code, TEXT_PART.app, TEXT_PART.cancel] },
  // The pre-rental never carried the code: it is only where it is placed.
  { kind: "pre_rental", title: "Pre-rental", when: "Sent the day before pickup.",
    parts: [{ ...TEXT_PART.code, tail: "" }, TEXT_PART.app, TEXT_PART.cancel] },
  { kind: "no_show_2hr", title: "No-show, after 2 hours", when: "Sent 2 hours after the pickup time when the customer has not arrived. [time] is the pickup time.",
    parts: [TEXT_PART.change] },
  { kind: "no_show_24hr", title: "No-show, the next day", when: "Sent a day after the 2 hour text, if the customer still has not arrived.",
    parts: [TEXT_PART.change] },
  // The fuel note goes straight after the wording, when the fuel level at
  // pickup is known.
  { kind: "return_reminder", title: "Return reminder", when: "Sent the day before a rental is due back. [date] and [time] are when it is due back.",
    fuel: " Return fuel at Full to avoid a charge.",
    parts: [{ ...TEXT_PART.app, tail: TEXT_LINK("When you return, open the app to check the vehicle in:", "a") }] },
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
const fillText = (body) => String(body).replace(/\[(first name|company|location|date|time)\]/gi, (m) => TEXT_SAMPLE[m.toLowerCase()]);
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

  if (saved === undefined) return h("p", { className: "muted" }, "Loading…");
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
      setNotes((p) => ({ ...p, [k.kind]: { ok: true, text: "Saved. Every company sends this wording from now on." } }));
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
      const allowed = [...TEXT_PLACEHOLDERS.map(([, p]) => p), ...k.parts.map((p) => p.placeholder)];
      const unknown = (trimmed.match(/\[[^\][]*\]/g) || []).filter((ph) => !allowed.includes(ph.toLowerCase()));
      const repeated = k.parts.filter((p) => (trimmed.toLowerCase().split(p.placeholder).length - 1) > 1).map((p) => p.placeholder);
      const addsList = [k.fuel && "the fuel note", ...k.parts.filter((p) => p.tail && placed.tail.includes(p.tail)).map((p) => `the ${p.label.toLowerCase()}`)].filter(Boolean);
      const addsWords = addsList.length > 1 ? [`${addsList.slice(0, -1).join(", ")} and ${addsList[addsList.length - 1]}`] : addsList;
      const note = notes[k.kind];
      return h("section", { key: k.kind, className: "detailSection" },
        h("h2", { className: "sectionTitle" }, k.title),
        h("p", { className: "muted textWhen" }, k.when),
        h("div", { className: "textInserts" },
          TEXT_PLACEHOLDERS.map(([label, ph]) => h("button", {
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

function SignedInShell({ companies, onCreated, onUpdated, onDeleted, onSignOut }) {
  const route = useHashRoute();
  const signOut = () => {
    if (!confirmLeave()) return;
    leaveGuard = null;
    // So the next sign-in starts on the list, not on whichever company was open.
    if (window.location.hash) window.location.hash = "";
    onSignOut();
  };
  return h("div", { className: "page" },
    h("header", { className: "pageHeader" },
      h("a", { href: "#/", className: "homeLink" }, h(Wordmark)),
      h("nav", { className: "headerNav" },
        h("a", { href: "#/", className: `linkBtn${route.name === "texts" ? "" : " navOn"}` }, "Companies"),
        h("a", { href: "#/texts", className: `linkBtn${route.name === "texts" ? " navOn" : ""}` }, "Customer texts"),
        h("button", { type: "button", className: "linkBtn", onClick: signOut }, "Sign out"))),
    h("main", { className: "pageBody" },
      route.name === "texts" ? h(CustomerTextsScreen) :
      route.name === "company"
        ? h(CompanyDetailScreen, { id: route.id, onUpdated, onDeleted: (gone) => {
            // Nothing is left to save, so leave without asking.
            leaveGuard = null;
            onDeleted(gone);
            window.location.hash = "";
          } })
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
    onDeleted: (gone) => setCompanies((list) => list.filter((c) => c.id !== gone)),
    onSignOut: signOut,
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Tokens live in index.html: the neutral and terracotta palette of the staff
// app. Terracotta carries dark ink text, never white, which is not readable on
// it; text in terracotta uses the deeper --terracotta-text.
const css = `
.headerNav{display:flex;align-items:center;gap:18px}
.headerNav a{text-decoration:none}
.navOn{color:var(--terracotta-text)}
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
.wordmark{font-size:1.75rem;font-weight:700;letter-spacing:-0.02em}
.wordmarkHq{font-weight:500;color:var(--muted);margin-left:6px}
.muted{color:var(--muted)}
.setupHeading{font-size:0.95rem;margin:16px 0 6px}
.setupList{list-style:none;margin:0;padding:0}
.setupItem{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--border)}
.setupDone,.setupLeft{flex:0 0 44px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
.setupLeft{color:var(--muted)}
.staffActions{display:flex;gap:14px;flex-wrap:wrap;white-space:nowrap}

.loginWrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.loginCard{position:relative;width:100%;max-width:380px;padding:36px 28px 28px;background:var(--card);
  border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;text-align:center}
.loginCard{box-shadow:0 1px 2px rgba(31,30,29,0.05),0 12px 32px rgba(31,30,29,0.08)}
.loginBeams{position:absolute;inset:0;pointer-events:none;border-radius:inherit;overflow:hidden}
.loginBeam{position:absolute;display:block}
.loginBeam--top,.loginBeam--bottom{height:2px;width:45%}
.loginBeam--left,.loginBeam--right{width:2px;height:45%}
.loginBeam--top{top:0;left:-45%;background:linear-gradient(90deg,transparent,var(--terracotta));animation:beamTop 6s linear infinite}
.loginBeam--right{right:0;top:-45%;background:linear-gradient(180deg,transparent,var(--terracotta));animation:beamRight 6s linear infinite}
.loginBeam--bottom{bottom:0;right:-45%;background:linear-gradient(270deg,transparent,var(--terracotta));animation:beamBottom 6s linear infinite}
.loginBeam--left{left:0;bottom:-45%;background:linear-gradient(0deg,transparent,var(--terracotta));animation:beamLeft 6s linear infinite}
@keyframes beamTop{0%{left:-45%}25%,100%{left:100%}}
@keyframes beamRight{0%,25%{top:-45%}50%,100%{top:100%}}
@keyframes beamBottom{0%,50%{right:-45%}75%,100%{right:100%}}
@keyframes beamLeft{0%,75%{bottom:-45%}100%{bottom:100%}}
@media (prefers-reduced-motion:reduce){
  .loginBeam{animation:none}
  .loginBeam--top{left:0;width:100%;height:4px;background:var(--terracotta)}
  .loginBeam--right,.loginBeam--bottom,.loginBeam--left{display:none}
}
.loginSubtitle{color:var(--muted);font-size:0.9rem;margin:4px 0 24px}
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
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
