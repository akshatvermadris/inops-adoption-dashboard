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

// ---- CE Impact: framework indicators computed from production forms ----
// Follows the INOPS MBR Indicator Logic Sheet (Oct 2026), plus Akshat's decisions of 6 Nov 2026:
//  - month = MBR month by DATE OF ACTIVITY: 26th of the previous month to the 25th (a record dated the 26th or later
//    counts in the next month). Review status is ignored (all records count; the approved part is shown beside it).
//  - test rows are left out: entered or submitted from a dhwaniris.com account, or a whole-word test/tester/RMN
//    in a name or description field. (MBR rule: Dhwani uploads of partner Excel files are not counted as platform data.)
//  - A.3.1 also counts Social Entitlements Enrolment interactions (Akshat: awareness belongs in A.3.1; not in the MBR sheet).
// Goals and Page 0 figures are NOT on iNOPS: they come from goals.json (MBR goal columns / Page 0, loaded by hand).
let impact = null;
if (s.impact) {
  const G = require("./goals.json");
  // Goals live on iNOPS in MBR Manual Value (Goal Sheet rows, read by the P0 report); goals.json is the fallback.
  const liveGoals = (s.mbr_manual || []).filter(r => r.value_type === "Goal" && /^Q[1-4]$/.test(r.period) && +r.year === +TODAY.slice(0, 4));
  if (liveGoals.length) {
    G.goal_source = "MBR Manual Value on iNOPS (Goal Sheet rows), the same goals the P0 report uses";
    G.indicators.forEach(ind => { const q = {}; liveGoals.filter(r => r.indicator === ind.id).forEach(r => { q[r.period] = (q[r.period] || 0) + (+r.value || 0); }); if (Object.keys(q).length) { ind.goal_q = Object.assign({ Q1: 0, Q2: 0, Q3: 0, Q4: 0 }, q); ind.goal_fy = Object.values(ind.goal_q).reduce((a, b) => a + b, 0); } });
  }
  // October 2026 MBR used 1-25 Oct, so 26-30 Sep 2026 stays in September (MBR Common Rules: Reporting window).
  const mbr = d => { if (d >= "2026-09-26" && d <= "2026-09-30") return "2026-09"; let y = +d.slice(0, 4), m = +d.slice(5, 7); if (+d.slice(8, 10) >= 26) { m++; if (m > 12) { m = 1; y++; } } return y + "-" + String(m).padStart(2, "0"); };
  const FIRST_MONTH = mbr(GO_LIVE), LAST_MONTH = mbr(TODAY);
  const dateOf = r => (r.activity_date || r.creation || "").slice(0, 10);
  const MH_ACTIVITY = new Set(["KPI-00092", "KPI-00415", "KPI-01195", "KPI-03113"]); // the four menstrual hygiene Activities (MBR A.2.3)
  const MH_TERM = /\b(mens\w*|mhh?|mhm|hygiene|hygeine|pads?|sanitary|periods?|napkins?|puberty)\b/i; // = frappe_inops mbr_logic.MH_TERM
  const TEST_WORD = /\b(test|tester|rmn)\b/i;
  const SAM_CAP = 5000; // one Samriddhi mela visit above this is treated as an entry error
  const isMH = r => MH_ACTIVITY.has(r.activity) || MH_TERM.test(r.activity_description || "");
  // metric: [id, label, doctype, value(row)->number|null, indicator|null]
  const M = [
    ["ice_food", "ICE Form · Food Security sessions (Lives Impacted)", "ICE Form", r => r.thematic_area === "THEME-086" ? r.total_interactions : null, "A.1.1"],
    ["fd", "Pantry Distribution · total beneficiaries", "Food Distribution Form", r => r.bene_total, "A.1.5"],
    ["me_enrol", "Member Enrolment · members enrolled", "Member Enrolment", r => 1, "A.2.1"],
    ["ent", "Enterprise Master · enterprises registered", "Enterprise Master", r => 1, "A.2.2"],
    ["ice_mh", "ICE Form · menstrual hygiene sessions (MH Activity or MH term)", "ICE Form", r => r.thematic_area === "THEME-088" && isMH(r) ? r.total_interactions : null, "A.2.3"],
    ["mht", "MH Training · trainees attended", "Menstrual Hygiene Training", r => r.mh_trainees, "A.2.3"],
    ["ice_ss", "ICE Form · Social Security sessions (Lives Impacted)", "ICE Form", r => r.thematic_area === "THEME-068" ? r.total_interactions : null, "A.3.1"],
    ["hh_members", "Household Survey · household members", "Household Survey", r => r.member_count, "A.3.1"],
    ["seef_int", "Social Entitlements Enrolment · interactions", "Social Entitlements Enrolment Form", r => r.total_interactions, "A.3.1"],
    ["sa_app", "Scheme Application · applications (one per record)", "Scheme Application", r => 1, "A.3.2"],
    ["sam", "Samriddhi Mela · total enrolments", "Samridhi Mela Site Visit", r => { const v = r.total_enrollments ?? ((r.abha_enrollments || 0) + (r.pmjay_enrollments || 0)); return v > SAM_CAP ? null : v; }, "B.1.1"],
    // outcomes and programme activity (not framework lines)
    ["hh", "Households surveyed", "Household Survey", r => 1, null],
    ["hb", "Household beneficiaries enrolled", "Household Beneficiary", r => 1, null],
    ["sa_benefit", "Applications with benefit received (lifecycle)", "Scheme Application", r => r.lifecycle_status === "Benefit Received" ? 1 : null, null],
    ["seef_app", "Social Entitlements Enrolment · new applications started", "Social Entitlements Enrolment Form", r => r.new_applications_initiated, null],
    ["ice_liv_other", "ICE Form · other livelihood sessions (not counted in A.2.3)", "ICE Form", r => r.thematic_area === "THEME-088" && !isMH(r) ? r.total_interactions : null, null],
    ["mhc", "Women Champion Visit · women reached (not in MBR)", "Menstrual Hygiene Champion", r => r.mh_women_reached, null],
    ["van", "Period Van · people reached (not in MBR)", "Menstrual Hygiene Period Van", r => r.mh_van_reached, null],
    ["fr_items", "Pantry Collection · items collected", "Food Rescue Form", r => r.quantity, null],
    ["fr_value", "Pantry Collection · value collected (₹)", "Food Rescue Form", r => r.value, null],
    ["fd_items", "Pantry Distribution · items distributed", "Food Distribution Form", r => r.quantity, null],
    ["mch_anthro", "Children in monthly growth monitoring", "MCH Activity Form", r => r.children_anthropometry, null],
    ["mch_nrc", "Malnourished children referred to NRC / VCDC", "MCH Activity Form", r => r.children_malnourished_referred, null],
    ["mnp_meals", "Morning Nutrition · meals distributed", "Monthly Meal Donation Form", r => r.meals_distributed, null],
    ["mh_knowledge", "MH Training · trainees with improved knowledge", "Menstrual Hygiene Training", r => r.mh_improved_knowledge, null],
    ["pads", "Sanitary pads manufactured", "Sanitary Pad Unit Visit", r => r.mh_napkins_made, null],
    ["pad_rev", "Pad unit revenue (₹)", "Sanitary Pad Unit Visit", r => r.mh_revenue, null],
    ["me_packets", "Packets sold by micro-entrepreneurs", "Menstrual Hygiene Micro-Entrepreneur", r => r.mh_packets_sold, null],
    ["me_income", "Micro-entrepreneur income from sales (₹)", "Menstrual Hygiene Micro-Entrepreneur", r => r.mh_me_income, null],
    ["champions", "Women champions registered", "Champion", r => 1, null],
    ["mes", "Micro-entrepreneurs registered", "Micro-Entrepreneur Master", r => 1, null],
    ["units", "Pad manufacturing units", "Manufacturing Unit Master", r => 1, null],
    ["epv", "Enterprise progress visits", "Enterprise Progress Visit", r => 1, null]
  ];
  // Partner-file actuals entered on iNOPS in MBR Manual Value (the P0 report adds these to the platform figures)
  const IND_ALL = (G.indicators || []).map(x => x.id);
  IND_ALL.forEach(code => M.push(["file_" + code, "Partner file entered on iNOPS (MBR Manual Value)", "MBR Manual Value", null, code]));
  const months = [], mI = {}; const MI = k => (k in mI ? mI[k] : (mI[k] = months.push(k) - 1));
  const fm = new Map(); const dq = { rejected: 0, ice_unmapped: 0, ice_unmapped_lives: 0, sam_outliers: [], sa_status_conflict: 0, test_rows: 0, dhwani_rows: {}, outside_window: 0 };
  const recs = {}; // doctype -> rows after exclusions
  const testNames = Object.fromEntries(Object.entries(s.test_rows || {}).map(([k, v]) => [k, new Set(v)]));
  const isTest = (r, dt) => (testNames[dt] && testNames[dt].has(r.name)) || TEST_WORD.test([r.institution_name, r.activity_description].filter(Boolean).join(" "));
  const byDhwani = r => isInternal(r.owner) || /@dhwaniris\.com$/i.test(r.submitted_by || "");
  for (const [dt, blk] of Object.entries(s.impact)) {
    recs[dt] = blk.rows.map(a => Object.fromEntries(blk.fields.map((k, i) => [k, a[i]]))).filter(r => {
      if (!r.partner_name || EXCLUDE_NGOS.has(r.partner_name)) return false;
      const mm = mbr(dateOf(r)); if (mm < FIRST_MONTH || mm > LAST_MONTH) { dq.outside_window++; return false; }
      if (byDhwani(r)) { dq.dhwani_rows[dt] = (dq.dhwani_rows[dt] || 0) + 1; return false; }
      if (isTest(r, dt)) { dq.test_rows++; return false; }
      if (r.approval_status === "Rejected") dq.rejected++; // approval is ignored, as in the MBR (rejected records still count)
      return true;
    });
  }
  (recs["ICE Form"] || []).forEach(r => { if (!["THEME-086", "THEME-088", "THEME-068"].includes(r.thematic_area)) { dq.ice_unmapped++; dq.ice_unmapped_lives += r.total_interactions || 0; } });
  (recs["Samridhi Mela Site Visit"] || []).forEach(r => { if ((r.total_enrollments ?? ((r.abha_enrollments || 0) + (r.pmjay_enrollments || 0))) > SAM_CAP) dq.sam_outliers.push([r.name, ngoName[r.partner_name] || r.partner_name, dateOf(r), r.total_enrollments]); });
  (recs["Scheme Application"] || []).forEach(r => { if (r.benefit_received_status === "Yes" && r.lifecycle_status !== "Benefit Received") dq.sa_status_conflict++; });
  // location: Gen-1 forms (have a `zone` field) store zone/state/site; Gen-2 store state(=zone)/district/gram_panchayat
  const geo = s.geo || { zones: [], provinces: [], sites: [] };
  const zoneName = Object.fromEntries(geo.zones.map(z => [z.name, z.state_name || z.name]));
  const provName = Object.fromEntries(geo.provinces.map(d => [d.name, d.district_name || d.name]));
  const siteM = Object.fromEntries(geo.sites.map(g => [g.name, g]));
  const BUS = ["INFC", "AMZL", "ATS", "UFF"];
  const buOf = code => { const g = siteM[code]; const nm = ((g && g.gram_pachayat_name) || code || "").toUpperCase(); const pre = nm.split(/[-_ ]/)[0]; return BUS.includes(pre) ? pre : "Unassigned"; };
  const zones = [], zI = {}; const ZI = k => (k in zI ? zI[k] : (zI[k] = zones.push(k) - 1));
  const sites = [], sI = {}; const SI = k => (k in sI ? sI[k] : (sI[k] = sites.push(k) - 1));
  const geoOf = r => "zone" in r ? [r.zone, r.state, r.site] : [r.state, r.district, r.gram_panchayat];
  M.forEach(([id, , dt, fn], mi) => (recs[dt] || []).forEach(r => {
    const v = fn(r); if (v === null || v === undefined || Number.isNaN(+v)) return;
    const [z, , st] = geoOf(r);
    const key = [MI(mbr(dateOf(r))), mi, P(r.partner_name), r.approval_status === "Approved" ? 1 : 0, ZI(z || ""), SI(st || "")].join(",");
    const o = fm.get(key) || [0, 0]; o[0] += +v; o[1]++; fm.set(key, o);
  }));
  // partner-file Actual rows of MBR Manual Value (old typed-in workbook history is skipped, as the P0 report does)
  const PER = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FILE_PARTNER = [[/akshaya/i], [/mera parivar/i], [/vid(h)?yaranya/i], [/way for life/i], [/\bsaad\b/i], [/\bread\b/i], [/\bsneha\b/i], [/kshamata/i], [/vatsalya/i], [/\byrg\b/i], [/\bia foundation\b/i], [/access ?dev/i, /access development/i], [/global alliance for mass|\bgame\b/i], [/pinkishe/i], [/she (&|and) we/i], [/\bhhh\b|head held high/i], [/jan sahas/i]];
  const ngoFor = name => { const pats = FILE_PARTNER.find(ps => ps[0].test(name || "")); if (!pats) return null; const hit = Object.entries(ngoName).find(([, nm]) => pats.some(p => p.test(nm))); return hit ? hit[0] : null; };
  dq.partner_file_rows = 0;
  (s.mbr_manual || []).filter(r => r.value_type === "Actual" && r.source !== "MBR October 2026 workbook" && PER.includes(r.period)).forEach(r => {
    const mk = r.year + "-" + String(PER.indexOf(r.period) + 1).padStart(2, "0"); if (mk < FIRST_MONTH || mk > LAST_MONTH) return;
    const mi = M.findIndex(x => x[0] === "file_" + r.indicator); if (mi < 0) return;
    const ngo = ngoFor(r.partner); const pIdx = ngo ? P(ngo) : P("(partner file: " + (r.partner || "no partner set") + ")");
    const key = [MI(mk), mi, pIdx, 0, ZI(""), SI("")].join(",");
    const o = fm.get(key) || [0, 0]; o[0] += +r.value || 0; o[1]++; fm.set(key, o); dq.partner_file_rows++;
  });
  // remap month index to sorted order; fact = [month, metric, partner, approved, value, records, zone, site]
  const sorted = [...months].sort(); const remap = months.map(k => sorted.indexOf(k));
  const ifacts = [...fm].map(([k, [v, n]]) => { const a = k.split(",").map(Number); return [remap[a[0]], a[1], a[2], a[3], Math.round(v), n, a[4], a[5]]; });
  const siteRows = sites.map(code => { const g = siteM[code] || {}; return { code, name: g.gram_pachayat_name || code || "(no site)", bu: code ? buOf(code) : "Unassigned", zone: zoneName[g.state] || "", prov: provName[g.district] || "" }; });
  const allSites = geo.sites.map(g => ({ code: g.name, name: g.gram_pachayat_name || g.name, bu: buOf(g.name), zone: zoneName[g.state] || "", prov: provName[g.district] || "" }));
  // GM/PM officers (ICE Form): who filed, role from role profile, lives per MBR month
  const roleOf = e => { const pr = (s.user_profiles || []).filter(x => x.parent === e).map(x => x.role_profile).join(" "); return /Surveyor_GM/i.test(pr) ? "GM" : /ICEP/i.test(pr) ? "PM" : "Other"; };
  const off = new Map(); const dupe = new Map(); let at100 = 0, noSub = 0;
  (recs["ICE Form"] || []).forEach(r => {
    const e = r.submitted_by || r.owner; if (!r.submitted_by) noSub++;
    const [z, , st] = geoOf(r); const m = mbr(dateOf(r));
    const k = e + "|" + m; const o = off.get(k) || { e, m, p: r.partner_name, z, sites: new Set(), n: 0, lives: 0, appr: 0 };
    o.n++; o.lives += r.total_interactions || 0; if (r.approval_status === "Approved") o.appr++; if (st) o.sites.add(st); off.set(k, o);
    if (r.total_interactions === 100) at100++;
    const sig = [e, st, dateOf(r), r.activity, r.total_interactions].join("|"); dupe.set(sig, (dupe.get(sig) || 0) + 1);
  });
  const officers = [...off.values()].map(o => [sorted.indexOf(o.m), uIdx[o.e] ?? -1, P(o.p), ZI(o.z || ""), o.n, o.lives, o.appr, o.sites.size, roleOf(o.e)]).filter(x => x[1] >= 0);
  const dupes = [...dupe].filter(([, n]) => n > 1).map(([k, n]) => { const [e, st, d, init, gt] = k.split("|"); return [uIdx[e] ?? -1, st, d, init, +gt, n]; }).sort((a, b) => b[5] - a[5]).slice(0, 300);
  dq.ice_at100 = at100; dq.ice_no_submitter = noSub; dq.ice_dupe_groups = [...dupe.values()].filter(n => n > 1).length; dq.ice_dupe_extra = [...dupe.values()].reduce((a, n) => a + (n > 1 ? n - 1 : 0), 0);
  // Scheme Application detail (since go-live): funnel, schemes, partners, counting-rule options
  const SA = recs["Scheme Application"] || [];
  // funnel view only: A.3.2 itself counts every record (MBR rule), whatever its lifecycle
  const APPLIED = new Set(["Identified", "Applied", "Under Review", "Approved", "Benefit Received", "Re-applied"]);
  const life = {}; SA.forEach(r => { const k = r.lifecycle_status || "(blank)"; life[k] = (life[k] || 0) + 1; });
  const byScheme = {}; SA.forEach(r => { const o = byScheme[r.scheme || "(blank)"] || (byScheme[r.scheme || "(blank)"] = [0, 0, 0]); o[0]++; if (APPLIED.has(r.lifecycle_status)) o[1]++; if (r.lifecycle_status === "Benefit Received") o[2]++; });
  const saP = {}; SA.forEach(r => { const o = saP[r.partner_name] || (saP[r.partner_name] = { apps: 0, ben: new Set(), recv: 0, yes: 0 }); if (APPLIED.has(r.lifecycle_status)) { o.apps++; if (r.beneficiary) o.ben.add(r.beneficiary); } if (r.lifecycle_status === "Benefit Received") o.recv++; if (r.benefit_received_status === "Yes") o.yes++; });
  const uniqAll = new Set(SA.filter(r => APPLIED.has(r.lifecycle_status) && r.beneficiary).map(r => r.beneficiary)).size;
  // MoU KPIs (grant side): targets exist, achievement is not linked to forms
  const gafNgo = Object.fromEntries(s.gafs.map(g => [g.name, g.ngo]));
  const kpiName = Object.fromEntries(((s.mou || {}).kpis || []).map(k => [k.name, [k.kpi_name, k.kpi_type]]));
  const mou = ((s.mou || {}).outputs || []).filter(o => !EXCLUDE_NGOS.has(gafNgo[o.project_proposal])).map(o => {
    const q = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 }; let tot = 0; (o.plan || []).forEach(([y, qq, t]) => { tot += t; if (/1/.test(y) && qq in q) q[qq] += t; });
    return [P(gafNgo[o.project_proposal]), o.project_proposal, (kpiName[o.kpi] || [o.kpi])[0], (kpiName[o.kpi] || [, ""])[1], o.frequency || "", tot, q.Q1, q.Q2, q.Q3, q.Q4];
  });
  impact = {
    months: sorted, metrics: M.map(([id, label, dt, , ind]) => ({ id, label, dt, ind })), facts: ifacts,
    goals: G, dq,
    sa: { life, schemes: Object.entries(byScheme).sort((a, b) => b[1][0] - a[1][0]).slice(0, 15), partners: Object.entries(saP).map(([p, o]) => [P(p), o.apps, o.ben.size, o.recv, o.yes]), unique: uniqAll, total: SA.length },
    mou, zones: zones.map(z => zoneName[z] || (z ? z : "No zone")), sites: siteRows, allSites, officers, dupes,
    partner_goals: (G.partner_q3_goals || []).map(x => ({ ...x, p: x.ngo ? P(x.ngo) : null }))
  };
  console.log("impact facts", ifacts.length, "months", sorted.join(" "), "dq", JSON.stringify({ ...dq, sam_outliers: dq.sam_outliers.length }));
}

const out = {
  go_live: GO_LIVE, impact,
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
