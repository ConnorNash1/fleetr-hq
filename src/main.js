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

// Placeholder. Names as plain text, nothing else, until the real list is built.
function CompanyListScreen({ companies, onSignOut }) {
  return h("div", { className: "page" },
    h("header", { className: "pageHeader" },
      h(Wordmark),
      h("button", { type: "button", className: "linkBtn", onClick: onSignOut }, "Sign out")),
    h("main", { className: "pageBody" },
      h("h1", { className: "pageTitle" }, "Company list"),
      companies.length === 0
        ? h("p", { className: "muted" }, "No companies yet.")
        : h("ul", { className: "plainList" },
            companies.map((c) => h("li", { key: c.id }, c.name)))));
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
  return h(CompanyListScreen, { companies, onSignOut: signOut });
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
.plainList{margin:0;padding:0;list-style:none;line-height:1.9}
.linkBtn{font:inherit;font-weight:500;color:var(--text);background:none;border:0;cursor:pointer;
  text-decoration:underline;text-decoration-color:var(--periwinkle);text-decoration-thickness:2px;
  text-underline-offset:4px}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
