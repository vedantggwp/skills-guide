#!/usr/bin/env node

/**
 * Skills Guide Sync Script
 *
 * HOW IT WORKS:
 *
 * 1. SCANNING: Walks through ~/.claude/skills/ looking for SKILL.md files.
 *    Each SKILL.md has "frontmatter" at the top (between --- markers) with
 *    metadata like name and description.
 *
 * 2. PARSING: Reads the frontmatter from each SKILL.md to extract:
 *    - name: the slash command (e.g., "copywriting")
 *    - description: what it does
 *    - We also infer the category from the directory structure
 *
 * 3. MERGING: Combines scanned skills with "static" skills that can't be
 *    auto-detected (plugin skills like superpowers, GSD, etc. — these live
 *    in plugin cache directories, not ~/.claude/skills/)
 *
 * 4. OUTPUT: Injects the data directly into index.html between marker
 *    comments (__SKILLS_DATA_START__ and __SKILLS_DATA_END__), so the
 *    page works without any fetch() calls. Uses atomic write (temp file
 *    + validation + rename) to prevent corruption.
 *
 * USAGE:
 *   node sync.js           # Scan and inject into index.html
 *   node sync.js --dry-run # Show what would be found without writing
 *   node sync.js --verbose # Show detailed scan progress
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(require('os').homedir(), '.claude', 'skills');
const HTML_FILE = path.join(__dirname, 'index.html');
const TEMP_FILE = path.join(__dirname, 'index.html.tmp');
const START_MARKER = '// __SKILLS_DATA_START__';
const END_MARKER = '// __SKILLS_DATA_END__';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// ── Step 1: Parse SKILL.md frontmatter ──
// Frontmatter is YAML between --- markers at the top of a markdown file.
// Example:
//   ---
//   name: copywriting
//   description: Write conversion copy for any page type
//   ---
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter = {};
  match[1].split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;
    const key = line.slice(0, colonIdx).trim();
    // Remove quotes if present, trim whitespace
    const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) frontmatter[key] = value;
  });
  return frontmatter;
}

// ── Step 2: Walk a directory recursively to find SKILL.md files ──
// This is a common pattern: "recursive directory traversal"
// We look inside each subdirectory for a SKILL.md file
function findSkillFiles(dir, depth = 0) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  // Don't go too deep — skills are usually 1-3 levels down
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

// ── Step 3: Infer category from directory path ──
// Skills are organized in directories like:
//   ~/.claude/skills/marketing-skill/seo-audit/SKILL.md
//   ~/.claude/skills/engineering/ci-cd/SKILL.md
// We use the parent directory name to guess the category
function inferCategory(skillPath) {
  const relative = path.relative(SKILLS_DIR, skillPath);
  const parts = relative.split(path.sep);

  // Map top-level directories to our category system
  const dirCategoryMap = {
    'market': 'market-suite',
    'marketing-skill': 'marketing',
    'engineering': 'engineering',
    'engineering-team': 'eng-specialists',
    'product-team': 'product',
    'business-growth': 'business',
    'c-level-advisor': 'advisory',
    'finance': 'finance',
    'project-management': 'project-mgmt',
    'regulatory-compliance': 'compliance',
    'documentation': 'productivity',
    'agents': 'engineering',
    'commands': 'productivity',
  };

  // Check the first directory component
  if (parts.length > 1) {
    const topDir = parts[0];
    if (dirCategoryMap[topDir]) return dirCategoryMap[topDir];
  }

  // Fall back: try to match by skill name keywords
  const name = (parts[parts.length - 2] || '').toLowerCase();
  if (name.includes('cro') || name.includes('conversion')) return 'cro';
  if (name.includes('seo')) return 'seo';
  if (name.includes('email') || name.includes('outreach') || name.includes('cold')) return 'outreach';
  if (name.includes('linkedin')) return 'linkedin';
  if (name.includes('copy') || name.includes('content') || name.includes('social')) return 'content';
  if (name.includes('market')) return 'strategy';

  return 'uncategorized';
}

// ── Step 4: Determine input type from description ──
function inferInputType(desc, name) {
  const d = (desc + ' ' + name).toLowerCase();
  if (d.includes('url') || d.includes('audit') || d.includes('website') || d.includes('page')) return 'url';
  if (d.includes('code') || d.includes('test') || d.includes('build') || d.includes('pattern')) return 'code';
  if (d.includes('auto') || d.includes('scan') || d.includes('cleanup')) return 'auto';
  if (d.includes('topic') || d.includes('research') || d.includes('idea') || d.includes('content')) return 'topic';
  return 'text';
}

// ── Step 5: Scan and collect all skills ──
function scanSkills() {
  console.log(`\n  Scanning: ${SKILLS_DIR}\n`);

  const skillFiles = findSkillFiles(SKILLS_DIR);
  console.log(`  Found ${skillFiles.length} SKILL.md files\n`);

  const skills = [];
  const seen = new Set(); // Avoid duplicates

  for (const filePath of skillFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const meta = parseFrontmatter(content);

      // Get name from frontmatter, or fall back to directory name
      const dirName = path.basename(path.dirname(filePath));
      const name = meta.name || dirName;

      // Skip duplicates (same skill in multiple locations)
      if (seen.has(name.toLowerCase())) {
        if (VERBOSE) console.log(`  [dup]  /${name}`);
        continue;
      }
      seen.add(name.toLowerCase());

      // Get description — first line of frontmatter description,
      // or first paragraph after frontmatter
      let desc = meta.description || '';
      if (!desc) {
        const afterFrontmatter = content.replace(/^---[\s\S]*?---\s*/, '');
        const firstLine = afterFrontmatter.split('\n').find(l => l.trim() && !l.startsWith('#'));
        desc = firstLine ? firstLine.trim().slice(0, 100) : 'No description';
      }

      // Full description for detail view (up to 500 chars)
      const fullDesc = desc.length > 500 ? desc.slice(0, 497) + '...' : desc;
      // Truncate for card preview
      if (desc.length > 100) desc = desc.slice(0, 97) + '...';

      const category = inferCategory(filePath);
      const inputType = inferInputType(fullDesc, name);

      skills.push({
        cmd: name.startsWith('/') ? name : `/${name}`,
        desc,
        fullDesc: fullDesc !== desc ? fullDesc : undefined,
        input: inputType,
        category,
        source: 'scanned',
      });

      if (VERBOSE) console.log(`  [ok]   ${skills[skills.length - 1].cmd} → ${category}`);
    } catch (err) {
      if (VERBOSE) console.log(`  [err]  ${filePath}: ${err.message}`);
    }
  }

  return skills;
}

