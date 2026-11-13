// Type-check every ```ts code block in skills/**/SKILL.md against the built package.
//
// Usage: pnpm build && pnpm check:skill
//
// Each ```ts (or ```typescript) block becomes its own module in .skill-check/ (gitignored),
// compiled with the same options as the dev workers (dev/main-worker/tsconfig.json).
// `import ... from 'cf-logger'` resolves to this package's dist/ through package self-reference,
// so blocks are checked against the API that actually ships.
//
// Opt-out marker: put `wrong` after the language on the opening fence line to skip a block:
//
//   ```ts wrong
//   logger.error('msg', err) // a deliberately wrong example
//   ```
//
// Use it only for counter-examples. Every other ts block must compile on its own.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(root, 'skills')
const outDir = join(root, '.skill-check')
const SKIP_MARKER = 'wrong'
const TS_LANGS = new Set(['ts', 'typescript'])

/** Recursively list SKILL.md files under `dir`. */
function findSkillFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findSkillFiles(path))
    else if (entry.name === 'SKILL.md') found.push(path)
  }
  return found
}

/** Extract fenced ts blocks as { code, startLine, skipped }; startLine is the first code line (1-based). */
function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/)
  const blocks = []
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!open) {
      const match = /^\s*(`{3,})\s*(\S*)\s*(.*)$/.exec(line)
      if (match)
        open = {
          fence: match[1],
          lang: match[2],
          flags: match[3].split(/\s+/),
          body: [],
          start: i + 2,
        }
    } else if (line.trim().startsWith(open.fence) && line.trim().replaceAll('`', '') === '') {
      if (TS_LANGS.has(open.lang)) {
        blocks.push({
          code: open.body.join('\n'),
          startLine: open.start,
          skipped: open.flags.includes(SKIP_MARKER),
        })
      }
      open = null
    } else {
      open.body.push(line)
    }
  }
  if (open) throw new Error(`Unclosed code fence opened on line ${open.start - 1}`)
  return blocks
}

const skillFiles = findSkillFiles(skillsDir)
if (skillFiles.length === 0) {
  console.error(`No SKILL.md files found under ${relative(root, skillsDir)}/`)
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/** Generated file name → { source, startLine } for mapping tsc errors back to SKILL.md. */
const origins = new Map()
let skippedCount = 0
for (const file of skillFiles) {
  const source = relative(root, file).split(sep).join('/')
  const skillName = relative(skillsDir, dirname(file)).split(sep).join('-')
  extractBlocks(readFileSync(file, 'utf8')).forEach((block, index) => {
    if (block.skipped) {
      skippedCount++
      return
    }
    const name = `${skillName}-${String(index + 1).padStart(2, '0')}.ts`
    writeFileSync(join(outDir, name), `${block.code}\n`)
    origins.set(name, { source, startLine: block.startLine })
  })
}

if (origins.size === 0) {
  console.error('No ```ts blocks found to check; the extractor or the skill is broken.')
  process.exit(1)
}

// Mirrors dev/main-worker/tsconfig.json, plus `moduleDetection: force` so blocks without
// imports are still isolated modules.
const tsconfig = {
  compilerOptions: {
    target: 'esnext',
    module: 'esnext',
    moduleResolution: 'bundler',
    moduleDetection: 'force',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    lib: ['ESNext', 'DOM'],
    types: ['@types/node', '@cloudflare/workers-types'],
    allowSyntheticDefaultImports: true,
  },
  include: ['*.ts'],
}
writeFileSync(join(outDir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)

const tsc = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin',
  'tsc',
)
const result = spawnSync(process.execPath, [tsc, '-p', outDir, '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
})
if (result.error) throw result.error

// Rewrite `.skill-check/<file>.ts(line,col)` to `skills/<name>/SKILL.md:<line>:<col>`.
const output = `${result.stdout}${result.stderr}`.replace(
  /(?:[^\s(]*[\\/])?\.skill-check[\\/]([\w.-]+\.ts)\((\d+),(\d+)\)/g,
  (whole, name, line, col) => {
    const origin = origins.get(name)
    if (!origin) return whole
    return `${origin.source}:${origin.startLine + Number(line) - 1}:${col} (${name})`
  },
)

const summary = `${origins.size} snippet(s) checked, ${skippedCount} skipped (\`${SKIP_MARKER}\`)`
if (result.status !== 0) {
  process.stdout.write(output)
  console.error(`\ncheck:skill failed: ${summary}. Generated files are in .skill-check/.`)
  process.exit(result.status ?? 1)
}
console.log(`check:skill passed: ${summary}.`)
