// snapshot.json -> data.json (compact, no beneficiary fields). Rules:
// - @dhwaniris.com owners/users are internal test accounts: excluded everywhere
// - dates use `creation` as stored (server time = IST); never pass through JS Date
// - field user = holds a "<form doctype> - Full Access" role for one of the 25 forms
// - activity status from last submission; mobile app writes no login rows, so logins are internal-only
const fs = require("fs"), path = require("path");
const s = require("./snapshot.json");
// Go-live: nothing before this date counts (Akshat, 2026-11-04)
const GO_LIVE = process.env.GO_LIVE || "2026-07-01";
// Partners not onboarded yet: hidden everywhere (records, users, grants)
const EXCLUDE_NGOS = new Set((process.env.EXCLUDE_NGOS || "NGO-0176").split(",").map(x => x.trim()).filter(Boolean)); // NGO-0176 = CINI
const exclUsers = new Set(s.user_ngo.filter(r => EXCLUDE_NGOS.has(r.for_value)).map(r => r.user));
const isInternal = e => /@dhwaniris\.com$/i.test(e || "") || e === "Administrator" || e === "Guest";
const today = s.pulled_at ? null : null; // set below from IST clock
const ist = new Date(Date.parse(s.pulled_at) + 5.5 * 3600e3).toISOString(); // time of the production pull, in IST
const TODAY = ist.slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

const ngoName = Object.fromEntries(s.ngos.map(n => [n.name, n.ngo_name]));
const partners = []; const pIdx = {};
const P = id => { id = id || "(none)"; if (!(id in pIdx)) { pIdx[id] = partners.length; partners.push({ id, name: ngoName[id] || id }); } return pIdx[id]; };

// forms catalogue
const formsCat = s.forms.map(f => ({ form: f.form, doctype: f.doctype, pillar: f.pillar, programme: f.programme, has_status: f.has_status }));
const roleToForm = Object.fromEntries(s.forms.map((f, i) => [f.doctype + " - Full Access", i]));

// facts: day x form x partner x status x channel
const days = []; const dIdx = {};
const D = d => { if (!(d in dIdx)) { dIdx[d] = days.length; days.push(d); } return dIdx[d]; };
const factMap = new Map(); const hourly = Array(24).fill(0);
const userRec = {}; // email -> {n, first, last, last30, forms:Set, partner}
const uList = s.users.filter(u => !isInternal(u.name) && !exclUsers.has(u.name)); const uIdx = Object.fromEntries(uList.map((u, i) => [u.name, i]));
let total = 0;
s.forms.forEach((f, fi) => f.rows.forEach(([owner, partner, c, st, ch]) => {
  if (isInternal(owner) || EXCLUDE_NGOS.has(partner) || exclUsers.has(owner) || c < GO_LIVE) return;
  total++;
  const day = c.slice(0, 10), sc = st === "Review" ? 1 : st === "Approved" ? 2 : st ? 3 : 0;
  const key = [D(day), fi, P(partner), sc, ch === "Mobile" ? 1 : 0, uIdx[owner] ?? -1].join(",");
  factMap.set(key, (factMap.get(key) || 0) + 1);
  hourly[+c.slice(11, 13)]++;
  const u = userRec[owner] || (userRec[owner] = { n: 0, first: day, last: day, n30: 0, n7: 0, forms: new Set(), partners: {} });
  u.n++; if (day < u.first) u.first = day; if (day > u.last) u.last = day;
  if (dayDiff(day, TODAY) < 30) u.n30++; if (dayDiff(day, TODAY) < 7) u.n7++;
  u.forms.add(fi); u.partners[partner] = (u.partners[partner] || 0) + 1;
}));
const facts = [...factMap].map(([k, n]) => [...k.split(",").map(Number), n]); // [day, form, partner, status, mobile, user, count]

