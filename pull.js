// Pulls a read-only adoption snapshot from inops.mgrant.in -> snapshot.json
// Usage: node pull.js  (token from INOPS_TOKEN or the inops-daily skill's .credentials)
const fs = require("fs"), path = require("path");
const BASE = "https://inops.mgrant.in";
// Token: GitHub Actions passes INOPS_TOKEN; locally it is read from .env (INOPS_TOKEN=key:secret, git-ignored).
// Use the SAME key in both places, and never click "Generate Keys" again, because that cancels the old key everywhere.
const envFile = path.join(__dirname, ".env");
const fromEnvFile = fs.existsSync(envFile) ? ((/^\s*INOPS_TOKEN\s*=\s*"?([^"\r\n]+)"?/m.exec(fs.readFileSync(envFile, "utf8")) || [])[1] || "") : "";
const TOK = (process.env.INOPS_TOKEN || fromEnvFile).trim();
if (!TOK) { console.error("No iNOPS key: set INOPS_TOKEN, or put INOPS_TOKEN=key:secret in .env"); process.exit(2); }
const FORMS = require("./forms.json").forms;

async function api(p, body) {
  const r = await fetch(BASE + p, body ? { method: "POST", headers: { Authorization: "token " + TOK, "Content-Type": "application/json" }, body: JSON.stringify(body) } : { headers: { Authorization: "token " + TOK } });
  const j = await r.json();
  if (!r.ok) throw new Error(p + " -> " + r.status + " " + (j.exc_type || "") + " " + (j.exception || "").slice(0, 200));
  return j.data ?? j.message;
}
const list = (dt, fields, filters = [], extra = "") =>
  api(`/api/resource/${encodeURIComponent(dt)}?fields=${encodeURIComponent(JSON.stringify(fields))}&filters=${encodeURIComponent(JSON.stringify(filters))}&limit_page_length=0${extra}`);
async function meta(dt) { return (await api(`/api/method/frappe.desk.form.load.getdoctype?doctype=${encodeURIComponent(dt)}`)) || null; }

