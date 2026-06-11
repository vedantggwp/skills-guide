#!/usr/bin/env node

/**
 * Skills Guide Sync Script — multi-agent edition
 *
 * Scans every agent's global skills dir (Claude Code, Codex, Gemini), tags each
 * skill with which agents have it, categorizes it, and injects the data into
 * index.html between marker comments. The guide's agent filter + per-card badges
 * read the `agents` array on each command.
 *
 *   node sync.js            # scan all agents and inject into index.html
 *   node sync.js --dry-run  # show what would be found without writing
 *   node sync.js --verbose  # detailed scan progress
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// Each agent's global skills dir. Order defines badge order + category tiebreak
// priority (first agent to define a skill name owns its description/category).
const AGENT_DIRS = [
  { agent: 'claude', dir: path.join(HOME, '.claude', 'skills') },
  { agent: 'codex',  dir: path.join(HOME, '.codex',  'skills') },
  { agent: 'gemini', dir: path.join(HOME, '.gemini', 'skills') },
];
const AGENT_ORDER = AGENT_DIRS.map(a => a.agent);

const HTML_FILE = path.join(__dirname, 'index.html');
const TEMP_FILE = path.join(__dirname, 'index.html.tmp');
const START_MARKER = '// __SKILLS_DATA_START__';
const END_MARKER = '// __SKILLS_DATA_END__';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// ── Parse SKILL.md frontmatter (YAML between --- markers) ──
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter = {};
  match[1].split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) frontmatter[key] = value;
  });
  return frontmatter;
}

// ── Walk a directory recursively to find SKILL.md files ──
function findSkillFiles(dir, depth = 0) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  if (depth > 4) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      } else if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findSkillFiles(fullPath, depth + 1));
      }
    }
  } catch (err) {
    if (VERBOSE) console.log(`  [skip] ${dir}: ${err.message}`);
  }
  return results;
}

// ── Determine input type from description ──
function inferInputType(desc, name) {
  const d = (desc + ' ' + name).toLowerCase();
  if (d.includes('url') || d.includes('audit') || d.includes('website') || d.includes('page')) return 'url';
  if (d.includes('code') || d.includes('test') || d.includes('build') || d.includes('pattern')) return 'code';
  if (d.includes('auto') || d.includes('scan') || d.includes('cleanup')) return 'auto';
  if (d.includes('topic') || d.includes('research') || d.includes('idea') || d.includes('content')) return 'topic';
  return 'text';
}

// ── Infer category from directory + name + description keywords + agent ──
function inferCategory({ name, desc, fullDesc, agent, baseDir, skillPath }) {
  const nm = (name || '').toLowerCase().replace(/^\//, '');
  const text = `${nm} ${desc || ''} ${fullDesc || ''}`.toLowerCase();
  const has = (...words) => words.some(w => text.includes(w));
  const starts = (...prefixes) => prefixes.some(p => nm.startsWith(p));

  // 0. Directory-based (nested skills under a known top-level dir)
  const rel = path.relative(baseDir, skillPath);
  const parts = rel.split(path.sep);
  const dirCategoryMap = {
    'market': 'market-suite', 'marketing-skill': 'marketing', 'engineering': 'engineering',
    'engineering-team': 'eng-specialists', 'product-team': 'product', 'business-growth': 'business',
    'c-level-advisor': 'advisory', 'finance': 'finance', 'regulatory-compliance': 'compliance',
    'documentation': 'productivity', 'agents': 'engineering', 'commands': 'productivity',
  };
  if (parts.length > 1 && dirCategoryMap[parts[0]]) return dirCategoryMap[parts[0]];

  // 1. Exact name overrides
  const exact = {
    // Marketing — consolidated Corey Haines pack + classics
    'ab-testing': 'cro', 'ab-test-setup': 'cro', 'cro': 'cro', 'page-cro': 'cro', 'form-cro': 'cro',
    'popup-cro': 'cro', 'popups': 'cro', 'onboarding': 'cro', 'onboarding-cro': 'cro', 'signup': 'cro',
    'signup-flow-cro': 'cro', 'paywalls': 'cro', 'paywall-upgrade-cro': 'cro', 'churn-prevention': 'cro',
    'homepage-audit': 'cro',
    'ads': 'marketing', 'paid-ads': 'marketing', 'ad-creative': 'content', 'marketing-ideas': 'marketing',
    'product-marketing': 'marketing', 'product-marketing-context': 'marketing',
    'analytics': 'strategy', 'analytics-tracking': 'strategy', 'pricing': 'strategy', 'pricing-strategy': 'strategy',
    'launch': 'strategy', 'launch-strategy': 'strategy', 'free-tools': 'strategy', 'free-tool-strategy': 'strategy',
    'referrals': 'strategy', 'referral-program': 'strategy', 'revops': 'strategy', 'competitors': 'strategy',
    'competitor-alternatives': 'strategy', 'co-marketing': 'strategy', 'marketing-plan': 'strategy',
    'marketing-psychology': 'strategy', 'positioning-basics': 'strategy',
    'aso': 'seo', 'aso-audit': 'seo', 'schema': 'seo', 'schema-markup': 'seo', 'seo-audit': 'seo',
    'ai-seo': 'seo', 'programmatic-seo': 'seo', 'directory-submissions': 'seo', 'site-architecture': 'seo',
    'ai-discoverability-audit': 'seo', 'ai-discoverability-audit-v2': 'seo',
    'emails': 'outreach', 'email-sequence': 'outreach', 'cold-email': 'outreach', 'cold-outreach-sequence': 'outreach',
    'prospecting': 'outreach', 'public-relations': 'outreach', 'sms': 'outreach', 'lead-magnets': 'outreach',
    'community-marketing': 'outreach', 'sales-enablement': 'outreach', 'newsletter-creation-curation': 'outreach',
    'competitor-profiling': 'research', 'customer-research': 'research', 'competitor-intel-brief': 'research',
    'founder-intelligence': 'research', 'brand-voice-extractor': 'research', 'reddit-insights': 'research',
    'last30days': 'research', 'sherlock': 'research', 'twitter-pull': 'research', 'trends': 'research',
    'ig-dm-analyst': 'research', 'scout': 'research', 'hermes-agent': 'research',
    // Content & copy
    'copywriting': 'content', 'copy-editing': 'content', 'content-strategy': 'content', 'content': 'content',
    'social': 'content', 'social-content': 'content', 'carousel': 'content', 'edit-article': 'content',
    'distill': 'content', 'repurpose': 'content', 'post-thread': 'content', 'draft-post': 'content',
    'vedantify': 'content', 'satire-product-ideas': 'content', 'instagram-web-posting': 'content',
    'de-ai-ify': 'content', 'humanizer': 'content', 'testimonial-collector': 'content', 'case-study-builder': 'content',
    'tweet-draft-reviewer': 'content', 'voice-extractor': 'content', 'writing-beats': 'content',
    'writing-fragments': 'content', 'writing-shape': 'content',
    // Creative & design
    'design-an-interface': 'creative', 'design-consultation': 'creative', 'design-html': 'creative',
    'design-motion-principles': 'creative', 'design-review': 'creative', 'design-shotgun': 'creative',
    'design-taste-frontend': 'creative', 'high-end-visual-design': 'creative', 'industrial-brutalist-ui': 'creative',
    'minimalist-ui': 'creative', 'ui-paradigm-match': 'creative', 'userinterface-wiki': 'creative',
    'stitch-design-taste': 'creative', 'art-direction': 'creative', 'redesign-existing-projects': 'creative',
    'frontend-design': 'creative', 'frontend-slides': 'creative', 'make': 'creative', 'ui-ux-pro-max': 'creative',
    'billion-dollar-design': 'creative', 'image': 'creative', 'colorize': 'creative', 'vibe': 'creative',
    'web-design-guidelines': 'creative',
    // Video & media
    'animate': 'video', 'animate-text': 'video', 'manim-video': 'video', 'talking-head': 'video',
    'video': 'video', 'video-editor-brain': 'video', 'video-use': 'video', 'reel': 'video', 'reel-create': 'video',
    'storyboard': 'video', 'hyperframes': 'video', 'hyperframes-cli': 'video', 'hyperframes-registry': 'video',
    'website-to-hyperframes': 'video', 'remotion-best-practices': 'video', 'record-demo': 'video',
    'youtube-summarizer': 'video', 'sora': 'video',
    // Engineering
    'to-issues': 'engineering', 'triage': 'engineering', 'triage-issue': 'engineering',
    'request-refactor-plan': 'engineering', 'improve-codebase-architecture': 'engineering',
    'migrate-to-shoehorn': 'engineering', 'thermo-nuclear-code-quality-review': 'engineering',
    'devex-review': 'engineering', 'plan-devex-review': 'engineering', 'ubiquitous-language': 'engineering',
    'scaffold-exercises': 'engineering', 'scaffold-fastapi-agent': 'engineering', 'setup-pre-commit': 'engineering',
    'setup-matt-pocock-skills': 'engineering', 'setup-deploy': 'engineering', 'land-and-deploy': 'engineering',
    'document-release': 'engineering', 'diagnose': 'engineering', 'prototype': 'engineering',
    'browser-use': 'engineering', 'gemini-cli': 'engineering', 'codex': 'engineering', 'deploy-to-vercel': 'engineering',
    'vercel-deploy': 'engineering', 'cloudflare-deploy': 'engineering', 'maestri-orchestration': 'engineering',
    'maestri-orchestrator': 'engineering', 'pair-agent': 'engineering', 'git-guardrails-claude-code': 'engineering',
    'setup-browser-cookies': 'engineering', 'open-gstack-browser': 'engineering', 'gstack-upgrade': 'engineering',
    'security-best-practices': 'engineering', 'security-ownership-map': 'engineering', 'security-threat-model': 'engineering',
    'swarm-planner': 'engineering', 'swift-concurrency-expert': 'patterns', 'swiftui-ui-patterns': 'patterns',
    'swiftui-view-refactor': 'patterns', 'macos-spm-app-packaging': 'patterns', 'macos-menubar-tuist-app': 'patterns',
    'figma-implement-design': 'creative', 'magicpath': 'creative', 'jupyter-notebook': 'engineering',
    'openai-docs': 'engineering', 'browser-harness': 'engineering', 'playwright': 'engineering',
    'playwright-interactive': 'engineering', 'screenshot': 'engineering', 'codex-primary-runtime': 'engineering',
    'forge': 'engineering', 'forge-mine': 'engineering', 'forge-ship': 'engineering', 'forge-status': 'engineering',
    'review-queue': 'engineering', 'review': 'engineering', 'retro': 'engineering', 'ship': 'engineering',
    // Project mgmt / product
    'to-prd': 'project-mgmt', 'prd-to-issues': 'project-mgmt', 'prd-to-plan': 'project-mgmt',
    'write-a-prd': 'project-mgmt',
    // Testing
    'qa': 'testing', 'qa-only': 'testing', 'tdd': 'testing',
    // Patterns
    'vercel-composition-patterns': 'patterns', 'vercel-react-best-practices': 'patterns',
    'vercel-react-native-skills': 'patterns', 'gsap': 'creative',
    // Strategy / advisory
    'cso': 'advisory', 'c-level-advisor': 'advisory',
    // Productivity / workflow
    'time-os': 'productivity', 'handoff': 'productivity', 'clarify': 'productivity', 'checkpoint': 'productivity',
    'autoplan': 'productivity', 'find-skills': 'productivity', 'caveman': 'productivity', 'zoom-out': 'productivity',
    'office-hours': 'productivity', 'onboard': 'productivity', 'idea-griller': 'productivity', 'grill-me': 'productivity',
    'grill-with-docs': 'productivity', 'learn': 'productivity', 'teach': 'productivity', 'teach-impeccable': 'productivity',
    'portal-learn': 'productivity', 'save-session': 'productivity', 'daily-briefing-builder': 'productivity',
    'plan-my-day': 'productivity', 'plan-ceo-review': 'productivity', 'plan-eng-review': 'productivity',
    'meeting-prep': 'productivity', 'meeting-prep-cc': 'productivity', 'go-mode': 'productivity', 'browse': 'productivity',
    'gstack': 'productivity', 'defuddle': 'productivity', 'springpod-presentation': 'creative',
    // Obsidian
    'obsidian-bases': 'obsidian', 'obsidian-cli': 'obsidian', 'obsidian-markdown': 'obsidian',
    'obsidian-vault': 'obsidian', 'json-canvas': 'obsidian', 'vault-cleanup-auditor': 'obsidian',
    // Compliance
    'capa-officer': 'compliance', 'fda-consultant-specialist': 'compliance', 'gdpr-dsgvo-expert': 'compliance',
    'information-security-manager-iso27001': 'compliance', 'isms-audit-expert': 'compliance',
    'mdr-745-specialist': 'compliance', 'qms-audit-expert': 'compliance', 'quality-documentation-manager': 'compliance',
    'quality-manager-qmr': 'compliance', 'quality-manager-qms-iso13485': 'compliance',
    'regulatory-affairs-head': 'compliance', 'risk-management-specialist': 'compliance',
  };
  if (exact[nm]) return exact[nm];

  // 2. Prefix families
  if (starts('firecrawl-build')) return 'engineering';
  if (starts('firecrawl')) return 'research';
  if (starts('gsap')) return 'creative';
  if (starts('gsd-', 'gsd:')) return 'gsd';
  if (starts('gstack')) return 'engineering';
  if (starts('hyperframes', 'website-to-hyperframes')) return 'video';
  if (starts('swiftui', 'swift-', 'macos-')) return 'patterns';
  if (starts('security-')) return 'engineering';
  if (starts('design-', 'userinterface')) return 'creative';
  if (starts('writing-', 'write-a-skill')) return 'content';
  if (starts('obsidian', 'json-canvas')) return 'obsidian';
  if (starts('maestri', 'forge')) return 'engineering';

  // 3. Keyword engine (specific → general)
  if (has('obsidian', 'json canvas', 'wikilink', '.canvas')) return 'obsidian';
  if (has('video', ' animation', 'animate', 'remotion', 'subtitle', 'b-roll', 'storyboard', 'talking head', 'manim', 'voiceover')) return 'video';
  if (has('design system', 'ui/ux', 'ui ux', 'css', 'typography', 'visual design', 'color palette', 'brutalis', 'minimalist', 'frontend design', 'design taste', 'moodboard')) return 'creative';
  if (has(' seo', 'schema markup', 'structured data', 'app store', ' aso', 'serp', 'rich result', 'sitemap', 'programmatic seo')) return 'seo';
  if (has('conversion', ' cro', 'a/b test', 'ab test', 'split test', 'paywall', 'popup', 'onboarding', 'sign-up', 'signup', 'landing page', 'activation')) return 'cro';
  if (has('linkedin')) return 'linkedin';
  if (has('cold email', 'outreach', 'prospect', 'lead magnet', 'newsletter', 'public relations', 'press release', 'cold outreach', ' sms')) return 'outreach';
  if (has('copywriting', 'copy editing', 'content strateg', 'article', 'blog post', 'social media', 'carousel', 'caption', 'tweet', 'thread', 'repurpose', 'editorial', 'ghostwrit')) return 'content';
  if (has('competitor', 'market research', 'reddit', 'trends', 'intelligence', 'scrape', 'crawl', 'firecrawl', 'audience research', 'customer research', 'founder intel')) return 'research';
  if (has('pricing', 'positioning', 'go-to-market', 'gtm', 'growth strateg', 'analytics', 'revops', 'referral', 'launch plan', 'monetization')) return 'strategy';
  if (has('tdd', 'unit test', 'e2e', 'test-driven', 'pytest', 'jest', 'quality assurance')) return 'testing';
  if (has('swift', 'swiftui', 'react', 'next.js', 'django', 'golang', 'postgres', 'docker', 'api design', 'design pattern')) return 'patterns';
  if (has('deploy', 'ci/cd', 'vercel', 'cloudflare', 'refactor', 'codebase', 'debug', 'git ', 'pull request', 'issue', 'prd', 'scaffold', 'playwright', 'browser', 'threat model', 'security')) return 'engineering';
  if (has('iso ', 'gdpr', 'fda', 'qms', 'isms', 'regulatory', '13485', '27001', 'capa', 'mdr')) return 'compliance';
  if (has('finance', 'invoice', 'budget', 'cash flow', 'p&l')) return 'finance';
  if (has('product manage', 'user flow', 'roadmap', 'feature spec', 'user research', 'jobs to be done')) return 'product';
  if (has('milestone', 'sprint', 'backlog', 'project management', 'phase plan', 'kanban')) return 'project-mgmt';
  if (has('advisor', 'c-level', 'cto', 'cfo', 'ceo')) return 'advisory';
  if (has('marketing')) return 'marketing';
  if (has('meeting', 'daily brief', 'plan my day', 'orchestrat', 'handoff', 'workflow', 'time management', 'calendar', 'productivity')) return 'productivity';

  // 4. Agent default — keep the catalog tidy
  if (agent === 'codex') return 'engineering';
  if (agent === 'gemini') return 'productivity';
  return 'uncategorized';
}

// ── Scan every agent dir; dedupe by name, union the agent set ──
function scanAgents() {
  const byName = new Map(); // lowerName -> entry { ..., agents: Set }
  for (const { agent, dir } of AGENT_DIRS) {
    console.log(`\n  Scanning ${agent}: ${dir}`);
    if (!fs.existsSync(dir)) { console.log(`  (no dir — skipped)`); continue; }
    const files = findSkillFiles(dir);
    let count = 0;
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const meta = parseFrontmatter(content);
        const dirName = path.basename(path.dirname(filePath));
        const name = (meta.name || dirName).trim();
        const key = name.toLowerCase().replace(/^\//, '');
        if (!key) continue;

        if (byName.has(key)) {
          byName.get(key).agents.add(agent); // skill exists in another agent too
          count++;
          continue;
        }

        let desc = meta.description || '';
        if (!desc) {
          const after = content.replace(/^---[\s\S]*?---\s*/, '');
          const firstLine = after.split('\n').find(l => l.trim() && !l.startsWith('#'));
          desc = firstLine ? firstLine.trim() : 'No description';
        }
        const fullDesc = desc.length > 500 ? desc.slice(0, 497) + '...' : desc;
        const shortDesc = desc.length > 100 ? desc.slice(0, 97) + '...' : desc;

        byName.set(key, {
          cmd: name.startsWith('/') ? name : `/${name}`,
          desc: shortDesc,
          fullDesc: fullDesc !== shortDesc ? fullDesc : undefined,
          input: inferInputType(fullDesc, name),
          category: inferCategory({ name: key, desc: shortDesc, fullDesc, agent, baseDir: dir, skillPath: filePath }),
          agents: new Set([agent]),
          source: 'scanned',
        });
        count++;
        if (VERBOSE) console.log(`    [ok] /${key} → ${byName.get(key).category}`);
      } catch (err) {
        if (VERBOSE) console.log(`    [err] ${filePath}: ${err.message}`);
      }
    }
    console.log(`  ${agent}: ${count} SKILL.md scanned`);
  }
  return [...byName.values()];
}