// users
const prof = {}; s.user_profiles.forEach(r => (prof[r.parent] = prof[r.parent] || []).push(r.role_profile));
const unGo = {}; s.user_ngo.forEach(r => (unGo[r.user] = unGo[r.user] || []).push(r.for_value));
const access = {}; s.has_role.forEach(r => { if (r.role in roleToForm) (access[r.parent] = access[r.parent] || new Set()).add(roleToForm[r.role]); });
// "Login As": Frappe writes a Login Success for the impersonated user. A genuine sign-in is a Login Success
// not within 5 s of an Impersonate entry for that user. Sessions run until that user's next Logout (max 12 h).
const ms = t => Date.parse(t.replace(" ", "T") + "Z");
const impBy = {}; (s.impersonations || []).forEach(x => (impBy[x.user] = impBy[x.user] || []).push(ms(x.creation)));
const logoutBy = {}; (s.logouts || []).forEach(x => (logoutBy[x.user] = logoutBy[x.user] || []).push(ms(x.creation)));
const impWindows = u => (impBy[u] || []).map(t0 => { const lo = (logoutBy[u] || []).filter(t => t > t0).sort((a, b) => a - b)[0]; return [t0, Math.min(lo || Infinity, t0 + 12 * 3600e3)]; });
const inImp = (u, t) => impWindows(u).some(([a, b]) => t >= a - 5000 && t <= b);
const genuine = s.logins.filter(l => l.creation >= GO_LIVE && l.status === "Success" && !(impBy[l.user] || []).some(t => Math.abs(ms(l.creation) - t) <= 5000));
const loginsOk = {}, lastLogin = {}; genuine.forEach(l => { loginsOk[l.user] = (loginsOk[l.user] || 0) + 1; if (!lastLogin[l.user] || l.creation > lastLogin[l.user]) lastLogin[l.user] = l.creation; });
const users = uList.map(u => {
  const r = userRec[u.name];
  const ngo = (unGo[u.name] || [])[0] || (r ? Object.entries(r.partners).sort((a, b) => b[1] - a[1])[0][0] : null);
  const acc = access[u.name] ? [...access[u.name]] : [];
  let status;
  if (!u.enabled) status = "disabled";
  else if (r) { const g = dayDiff(r.last, TODAY); status = g <= 7 ? "active" : g <= 21 ? "slowing" : "quiet"; }
  // Logged in = a genuine sign-in, or platform activity that is not inside a "Login As" session
  else if (acc.length) status = (loginsOk[u.name] || (u.last_active && !inImp(u.name, ms(u.last_active)))) ? "opened" : "never";
  else status = "admin";
  return {
    e: u.name, nm: u.full_name || u.name, p: P(ngo), pr: (prof[u.name] || []).join(", "), acc, st: status,
    n: r ? r.n : 0, n30: r ? r.n30 : 0, n7: r ? r.n7 : 0, first: r ? r.first : null, last: r ? r.last : null,
    la: u.last_active && !(!r && inImp(u.name, ms(u.last_active))) ? u.last_active.slice(0, 16) : null, ll: lastLogin[u.name] ? lastLogin[u.name].slice(0, 16) : null, imp: (impBy[u.name] || []).length,
    cr: u.creation.slice(0, 10), lg: loginsOk[u.name] || 0, used: r ? [...r.forms] : []
  };
});
// records by owners with no User row (shouldn't happen) - reconciliation only
const orphanOwners = Object.keys(userRec).filter(e => !s.users.find(u => u.name === e));

// logins (internal panel)
const loginDays = {}; s.logins.forEach(l => { if (isInternal(l.user)) return; const d = l.creation.slice(0, 10); const o = loginDays[d] || (loginDays[d] = [0, 0]); o[l.status === "Success" ? 0 : 1]++; });

// grants side, joined by partner
const byGaf = (arr, k = "project_proposal") => { const m = {}; arr.forEach(x => (m[x[k]] = m[x[k]] || []).push(x)); return m; };
const tr = byGaf(s.tranches), outs = byGaf(s.outputs), outc = byGaf(s.outcomes), rep = byGaf(s.reporting);
const comp = byGaf(s.compliance, "grant"), bud = byGaf(s.budget, "grant");
const grantByProject = Object.fromEntries(s.grants.map(g => [g.project, g]));
const grants = s.gafs.filter(g => !EXCLUDE_NGOS.has(g.ngo)).map(g => {
  const gr = grantByProject[g.project] || s.grants.find(x => x.ngo === g.ngo) || {};
  const c = comp[gr.name] || [], b = bud[gr.name] || [];
  const cs = { Planned: 0, Due: 0, Overdue: 0, Submitted: 0, OverdueAtLoad: 0, OverdueSince: 0 };
  c.forEach(x => { if (x.workflow_state === "Submitted") cs.Submitted++; else { cs[x.submission_status] = (cs[x.submission_status] || 0) + 1; if (x.submission_status === "Overdue") { if (x.due_date < x.creation.slice(0, 10)) cs.OverdueAtLoad++; else cs.OverdueSince++; } } });
  return {
    gaf: g.name, grant: gr.name || null, name: g.project_name, p: P(g.ngo), focus: g.focus_area, donor: g.donor_name,
    wf: g.workflow_state, stage: g.stage, gstatus: gr.grant_status || null, budget: g.total_planned_budget,
    start: g.project_start_date, end: g.project_end_date,
    tranches: (tr[g.name] || []).length, tranche_sum: (tr[g.name] || []).reduce((a, x) => a + (x.total_funds_planned || 0), 0),
    outputs: (outs[g.name] || []).length, outcomes: (outc[g.name] || []).length, reports_cfg: (rep[g.name] || []).length,
    comp: cs, comp_list: c.filter(x => x.submission_status === "Overdue" && x.workflow_state !== "Submitted").map(x => [x.report_name, x.due_date, x.due_date < x.creation.slice(0, 10) ? 1 : 0, x.creation.slice(0, 10)]).sort((a, b) => a[1] < b[1] ? -1 : 1),
    planned: b.reduce((a, x) => a + (x.total_planned_budget || 0), 0), utilised: b.reduce((a, x) => a + (x.total_utilisation || 0), 0)
  };
});
const dd = s.dd.filter(x => !EXCLUDE_NGOS.has(x.ngo)).map(x => ({ id: x.name, p: P(x.ngo), st: x.workflow_state, cr: x.creation.slice(0, 10) }));

