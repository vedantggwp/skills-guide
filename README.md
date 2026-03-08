# Skills.Guide

A single-page reference for every slash command installed in Claude Code. Search, browse, copy. Built for speed — no frameworks, no build step, no external dependencies at runtime.

**Live:** [vedantggwp.github.io/skills-guide](https://vedantggwp.github.io/skills-guide/)

---

## The Problem

Claude Code skills are powerful but invisible. Install five skill packs and you suddenly have 285 commands — scattered across different repos, documented in different formats, with no central index. You forget what you installed. You don't know which command to reach for. You end up asking Claude "what skills do I have?" instead of just using them.

The cognitive overhead kills the utility.

## The Idea

**If you can't see it, you won't use it.**

Skills.Guide is a visual command reference that makes your entire arsenal browsable in one place. The design follows three principles:

### 1. Decision Tree First, Catalogue Second

Most skill guides are alphabetical lists. That's how computers think, not how people think. When you sit down to work, you don't think "I need `/copywriting`" — you think "I need to write copy." The decision tree at the top maps your intent to the right command:

```
What do I need?
├── Audit something?     → /market audit <url>
├── Write copy?          → /copywriting
├── Optimize a page?     → /page-cro
└── Debug something?     → /systematic-debugging
```

Start with the problem, arrive at the command. The alphabetical catalogue exists below for when you already know what you're looking for.

### 2. Grouped by Role, Not by Source

Skills come from different repos (marketing pack, engineering pack, Obsidian pack, etc.) but you don't think in terms of where something was installed from — you think in terms of what you're doing. So commands are grouped by function:

- **Marketing & Growth** — audits, CRO, copy, SEO, ads, outreach
- **Engineering & Development** — patterns, testing, TDD, security, deployment
- **Business & Advisory** — C-level advisors, compliance, finance, product
- **Workflow & Productivity** — GSD project management, Superpowers meta-skills, Obsidian

The sidebar mirrors these groups. You scan by domain, not by origin.

### 3. Copy-First Interaction

Every command is one click away from your clipboard. Click a command card, click a tree leaf, hit the copy button — the command is on your clipboard ready to paste into Claude Code. No selecting, no highlighting, no manual copying. The flash animation gives immediate feedback that it worked.

## Architecture

### Single-File HTML

The entire guide — styles, markup, data, and logic — lives in one `index.html`. No build step, no bundler, no node_modules, no framework. Open the file, it works. Deploy to GitHub Pages, it works. The tradeoff is a larger file (~80KB), but that's smaller than a single React chunk and loads instantly.

Why not separate CSS/JS files? Because this is a reference tool, not an application. A single file is easier to maintain, easier to deploy, and has zero failure modes (no broken imports, no 404s on assets, no CORS issues with data files).

### Data Injection Over Data Fetching

Early versions used `fetch('data.json')` to load command data at runtime. This broke on GitHub Pages (timing issues, CORS edge cases) and added a failure mode. The current approach embeds all data directly in the HTML inside marker comments:

```js
// __SKILLS_DATA_START__
const DATA = { ... };
// __SKILLS_DATA_END__
```

`sync.js` scans your installed skills and replaces only the content between these markers. The HTML, CSS, and all JavaScript functions outside the markers are never touched. This gives us the best of both worlds: auto-generated data with zero runtime dependencies.

### Atomic Sync

`sync.js` follows a strict safety protocol:

1. **Scan** `~/.claude/skills/` recursively for `SKILL.md` files
2. **Parse** YAML frontmatter from each file (name, description)
3. **Merge** scanned skills with static plugin skills (Superpowers, GSD, ECC — these live in plugin cache, not in `~/.claude/skills/`)
4. **Build** the DATA object with categories, sidebar groups, and input type tags
5. **Write to temp file** (`index.html.tmp`) — the original is never touched during generation
6. **Validate** the temp file against 8 checks:
   - Has `<!DOCTYPE html>`
   - Has `</html>`
   - Has both marker comments
   - Has `<script>` and `</script>` tags
   - Has `render()` call
   - Line count is within 20% of original
7. **Atomic rename** — `index.html.tmp` → `index.html` (single filesystem operation)
8. If any check fails, the temp file is deleted and the original is untouched

The decision tree is preserved during sync — it's hand-curated (intent-to-command mapping can't be auto-generated well) while the command catalogue is fully automated.