// ── Static skills (plugins that can't be auto-scanned — Claude-only) ──
function getStaticSkills() {
  return [
    // Superpowers plugin
    { cmd: "/brainstorming", desc: "Collaborative design before any creative work", input: "text", category: "superpowers" },
    { cmd: "/writing-plans", desc: "Create implementation plans from specs", input: "text", category: "superpowers" },
    { cmd: "/executing-plans", desc: "Execute written plans with review", input: "auto", category: "superpowers" },
    { cmd: "/dispatching-parallel-agents", desc: "Run 2+ independent tasks in parallel", input: "text", category: "superpowers" },
    { cmd: "/test-driven-development", desc: "TDD workflow: tests first, then implement", input: "code", category: "superpowers" },
    { cmd: "/requesting-code-review", desc: "Review completed work against standards", input: "auto", category: "superpowers" },
    { cmd: "/receiving-code-review", desc: "Process and implement review feedback", input: "text", category: "superpowers" },
    { cmd: "/systematic-debugging", desc: "Debug any bug before proposing fixes", input: "code", category: "superpowers" },
    { cmd: "/verification-before-completion", desc: "Verify work is done before claiming", input: "auto", category: "superpowers" },
    { cmd: "/finishing-a-development-branch", desc: "Decide how to integrate completed work", input: "auto", category: "superpowers" },
    { cmd: "/using-git-worktrees", desc: "Isolate feature work in git worktrees", input: "auto", category: "superpowers" },
    { cmd: "/subagent-driven-development", desc: "Execute plans with independent sub-tasks", input: "text", category: "superpowers" },

    // GSD plugin
    { cmd: "/gsd:new-project", desc: "Initialize project with deep context gathering", input: "text", category: "gsd" },
    { cmd: "/gsd:progress", desc: "Check project progress, route to next action", input: "auto", category: "gsd" },
    { cmd: "/gsd:plan-phase", desc: "Create detailed phase plan with verification", input: "text", category: "gsd" },
    { cmd: "/gsd:execute-phase", desc: "Execute plans with wave-based parallelization", input: "auto", category: "gsd" },
    { cmd: "/gsd:debug", desc: "Systematic debugging with persistent state", input: "text", category: "gsd" },
    { cmd: "/gsd:quick", desc: "Quick task with GSD guarantees", input: "text", category: "gsd" },
    { cmd: "/gsd:resume-work", desc: "Resume from previous session with context", input: "auto", category: "gsd" },
    { cmd: "/gsd:pause-work", desc: "Create context handoff when pausing", input: "auto", category: "gsd" },
    { cmd: "/gsd:check-todos", desc: "List pending todos and select one", input: "auto", category: "gsd" },
    { cmd: "/gsd:add-todo", desc: "Capture idea or task as todo", input: "text", category: "gsd" },
    { cmd: "/gsd:verify-work", desc: "Validate features through conversational UAT", input: "auto", category: "gsd" },
    { cmd: "/gsd:add-tests", desc: "Generate tests based on UAT criteria", input: "auto", category: "gsd" },
    { cmd: "/gsd:map-codebase", desc: "Analyze codebase with parallel mapper agents", input: "auto", category: "gsd" },
    { cmd: "/gsd:new-milestone", desc: "Start new milestone cycle", input: "text", category: "gsd" },
    { cmd: "/gsd:health", desc: "Diagnose planning directory health", input: "auto", category: "gsd" },
    { cmd: "/gsd:help", desc: "Show all GSD commands and usage", input: "auto", category: "gsd" },

    // Everything Claude Code plugin (selected key skills)
    { cmd: "/frontend-design", desc: "Distinctive, production-grade UI design", input: "text", category: "ecc" },
    { cmd: "/tdd", desc: "Test-driven development workflow", input: "code", category: "ecc" },
    { cmd: "/e2e", desc: "Generate and run E2E tests with Playwright", input: "code", category: "ecc" },
    { cmd: "/plan", desc: "Restate requirements, assess risks, create plan", input: "text", category: "ecc" },
    { cmd: "/simplify", desc: "Review changed code for reuse and quality", input: "auto", category: "ecc" },
    { cmd: "/security-review", desc: "OWASP security review for auth, input, secrets", input: "code", category: "ecc" },
    { cmd: "/security-scan", desc: "Scan Claude Code config for vulnerabilities", input: "auto", category: "ecc" },
    { cmd: "/search-first", desc: "Research before coding — find existing solutions", input: "topic", category: "ecc" },
    { cmd: "/investor-materials", desc: "Pitch decks, one-pagers, investor memos", input: "text", category: "ecc" },
    { cmd: "/investor-outreach", desc: "Draft cold emails, intros to investors", input: "text", category: "ecc" },
    { cmd: "/market-research", desc: "Competitive analysis, industry intel", input: "topic", category: "ecc" },
    { cmd: "/article-writing", desc: "Write articles, guides, blog posts", input: "topic", category: "ecc" },
    { cmd: "/content-engine", desc: "Platform-native content systems", input: "topic", category: "ecc" },
    { cmd: "/frontend-slides", desc: "Animation-rich HTML presentations", input: "text", category: "ecc" },
    { cmd: "/vibe", desc: "Full-stack design-to-code orchestrator", input: "text", category: "ecc" },
    { cmd: "/skill-stocktake", desc: "Audit skills for quality", input: "auto", category: "ecc" },

    // Code pattern skills
    { cmd: "/frontend-patterns", desc: "React, Next.js, state management patterns", input: "code", category: "patterns" },
    { cmd: "/backend-patterns", desc: "Backend architecture, API, database patterns", input: "code", category: "patterns" },
    { cmd: "/python-patterns", desc: "Pythonic idioms, PEP 8, type hints", input: "code", category: "patterns" },
    { cmd: "/golang-patterns", desc: "Idiomatic Go patterns and best practices", input: "code", category: "patterns" },
    { cmd: "/springboot-patterns", desc: "Spring Boot architecture patterns", input: "code", category: "patterns" },
    { cmd: "/django-patterns", desc: "Django architecture, DRF, ORM patterns", input: "code", category: "patterns" },
    { cmd: "/swiftui-patterns", desc: "SwiftUI architecture and state management", input: "code", category: "patterns" },
    { cmd: "/docker-patterns", desc: "Docker/Compose for dev and security", input: "code", category: "patterns" },
    { cmd: "/postgres-patterns", desc: "PostgreSQL query optimization and schema", input: "code", category: "patterns" },
    { cmd: "/coding-standards", desc: "Universal coding standards", input: "code", category: "patterns" },
    { cmd: "/deployment-patterns", desc: "CI/CD pipelines, health checks", input: "code", category: "patterns" },
    { cmd: "/database-migrations", desc: "Schema changes, rollbacks, zero-downtime", input: "code", category: "patterns" },
    { cmd: "/api-design", desc: "REST API design patterns", input: "code", category: "patterns" },

    // Testing skills
    { cmd: "/python-testing", desc: "Pytest strategies, fixtures, mocking", input: "code", category: "testing" },
    { cmd: "/golang-testing", desc: "Go table-driven tests, benchmarks, fuzzing", input: "code", category: "testing" },
    { cmd: "/springboot-tdd", desc: "Spring Boot TDD with JUnit 5", input: "code", category: "testing" },
    { cmd: "/django-tdd", desc: "Django testing with pytest-django", input: "code", category: "testing" },
    { cmd: "/go-test", desc: "Go TDD with table-driven tests", input: "code", category: "testing" },
    { cmd: "/go-build", desc: "Fix Go build errors and linter issues", input: "code", category: "testing" },
  ];
}

