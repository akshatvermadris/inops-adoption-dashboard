const fs = require("fs");
const tpl = fs.readFileSync("template.html", "utf8");
const full = JSON.parse(fs.readFileSync("data.json", "utf8"));
// client build: internal log data removed entirely, not just hidden
const client = { ...full }; delete client.internal; delete client.loginDays;
client.users = full.users.map(u => { const c = { ...u }; delete c.lg; delete c.ll; return c; });
const embed = d => tpl.replace("/*__DATA__*/", () => JSON.stringify(d).replace(/</g, "\\u003c"));
const wrap = page => { const m = page.match(/^([\s\S]*?<\/style>)([\s\S]*)$/); return "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n" + m[1] + "\n</head><body>" + m[2] + "</body></html>\n"; };
const page = embed(client);
fs.writeFileSync("inops-adoption.html", page);                       // artifact body, client view
fs.writeFileSync("inops-adoption-standalone.html", wrap(page));      // client HTML for Downloads
fs.writeFileSync("inops-adoption-internal.html", wrap(embed(full))); // Dhwani internal, includes Logs
fs.writeFileSync("inops-adoption-live-shell.html", tpl);             // no data: fetches the live endpoint when hosted on iNOPS
fs.mkdirSync("site", { recursive: true }); fs.writeFileSync("site/index.html", wrap(page)); fs.writeFileSync("site/.nojekyll", "");
console.log("ok", (page.length / 1024).toFixed(0) + " KB");