## Design

### Typography

- **Instrument Serif** — display/headings. Warm, editorial feel. Avoids the cold clinical look of sans-serif-only pages.
- **Plus Jakarta Sans** — body text. Geometric but friendly. High legibility at small sizes.
- **JetBrains Mono** — commands and code. Designed for code readability with ligatures and distinct characters.

### Color

Dark mode default with warm amber (`#e8a84c`) as the accent. The palette avoids the cliche purple-gradient-on-white that screams "AI generated." Input type tags use distinct colors (blue for URL, green for code, pink for text, purple for topic) for quick visual scanning.

Light mode uses the same amber accent shifted warmer, with cream/linen backgrounds instead of pure white.

### Texture

A subtle SVG noise overlay (`opacity: 0.03` dark, `0.015` light) adds organic grain. Without it, large solid-color areas feel flat and synthetic. The noise is applied via CSS `::before` pseudo-element on the body — no image files needed.

### Input Type Tags

Every command card shows what kind of input it expects:

| Tag | Meaning | Example |
|-----|---------|---------|
| `URL` | Needs a URL to analyze | `/market audit <url>` |
| `TOPIC` | Needs a topic or subject | `/last30days AI agents` |
| `CONTEXT` | Needs descriptive text | `/copywriting` |
| `CODE` | Operates on code in your project | `/security-review` |
| `AUTO` | No input needed, runs on current context | `/gsd:progress` |

This answers the question "what do I type after the command?" without reading the description.

## Usage

### Browse the Guide

Open [vedantggwp.github.io/skills-guide](https://vedantggwp.github.io/skills-guide/) or the local `index.html`. Use the decision tree for intent-based lookup, the sidebar for category browsing, or `Cmd+K` to search.

### Sync After Installing/Removing Skills

```bash
cd ~/skills-guide
node sync.js
```

That's it. One command. It scans, merges, validates, and injects. If you want to preview what would change without writing:

```bash
node sync.js --dry-run
```

For detailed scan output:

```bash
node sync.js --verbose
```

### Deploy

Push to GitHub. Pages serves `index.html` from the `main` branch. No build step needed.

```bash
git add index.html
git commit -m "sync: update skills data"
git push
```

### Add Your Own Branding

The branding line is in the sidebar HTML:

```html
<div class="sidebar-branding">by Vedant &mdash; <em>On my nth iteration.</em></div>
```

Change the name and tagline to make it yours.

## File Structure

```
skills-guide/
├── index.html      # The entire guide (HTML + CSS + JS + data)
├── sync.js         # Scanner that injects fresh data into index.html
├── data.json       # Legacy output (kept for reference, not used by index.html)
├── .gitignore      # Ignores node_modules, .DS_Store
└── README.md       # This file
```

## Currently Installed Skill Packs

| # | Source | Skills |
|---|--------|--------|
| 1 | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | CRO, copywriting, SEO, paid ads, growth |
| 2 | [zubair-trabzada/ai-marketing-claude](https://github.com/zubair-trabzada/ai-marketing-claude) | Marketing audit suite with parallel agents |
| 3 | [BrianRWagner/ai-marketing-claude-code-skills](https://github.com/BrianRWagner/ai-marketing-claude-code-skills) | Positioning, LinkedIn, outreach, content |
| 4 | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | Engineering, marketing, product, C-level, compliance |
| 5 | [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | Obsidian Markdown, Bases, Canvas, CLI |
| 6 | Superpowers (plugin) | Brainstorming, TDD, code review, git worktrees |
| 7 | Everything Claude Code (plugin) | Frontend, backend, database, deployment, testing patterns |
| 8 | GSD (plugin) | Project management, phases, debugging, execution |

## Requirements

- Node.js 18+ (for `sync.js` only — the guide itself needs nothing)
- Claude Code with skills installed in `~/.claude/skills/`

## License

MIT