// ── Merge scanned + static, avoiding duplicates ──
function mergeSkills(scanned, statics) {
  const seen = new Set(scanned.map(s => s.cmd.toLowerCase().replace(/^\//, '')));
  const merged = [...scanned];
  for (const s of statics) {
    const key = s.cmd.toLowerCase().replace(/^\//, '');
    if (!seen.has(key)) {
      merged.push({ ...s, agents: new Set(['claude']), source: 'static' });
      seen.add(key);
    }
  }
  return merged;
}

// ── Build the final data structure ──
function buildOutput(skills) {
  const categories = [
    { id: 'market-suite', icon: '♦', title: 'The /market Suite', group: 'marketing' },
    { id: 'cro', icon: '⚙', title: 'Conversion Optimization', group: 'marketing' },
    { id: 'content', icon: '✎', title: 'Content & Copy', group: 'marketing' },
    { id: 'seo', icon: '\u{1F310}', title: 'SEO & Discovery', group: 'marketing' },
    { id: 'outreach', icon: '✉', title: 'Outreach & Email', group: 'marketing' },
    { id: 'linkedin', icon: '\u{1F465}', title: 'LinkedIn', group: 'marketing' },
    { id: 'strategy', icon: '⚖', title: 'Strategy & Planning', group: 'marketing' },
    { id: 'research', icon: '\u{1F4DA}', title: 'Research & Intelligence', group: 'marketing' },
    { id: 'reports', icon: '\u{1F4CA}', title: 'Reports', group: 'marketing' },
    { id: 'marketing', icon: '\u{1F4E2}', title: 'Marketing (Other)', group: 'marketing' },
    { id: 'engineering', icon: '\u{1F528}', title: 'Engineering Tools', group: 'engineering' },
    { id: 'eng-specialists', icon: '\u{1F9D1}', title: 'Specialist Roles', group: 'engineering' },
    { id: 'patterns', icon: '\u{1F4D0}', title: 'Code Patterns', group: 'engineering' },
    { id: 'testing', icon: '✅', title: 'Testing', group: 'engineering' },
    { id: 'ecc', icon: '\u{1F4A1}', title: 'Dev Tools (ECC)', group: 'engineering' },
    { id: 'product', icon: '\u{1F4E6}', title: 'Product & UX', group: 'business' },
    { id: 'project-mgmt', icon: '\u{1F4CB}', title: 'Project Management', group: 'business' },
    { id: 'advisory', icon: '\u{1F454}', title: 'C-Level Advisory', group: 'business' },
    { id: 'finance', icon: '\u{1F4B0}', title: 'Finance', group: 'business' },
    { id: 'business', icon: '\u{1F4BC}', title: 'Business (Other)', group: 'business' },
    { id: 'compliance', icon: '\u{1F6E1}', title: 'Regulatory & Compliance', group: 'business' },
    { id: 'creative', icon: '\u{1F3A8}', title: 'Creative & Design', group: 'creative' },
    { id: 'video', icon: '\u{1F3AC}', title: 'Video & Media', group: 'creative' },
    { id: 'gsd', icon: '\u{1F680}', title: 'GSD (Get Stuff Done)', group: 'workflow' },
    { id: 'superpowers', icon: '⚡', title: 'Superpowers (Meta-Skills)', group: 'workflow' },
    { id: 'productivity', icon: '\u{23F0}', title: 'Productivity', group: 'workflow' },
    { id: 'obsidian', icon: '\u{1F4C4}', title: 'Obsidian', group: 'workflow' },
    { id: 'uncategorized', icon: '❓', title: 'Other Skills', group: 'workflow' },
  ];

  const grouped = {};
  for (const skill of skills) {
    const cat = skill.category || 'uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    const entry = {
      cmd: skill.cmd,
      desc: skill.desc,
      input: skill.input,
      agents: AGENT_ORDER.filter(a => skill.agents.has(a)),
    };
    if (!entry.agents.length) entry.agents = ['claude'];
    if (skill.fullDesc) entry.fullDesc = skill.fullDesc;
    grouped[cat].push(entry);
  }

  const sections = categories
    .filter(cat => grouped[cat.id] && grouped[cat.id].length > 0)
    .map(cat => ({
      id: cat.id,
      icon: cat.icon,
      title: cat.title,
      group: cat.group,
      commands: grouped[cat.id].sort((a, b) => a.cmd.localeCompare(b.cmd)),
    }));

  const sidebarGroups = {};
  for (const section of sections) {
    if (!sidebarGroups[section.group]) sidebarGroups[section.group] = [];
    sidebarGroups[section.group].push(section.id);
  }

  const totalCommands = sections.reduce((sum, s) => sum + s.commands.length, 0);

  return {
    generatedAt: new Date().toISOString(),
    totalCommands,
    totalSections: sections.length,
    sidebarGroups,
    sections,
  };
}

// ── Generate sections JS from output ──
function generateSectionsJS(output) {
  const sectionLines = output.sections.map(s => {
    const cmds = s.commands.map(c => {
      const parts = [
        `cmd: ${JSON.stringify(c.cmd)}`,
        `desc: ${JSON.stringify(c.desc)}`,
        `input: ${JSON.stringify(c.input)}`,
        `agents: ${JSON.stringify(c.agents)}`,
      ];
      if (c.fullDesc) parts.push(`fullDesc: ${JSON.stringify(c.fullDesc)}`);
      return `      { ${parts.join(', ')} }`;
    }).join(',\n');
    return `    { id: ${JSON.stringify(s.id)}, icon: ${JSON.stringify(s.icon)}, title: ${JSON.stringify(s.title)}, group: ${JSON.stringify(s.group)}, commands: [\n${cmds},\n    ]}`;
  }).join(',\n');

  const sidebarGroupsJS = JSON.stringify(output.sidebarGroups, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');

  return { sectionLines, sidebarGroupsJS };
}

// ── Inject into index.html with atomic write ──
function injectIntoHTML(output) {
  if (!fs.existsSync(HTML_FILE)) {
    console.error(`  ✗ ${HTML_FILE} not found`);
    process.exit(1);
  }
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const originalLineCount = html.split('\n').length;

  const startIdx = html.indexOf(START_MARKER);
  const endIdx = html.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    console.error('  ✗ Markers not found in index.html');
    process.exit(1);
  }
  if (endIdx <= startIdx) {
    console.error('  ✗ End marker appears before start marker — index.html is malformed');
    process.exit(1);
  }

  const existingData = html.slice(html.indexOf('const DATA = {', startIdx), html.indexOf(END_MARKER));
  const treeMatch = existingData.match(/tree:\s*\[([\s\S]*?)\]\s*,\s*\n?\s*sidebarGroups:/);
  const existingTree = treeMatch ? treeMatch[1] : null;
  if (!existingTree) {
    console.error('  ✗ Could not find existing tree data in index.html');
    process.exit(1);
  }

  const { sectionLines, sidebarGroupsJS } = generateSectionsJS(output);

  const newDataBlock = `${START_MARKER}
const DATA = {
  tree: [${existingTree}],
  sidebarGroups: ${sidebarGroupsJS},
  sections: [
${sectionLines},
  ]
};
${END_MARKER}`;

  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx + END_MARKER.length);
  const newHTML = before + newDataBlock + after;

  const newLineCount = newHTML.split('\n').length;
  const lineDiff = Math.abs(newLineCount - originalLineCount) / originalLineCount;

  const checks = [
    { name: 'Has <!DOCTYPE html>', pass: newHTML.includes('<!DOCTYPE html>') },
    { name: 'Has </html>', pass: newHTML.includes('</html>') },
    { name: 'Has start marker', pass: newHTML.includes(START_MARKER) },
    { name: 'Has end marker', pass: newHTML.includes(END_MARKER) },
    { name: 'Has <script>', pass: newHTML.includes('<script>') },
    { name: 'Has </script>', pass: newHTML.includes('</script>') },
    { name: 'Has render()', pass: newHTML.includes('render()') },
    { name: `Line count within 30% (${originalLineCount} → ${newLineCount})`, pass: lineDiff < 0.3 },
  ];

  console.log('\n  ── Validation ──');
  let allPass = true;
  for (const check of checks) {
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`);
    if (!check.pass) allPass = false;
  }
  if (!allPass) {
    console.error('\n  ✗ Validation FAILED — index.html NOT modified');
    if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);
    process.exit(1);
  }

  fs.writeFileSync(TEMP_FILE, newHTML);
  fs.renameSync(TEMP_FILE, HTML_FILE);

  console.log(`\n  ✓ Injected into ${HTML_FILE}`);
  console.log(`  ✓ ${output.totalCommands} commands across ${output.totalSections} categories\n`);
}

// ── Main ──
function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Skills Guide — Multi-Agent Sync    ║');
  console.log('  ╚══════════════════════════════════════╝');

  const scanned = scanAgents();
  const statics = getStaticSkills();
  const merged = mergeSkills(scanned, statics);
  const output = buildOutput(merged);

  const counts = { claude: 0, codex: 0, gemini: 0 };
  merged.forEach(s => AGENT_ORDER.forEach(a => { if (s.agents.has && s.agents.has(a)) counts[a]++; }));

  console.log(`\n  ── Results ──`);
  console.log(`  Scanned:   ${scanned.length} unique skills across agents`);
  console.log(`  Static:    ${statics.length} plugin skills (Claude)`);
  console.log(`  Merged:    ${merged.length} total (deduped)`);
  console.log(`  By agent:  claude ${counts.claude} · codex ${counts.codex} · gemini ${counts.gemini}`);
  console.log(`  Sections:  ${output.totalSections} categories`);
  console.log(`  Commands:  ${output.totalCommands} total`);

  if (DRY_RUN) {
    console.log('\n  [dry-run] Would inject into index.html — skipping.\n');
    for (const s of output.sections) {
      console.log(`  ${s.icon} ${s.title}: ${s.commands.length} commands`);
    }
  } else {
    injectIntoHTML(output);
  }
}

main();
