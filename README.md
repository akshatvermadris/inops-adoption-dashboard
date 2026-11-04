# iNOPS Adoption Dashboard

Amazon iNOPS adoption, forms, grants and compliance dashboard, built from the production iNOPS portal (read-only) and published to GitHub Pages.

- **Refresh:** every Monday 09:00 IST, or Actions › Refresh dashboard › Run workflow.
- **Key:** repository secret `INOPS_TOKEN` = `api_key:api_secret`. Never commit it. The build fails if the key appears in the page.
- **Pipeline:** `pull.js` (read-only API pull) → `aggregate.js` (counting rules) → `build.js` (embeds data into `template.html`) → `site/index.html`.
- **Data** is never committed; it exists only in the published page.
- **Counting rules:** go-live 1 Jul 2026; Dhwani accounts excluded; "Login As" sessions excluded; partners not onboarded (CINI) hidden.