// ---- governance ----
const byOwner = arr => Object.fromEntries((arr || []).map(x => [x.owner || x.user, x]));
const routeBy = byOwner(s.route_by_user), verBy = byOwner(s.versions_by_owner), comBy = byOwner(s.comments_by_owner);
const rolesOf = {}; [...(s.admin_roles || []), ...(s.approver_roles || [])].forEach(r => (rolesOf[r.parent] = rolesOf[r.parent] || new Set()).add(r.role));
// client team = Amazon staff accounts
const clientTeam = s.users.filter(u => /@amazon\.com$/i.test(u.name)).map(u => ({
  e: u.name, nm: u.full_name || u.name, enabled: u.enabled, cr: u.creation.slice(0, 10),
  logins: loginsOk[u.name] || 0, ll: lastLogin[u.name] ? lastLogin[u.name].slice(0, 16) : null,
  views: routeBy[u.name] ? routeBy[u.name].n : 0, lastView: routeBy[u.name] ? String(routeBy[u.name].last).slice(0, 16) : null,
  edits: verBy[u.name] ? verBy[u.name].n : 0, comments: comBy[u.name] ? comBy[u.name].n : 0,
  la: u.last_active ? u.last_active.slice(0, 16) : null,
  sysmgr: !!(rolesOf[u.name] && rolesOf[u.name].has("System Manager")), impersonate: !!(rolesOf[u.name] && rolesOf[u.name].has("Impersonate User")),
  approver: !!(rolesOf[u.name] && [...rolesOf[u.name]].some(r => /Approver/.test(r)))
}));
// who can approve each form (Review -> Approved needs "<doctype> - Approver")
const enabledUser = Object.fromEntries(s.users.map(u => [u.name, u.enabled]));
const approvers = {}; (s.approver_roles || []).forEach(r => { if (!enabledUser[r.parent]) return; const m = /^(.*) - Approver$/.exec(r.role); if (m) (approvers[m[1]] = approvers[m[1]] || new Set()).add(r.parent); });
const formApprovers = s.forms.map(f => [...(approvers[f.doctype] || [])]);
const impersonations = (s.impersonations || []).map(x => ({ user: x.user, by: x.owner, at: x.creation.slice(0, 16) }));

const out = {
  go_live: GO_LIVE,
  refresh_note: process.env.REFRESH_NOTE || "Snapshot, refreshed on request",
  pulled_at_ist: ist.slice(0, 16).replace("T", " "), today: TODAY, site: s.site,
  partners, forms: formsCat, days, facts, hourly, users, grants, dd, loginDays,
  loaded_on: s.compliance.map(x => x.creation.slice(0, 10)).sort()[0] || null,
  clientTeam, formApprovers,
  retention: Object.fromEntries((s.log_retention || []).map(x => [x.dt, x.days])),
  logStart: s.logins.map(l => l.creation).sort()[0] ? s.logins.map(l => l.creation).sort()[0].slice(0, 10) : null,
  internal: { impersonations, error_log_30d: s.error_log_30d, failed_logins: s.logins.filter(l => l.status !== "Success" && !isInternal(l.user)).length }
};
fs.writeFileSync("data.json", JSON.stringify(out));

// reconciliation
const sumFacts = facts.reduce((a, f) => a + f[6], 0);
const prev = days.indexOf("2026-11-03");
console.log("total", total, "facts sum", sumFacts, "user sum", Object.values(userRec).reduce((a, u) => a + u.n, 0));
console.log("3 Nov", facts.filter(f => f[0] === prev).reduce((a, f) => a + f[6], 0), "facts rows", facts.length, "unmapped user rows", facts.filter(f => f[5] < 0).length);
console.log("orphan owners", orphanOwners);
const cnt = {}; users.forEach(u => cnt[u.st] = (cnt[u.st] || 0) + 1); console.log("user status", cnt, "users", users.length);
console.log("compliance", grants.map(g => partners[g.p].name.slice(0, 18) + " " + JSON.stringify(g.comp) + " util " + g.utilised + "/" + g.planned).join("\n"));
console.log("data.json KB", (fs.statSync("data.json").size / 1024).toFixed(0));
