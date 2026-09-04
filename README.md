# edzanelli.com

Personal site. Static HTML assembled from `src/` by a 60-line build script; no framework.

```
src/
  site.json            name, email, LinkedIn, resume path, domain, year: written once, used everywhere as {{email}} etc.
  layout.html          the shell every page shares (head, header slot, content slot, footer, scripts)
  partials/            logo, header-site, header-ask, footer, contact-links
  pages/               one file per page: a JSON metadata comment, then the page's <main>
  css/  js/  assets/   copied to the output unchanged
build/
  build.mjs            assembles src/ into website/
  sdk-entry.js         what esbuild bundles for the Ask page (the LiveAvatar SDK)
lambda/session-token/  the one server piece: mints LiveAvatar session tokens for the Ask page
prompts/               the avatar's context prompt, versioned here, pasted into the LiveAvatar dashboard
docs/                  design documents
website/               BUILD OUTPUT. Not committed. This is what Amplify serves.
```

## Build and run locally
```
npm install          once
npm run build        assembles website/ and bundles the SDK into website/js/vendor/
npm run serve        http://localhost:8080
```
Edit under `src/`, never under `website/`; the next build overwrites it.

## Adding or changing a page
Create `src/pages/name.html` starting with a metadata comment:
```
<!-- meta
{ "path": "name.html", "title": "...", "description": "...", "header": "header-site", "scripts": ["js/site.js"] }
-->
<main>...</main>
```
`{{partial:contact-links}}` inlines a partial; `{{email}}`, `{{linkedin}}`, `{{resume}}` come from `site.json`. Optional fields: `current` (nav item to mark as the current page), `og_title` and `og_description` (default to title and description), `og_image` (defaults to `assets/og-image.jpg`), `module_scripts`.

## Before publishing
- Replace every `TODO` and `[bracketed]` placeholder under `src/` (`grep -rn "TODO\|\[" src/pages`).
- Put `Ed_Zanelli_Resume.pdf` in `src/assets/` and the two photos in `src/assets/img/` (portrait.webp, candid.webp), then swap the placeholder divs in `src/pages/index.html` and `about.html` for the `<img>` tags in the adjacent comments.
- Set `TOKEN_URL` in `src/js/ask.js` to the Lambda function URL (see `lambda/session-token/README.md`).
- Paste `prompts/ask-ed.txt` into the LiveAvatar context (one context serves both languages).

## Hosting (AWS Amplify)
`amplify.yml` runs `npm ci && npm run build` and serves `website/`. Custom domain `edzanelli.com` with `www` redirected to the apex; `ask.edzanelli.com` added as a subdomain with a 301 redirect rule to `https://edzanelli.com/ask.html`.
