// Pulls a read-only adoption snapshot from inops.mgrant.in -> snapshot.json
// Usage: node pull.js  (token from INOPS_TOKEN or the inops-daily skill's .credentials)
const fs = require("fs"), path = require("path");
const BASE = "https://inops.mgrant.in";
const TOK = (process.env.INOPS_TOKEN || fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME, ".claude/skills/inops-daily/.credentials"), "utf8")).trim();
if (!TOK) { console.error("INOPS_TOKEN is empty"); process.exit(2); }
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
  out.error_log_30d = await api(`/api/method/frappe.client.get_count?doctype=Error%20Log&filters=${encodeURIComponent(JSON.stringify([["creation", ">", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)]]))}`);

  fs.writeFileSync(path.join(__dirname, "snapshot.json"), JSON.stringify(out));
  console.log("forms rows:", out.forms.reduce((a, f) => a + f.rows.length, 0), "users:", out.users.length, "profiles:", out.user_profiles.length, "logins:", out.logins.length, "gafs:", out.gafs.length, "grants:", out.grants.length, "tranches:", out.tranches.length, "dd:", out.dd.length);
  console.log("warnings:", out.warnings);
})().catch(e => { console.error(e); process.exit(1); });