// ── Step 6: Static skills (plugins that can't be auto-scanned) ──
// These live in plugin cache dirs, not ~/.claude/skills/
// We maintain them manually here — update when you add/remove plugins
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

    // Obsidian
    { cmd: "obsidian-markdown", desc: "Obsidian Flavored Markdown (wikilinks, callouts)", input: "auto", category: "obsidian" },
    { cmd: "obsidian CLI", desc: "Read, create, search vault notes", input: "text", category: "obsidian" },
    { cmd: "obsidian-bases", desc: "Database-like views with .base files", input: "auto", category: "obsidian" },
    { cmd: "json-canvas", desc: "Visual canvas with .canvas files", input: "auto", category: "obsidian" },
    { cmd: "defuddle parse <url> --md", desc: "Extract clean markdown from web pages", input: "url", category: "obsidian" },
  ];
}

// ── Step 7: Merge scanned + static, avoiding duplicates ──
function mergeSkills(scanned, statics) {
  const seen = new Set(scanned.map(s => s.cmd.toLowerCase().replace(/^\//, '')));
  const merged = [...scanned];

  for (const s of statics) {
    const key = s.cmd.toLowerCase().replace(/^\//, '');
    if (!seen.has(key)) {
      merged.push({ ...s, source: 'static' });
      seen.add(key);
    }
  }

  return merged;
}

// ── Step 8: Build the final data structure ──
function buildOutput(skills) {
  // Category definitions — order matters (this is the display order)
  const categories = [
    { id: 'market-suite', icon: '\u2666', title: 'The /market Suite', group: 'marketing' },
    { id: 'cro', icon: '\u2699', title: 'Conversion Optimization', group: 'marketing' },
    { id: 'content', icon: '\u270E', title: 'Content & Copy', group: 'marketing' },
    { id: 'seo', icon: '\u{1F310}', title: 'SEO & Discovery', group: 'marketing' },
    { id: 'outreach', icon: '\u2709', title: 'Outreach & Email', group: 'marketing' },
    { id: 'linkedin', icon: '\u{1F465}', title: 'LinkedIn', group: 'marketing' },
    { id: 'strategy', icon: '\u2696', title: 'Strategy & Planning', group: 'marketing' },
    { id: 'research', icon: '\u{1F4DA}', title: 'Research & Intelligence', group: 'marketing' },
    { id: 'reports', icon: '\u{1F4CA}', title: 'Reports', group: 'marketing' },
    { id: 'marketing', icon: '\u{1F4E2}', title: 'Marketing (Other)', group: 'marketing' },
    { id: 'engineering', icon: '\u{1F528}', title: 'Engineering Tools', group: 'engineering' },
    { id: 'eng-specialists', icon: '\u{1F9D1}', title: 'Specialist Roles', group: 'engineering' },
    { id: 'patterns', icon: '\u{1F4D0}', title: 'Code Patterns', group: 'engineering' },
    { id: 'testing', icon: '\u2705', title: 'Testing', group: 'engineering' },
    { id: 'ecc', icon: '\u{1F4A1}', title: 'Dev Tools (ECC)', group: 'engineering' },
    { id: 'product', icon: '\u{1F4E6}', title: 'Product & UX', group: 'business' },
    { id: 'project-mgmt', icon: '\u{1F4CB}', title: 'Project Management', group: 'business' },
    { id: 'advisory', icon: '\u{1F454}', title: 'C-Level Advisory', group: 'business' },
    { id: 'finance', icon: '\u{1F4B0}', title: 'Finance', group: 'business' },
    { id: 'business', icon: '\u{1F4BC}', title: 'Business (Other)', group: 'business' },
    { id: 'compliance', icon: '\u{1F6E1}', title: 'Regulatory & Compliance', group: 'business' },
    { id: 'gsd', icon: '\u{1F680}', title: 'GSD (Get Stuff Done)', group: 'workflow' },
    { id: 'superpowers', icon: '\u26A1', title: 'Superpowers (Meta-Skills)', group: 'workflow' },
    { id: 'productivity', icon: '\u{23F0}', title: 'Productivity', group: 'workflow' },
    { id: 'obsidian', icon: '\u{1F4C4}', title: 'Obsidian', group: 'workflow' },
    { id: 'uncategorized', icon: '\u2753', title: 'Other Skills', group: 'workflow' },
  ];

  // Group skills by category
  const grouped = {};
  for (const skill of skills) {
    const cat = skill.category || 'uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    const entry = { cmd: skill.cmd, desc: skill.desc, input: skill.input };
    if (skill.fullDesc) entry.fullDesc = skill.fullDesc;
    grouped[cat].push(entry);
  }

  // Build sections (only include categories that have skills)
  const sections = categories
    .filter(cat => grouped[cat.id] && grouped[cat.id].length > 0)
    .map(cat => ({
      id: cat.id,
      icon: cat.icon,
      title: cat.title,
      group: cat.group,
      commands: grouped[cat.id].sort((a, b) => a.cmd.localeCompare(b.cmd)),
    }));

  // Build sidebar groups
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

// ── Step 9: Build the JS DATA object string for injection ──
// This produces the exact JavaScript that goes between the markers
function buildDataString(output) {
  const lines = ['const DATA = {'];

  // Tree (keep the existing decision tree — it's curated, not auto-generated)
  // We read it from the current index.html so it's preserved
  return null; // signal to preserve tree from existing file
}

// ── Step 10: Generate sections JS from output ──
function generateSectionsJS(output) {
  const sectionLines = output.sections.map(s => {
    const cmds = s.commands.map(c => {
      const parts = [`cmd: ${JSON.stringify(c.cmd)}`, `desc: ${JSON.stringify(c.desc)}`, `input: ${JSON.stringify(c.input)}`];
      if (c.fullDesc) parts.push(`fullDesc: ${JSON.stringify(c.fullDesc)}`);
      return `      { ${parts.join(', ')} }`;
    }).join(',\n');
    return `    { id: ${JSON.stringify(s.id)}, icon: ${JSON.stringify(s.icon)}, title: ${JSON.stringify(s.title)}, group: ${JSON.stringify(s.group)}, commands: [\n${cmds},\n    ]}`;
  }).join(',\n');

  const sidebarGroupsJS = JSON.stringify(output.sidebarGroups, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');

  return { sectionLines, sidebarGroupsJS };
}

// ── Step 11: Inject into index.html with atomic write ──
function injectIntoHTML(output) {
  // Read current HTML
  if (!fs.existsSync(HTML_FILE)) {
    console.error(`  ✗ ${HTML_FILE} not found`);
    process.exit(1);
  }
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const originalLineCount = html.split('\n').length;

  // Find markers
  const startIdx = html.indexOf(START_MARKER);
  const endIdx = html.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    console.error('  ✗ Markers not found in index.html');
    console.error('    Expected: ' + START_MARKER);
    console.error('    Expected: ' + END_MARKER);
    process.exit(1);
  }

  // Extract existing tree (between DATA = { and sections:)
  const existingData = html.slice(
    html.indexOf('const DATA = {', startIdx),
    html.indexOf(END_MARKER)
  );
  const treeMatch = existingData.match(/tree:\s*\[([\s\S]*?)\],\s*\n\s*sidebarGroups:/);
  const existingTree = treeMatch ? treeMatch[1] : null;

  if (!existingTree) {
    console.error('  ✗ Could not find existing tree data in index.html');
    process.exit(1);
  }

  // Build new DATA block
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

  // Replace the content between (and including) markers
  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx + END_MARKER.length);
  const newHTML = before + newDataBlock + after;

  // ── Validation ──
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
    { name: `Line count within 20% (${originalLineCount} → ${newLineCount})`, pass: lineDiff < 0.2 },
  ];

  console.log('\n  ── Validation ──');
  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}`);
    if (!check.pass) allPass = false;
  }

  if (!allPass) {
    console.error('\n  ✗ Validation FAILED — index.html NOT modified');
    if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);
    process.exit(1);
  }

  // Write to temp file first (atomic)
  fs.writeFileSync(TEMP_FILE, newHTML);
  // Rename temp → real (atomic on same filesystem)
  fs.renameSync(TEMP_FILE, HTML_FILE);

  console.log(`\n  ✓ Injected into ${HTML_FILE}`);
  console.log(`  ✓ ${output.totalCommands} commands across ${output.totalSections} categories\n`);
}

// ── Main ──
function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║     Skills Guide — Sync Script       ║');
  console.log('  ╚══════════════════════════════════════╝');

  const scanned = scanSkills();
  const statics = getStaticSkills();
  const merged = mergeSkills(scanned, statics);
  const output = buildOutput(merged);

  console.log(`  ── Results ──`);
  console.log(`  Scanned:  ${scanned.length} skills from ~/.claude/skills/`);
  console.log(`  Static:   ${statics.length} skills from plugins`);
  console.log(`  Merged:   ${merged.length} total (deduped)`);
  console.log(`  Sections: ${output.totalSections} categories`);
  console.log(`  Commands: ${output.totalCommands} total`);

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