(async () => {
  const out = { pulled_at: new Date().toISOString(), site: BASE, forms: [], warnings: [] };

  // NGOs
  out.ngos = await list("NGO", ["name", "ngo_name", "creation"]);

  // Users + profiles + NGO mapping
  out.users = await list("User", ["name", "full_name", "enabled", "last_login", "last_active", "creation", "user_type"], [["name", "not in", ["Administrator", "Guest"]]]);
  try {
    out.user_profiles = await api("/api/method/frappe.client.get_list", { doctype: "User Role Profile", parent: "User", fields: ["parent", "role_profile"], limit_page_length: 0 });
  } catch (e) { out.warnings.push("role profiles: " + e.message); out.user_profiles = []; }
  out.user_ngo = await list("User Permission", ["user", "for_value"], [["allow", "=", "NGO"]]);

  // Logins (Activity Log)
  out.logins = await list("Activity Log", ["user", "creation", "status"], [["operation", "=", "Login"]]);

  // Forms
  for (const f of FORMS) {
    const fields = ["name", "owner", "partner_name", "creation", "modified"];
    let m;
    try { const r = await fetch(`${BASE}/api/resource/${encodeURIComponent(f.doctype)}?fields=["*"]&limit_page_length=1`, { headers: { Authorization: "token " + TOK } }); m = ((await r.json()).data || [])[0] || {}; } catch { m = {}; }
    for (const k of ["approval_status", "workflow_state", "mobile_uuid"]) if (k in m) fields.push(k);
    let rows = [];
    try { rows = await list(f.doctype, fields); } catch (e) { out.warnings.push(f.doctype + ": " + e.message); }
    out.forms.push({ ...f, has_status: fields.includes("approval_status"), rows: rows.map(r => [r.owner, r.partner_name, r.creation.slice(0, 19), r.approval_status || r.workflow_state || "", r.mobile_uuid ? "Mobile" : "Web", r.modified.slice(0, 19)]) });
  }

  // Grants side
  out.gafs = await list("Project proposal", ["name", "project_name", "ngo", "ngo_name", "donor_name", "workflow_state", "stage", "focus_area", "total_planned_budget", "project_start_date", "project_end_date", "project", "modified"]);
  out.grants = await list("Grant", ["name", "grant_name", "ngo", "donor", "grant_status", "focus_area", "total_planned_budget", "start_date", "end_date", "project", "modified"]);
  out.projects = await list("Project", ["name", "project_name", "ngo_name", "status", "project_proposal", "total_planned_budget"]);
  out.tranches = await list("Project Tranche", ["name", "project_proposal", "ngo_name", "period", "planned_due_date", "total_funds_planned", "status", "workflow_state"].filter(Boolean)).catch(async e => { out.warnings.push("tranche: " + e.message); return list("Project Tranche", ["name", "project_proposal", "ngo_name", "period", "planned_due_date", "total_funds_planned"]); });
  out.reporting = await list("Project Reporting", ["name", "project_proposal", "ngo_name", "report_name", "frequency"]);
  out.outputs = await list("Project Output", ["name", "project_proposal"]);
  out.outcomes = await list("Project Outcome", ["name", "project_proposal"]);
  out.dd = await list("NGO Due Diligence", ["name", "ngo", "ngo_name", "workflow_state", "creation"]);
  out.donors = await list("Donor", ["name", "donor_name"]).catch(() => []);
  out.compliance = await list("Reporting", ["name", "grant", "ngo", "ngo_name", "report_name", "report_type", "due_date", "creation", "submission_status", "workflow_state", "closure_status"]);
  out.budget = await list("Budget Plan and Utilisation", ["grant", "ngo", "total_planned_budget", "total_utilisation", "workflow_state"]);
  // governance: Login As sessions, page views, edits/comments by person, who can approve
  out.impersonations = await list("Activity Log", ["user", "owner", "creation"], [["operation", "=", "Impersonate"]]);
  out.logouts = await list("Activity Log", ["user", "creation"], [["operation", "=", "Logout"]]);
  out.route_by_user = await list("Route History", ["user", "count(name) as n", "max(creation) as last"], [], "&group_by=user");
  out.versions_by_owner = await list("Version", ["owner", "count(name) as n", "max(creation) as last"], [], "&group_by=owner");
  out.comments_by_owner = await list("Comment", ["owner", "count(name) as n", "max(creation) as last"], [["comment_type", "in", ["Comment", "Workflow", "Info", "Edit", "Attachment"]]], "&group_by=owner");
  out.approver_roles = await api("/api/method/frappe.client.get_list", { doctype: "Has Role", parent: "User", fields: ["parent", "role"], filters: [["parenttype", "=", "User"], ["role", "like", "%Approver%"]], limit_page_length: 0 }).catch(e => { out.warnings.push("approvers: " + e.message); return []; });
  out.admin_roles = await api("/api/method/frappe.client.get_list", { doctype: "Has Role", parent: "User", fields: ["parent", "role"], filters: [["parenttype", "=", "User"], ["role", "in", ["System Manager", "Impersonate User", "mGrant Donor Admin"]]], limit_page_length: 0 }).catch(e => { out.warnings.push("admin roles: " + e.message); return []; });
  out.log_retention = ((await api("/api/resource/Log%20Settings/Log%20Settings")).logs_to_clear || []).map(x => ({ dt: x.ref_doctype, days: x.days }));
  out.has_role = await api("/api/method/frappe.client.get_list", { doctype: "Has Role", parent: "User", fields: ["parent", "role"], filters: [["parenttype", "=", "User"], ["role", "like", "%Full Access"]], limit_page_length: 0 }).catch(e => { out.warnings.push("has_role: " + e.message); return []; });
  // ---- CE Impact: aggregate value fields per record (no names, no beneficiary details) ----
  const IMPACT = {
    "ICE Form": ["thematic_area", "initiative", "activity", "activity_description", "institution_name", "grand_total", "total_interactions"],
    "Hunger Awareness Form": ["total_participants"],
    "MCH Activity Form": ["awareness_population", "pw_registered", "children_registered", "children_anthropometry", "children_malnourished_referred"],
    "Monthly Meal Donation Form": ["meals_distributed", "students_received_meals"],
    "Food Rescue Form": ["quantity", "value"],
    "Food Distribution Form": ["bene_total", "quantity"],
    "Training": ["ent_attendees"],
    "Member Enrolment": [],
    "Enterprise Master": [],
    "Enterprise Progress Visit": ["monthly_income", "monthly_sales"],
    "Menstrual Hygiene Training": ["mh_trainees", "mh_improved_knowledge", "institution_name"],
    "Menstrual Hygiene Champion": ["mh_women_reached"],
    "Menstrual Hygiene Period Van": ["mh_van_reached"],
    "Sanitary Pad Unit Visit": ["mh_napkins_made", "mh_revenue", "mh_women_count"],
    "Menstrual Hygiene Micro-Entrepreneur": ["mh_packets_sold", "mh_me_income"],
    "Champion": [], "Micro-Entrepreneur Master": [], "Manufacturing Unit Master": [],
    "Household Survey": ["member_count"],
    "Household Beneficiary": [],
    "Scheme Application": ["lifecycle_status", "benefit_received_status", "scheme", "beneficiary"],
    "Social Entitlements Enrolment Form": ["total_interactions", "new_applications_initiated"],
    "Samridhi Mela Site Visit": ["total_enrollments", "abha_enrollments", "pmjay_enrollments"]
  };
  // Name / description fields the MBR test-row rule checks on each form (frappe_inops mbr_logic.FIXED_FORMS).
  // Only rows whose field contains test / tester / rmn are fetched, so no personal names are pulled.
  const TEST_FIELDS = { "ICE Form": ["institution_name", "activity_description"], "Food Distribution Form": ["comments", "lot_comments"], "Member Enrolment": ["member_name"], "Enterprise Master": ["business_name"], "Menstrual Hygiene Training": ["institution_name"], "Household Survey": ["head_name"], "Scheme Application": ["remarks"] };
  out.impact = {}; out.test_rows = {};
  for (const [dt, fl] of Object.entries(IMPACT)) {
    try {
      const one = ((await api(`/api/resource/${encodeURIComponent(dt)}?fields=["*"]&limit_page_length=1`).catch(() => [])) || [])[0] || {};
      // location: Gen-2 forms use state/district/block/gram_panchayat; Gen-1 forms use zone/state/district/site
      const extra = ["approval_status", "activity_date", "zone", "state", "district", "block", "gram_panchayat", "site", "submitted_by"].filter(k => k in one);
      const F = ["name", "owner", "partner_name", "creation", ...extra, ...fl.filter(k => k !== "name")];
      const rows = await list(dt, F, [["docstatus", "<", 2]]); // cancelled records left out, as in the P0 report
      out.impact[dt] = { fields: F, rows: rows.map(r => F.map(k => r[k] ?? null)) };
      const hits = new Set();
      for (const f of (TEST_FIELDS[dt] || []).filter(k => k in one || dt === "ICE Form")) {
        for (const w of ["test", "rmn"]) {
          const found = await list(dt, ["name", f], [[f, "like", `%${w}%`]]).catch(() => []);
          found.forEach(x => { if (/\b(test|tester|rmn)\b/i.test(String(x[f] || ""))) hits.add(x.name); });
        }
      }
      if (hits.size) out.test_rows[dt] = [...hits];
    } catch (e) { out.warnings.push("impact " + dt + ": " + e.message); }
  }
  // MBR Manual Value: goals (Goal Sheet) and partner-file actuals, the same rows the P0 report reads
  out.mbr_manual = await list("MBR Manual Value", ["indicator", "year", "period", "value_type", "value", "partner", "source", "display"]).catch(e => { out.warnings.push("mbr manual: " + e.message); return []; });
  // location masters: State = Amazon zone, District = state (province), Block = facility, Gram Panchayat = BU-site
  out.geo = {
    zones: await list("State", ["name", "state_name"]).catch(() => []),
    provinces: await list("District", ["name", "district_name", "state"]).catch(() => []),
    blocks: await list("Block", ["name", "block_name", "district"]).catch(() => []),
    sites: await list("Gram Panchayat", ["name", "gram_pachayat_name", "block", "district", "state"]).catch(() => [])
  };
  // MoU KPI targets on the grant side (Project Output planning table)
  try {
    const po = await list("Project Output", ["name", "project_proposal", "kpi", "frequency"]);
    for (const p of po) { try { const d = await api(`/api/resource/Project%20Output/${encodeURIComponent(p.name)}`); p.plan = (d.planning_table || []).map(x => [x.year || "", x.quarter || "", +x.target || 0]); } catch { p.plan = []; } }
    const kp = [...new Set(po.map(p => p.kpi).filter(Boolean))];
    const names = kp.length ? await list("KPIs", ["name", "kpi_name", "kpi_type"], [["name", "in", kp]]) : [];
    out.mou = { outputs: po, kpis: names };
  } catch (e) { out.warnings.push("mou: " + e.message); out.mou = { outputs: [], kpis: [] }; }

  out.error_log_30d = await api(`/api/method/frappe.client.get_count?doctype=Error%20Log&filters=${encodeURIComponent(JSON.stringify([["creation", ">", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)]]))}`);

  fs.writeFileSync(path.join(__dirname, "snapshot.json"), JSON.stringify(out));
  console.log("forms rows:", out.forms.reduce((a, f) => a + f.rows.length, 0), "users:", out.users.length, "profiles:", out.user_profiles.length, "logins:", out.logins.length, "gafs:", out.gafs.length, "grants:", out.grants.length, "tranches:", out.tranches.length, "dd:", out.dd.length);
  console.log("warnings:", out.warnings);
})().catch(e => { console.error(e); process.exit(1); });
