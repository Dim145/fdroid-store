# fdroid-store · docs site

Static, framework-free, deploy-anywhere documentation for the project.
Lives in `docs/` so it can ride GitHub Pages with zero build step.

## What's here

| File                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `index.html`          | Landing page — pitch + features + architecture    |
| `install.html`        | Infrastructure docs: env vars, ClamAV, OIDC, …    |
| `admin.html`          | Administrator guide                                |
| `users.html`          | End-user guide                                     |
| `integrations.html`   | F-Droid client + CI + forge auto-ingest           |
| `404.html`            | Custom not-found page                              |
| `assets/style.css`    | Single CSS file, design tokens at the top          |
| `assets/site.js`      | Tiny enhancement script (nav, copy, TOC)           |
| `assets/logo.svg`     | Project mark                                       |
| `.nojekyll`           | Skips GitHub's automatic Jekyll processing         |

No build step. No package manager. Edit the HTML, push, you're done.

## Local preview

Any static server works. Two convenient options:

```bash
# Python
cd docs && python3 -m http.server 4000

# or with npx
cd docs && npx serve .
```

Then open <http://localhost:4000>.

## Publishing to GitHub Pages

The workflow at `.github/workflows/docs.yml` auto-deploys on every push to
`main` that touches `docs/`. To enable it once:

1. Go to **Settings → Pages** on the GitHub repo.
2. Under **Build and deployment**, set the source to **GitHub Actions**.
3. Push to `main`. The workflow runs and prints the public URL.

The first deploy lands at `https://<user>.github.io/<repo>/` unless you've
attached a custom domain (in which case drop a `CNAME` file next to this
README).

## Design

Engineering-schematic / phosphor-terminal aesthetic. F-Droid green
(`#a4ec5f`) on a warm-cool dark base, paired with:

- **`Big Shoulders Display`** — heavy industrial display for headers
- **`Manrope`** — geometric grotesk for body
- **`JetBrains Mono`** — labels, code, technical chrome

All design tokens are in `:root` at the top of `assets/style.css`.

## Adding a page

1. Copy any of the four doc pages (`install.html` is a good template).
2. Change the `<title>`, the eyebrow, the H1, and the TOC list.
3. Replace the body sections.
4. Add the page to the four primary-nav `<a>` tags in `<header>` and the
   footer column on every other page (search-and-replace).
5. If you want code-block syntax colour, wrap tokens in:
   - `<span class="c-cmt">…</span>` for comments
   - `<span class="c-kw">…</span>` for keywords / env-var names
   - `<span class="c-str">…</span>` for strings
   - `<span class="c-fn">…</span>` for command names
   - `<span class="c-fl">…</span>` for flags
   - `<span class="c-var">…</span>` for variables

## Real screenshots

The mocked browser frames (`.shot`) are CSS — they don't depend on any
captured screenshot, so the docs stay in sync with the app even when the
UI is redesigned. If you want to drop real screenshots in too, add them
under `assets/shots/` and reference them with `<img src="assets/shots/…">`
inside a `.shot .body` block.
