# Publish Logger Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/logger` independently buildable, typechecked, documented, and safe to publish as `@cf-logger/logger`.

**Architecture:** Keep the public package surface limited to `@cf-logger/logger`, `@cf-logger/logger/hono`, and `@cf-logger/logger/workers`. Use `tsdown` to emit JavaScript and declarations into `packages/logger/dist`, while treating `workers/` as repo-local e2e fixtures that verify real Cloudflare Worker behavior before release.

**Tech Stack:** TypeScript, tsdown, Vitest, Pino, Hono optional peer dependency, Wrangler for local e2e fixtures.

---

## File Structure

- Modify `packages/logger/package.json`: publish metadata, build/typecheck/pack scripts, export map pointing to `dist`, dev dependencies.
- Create `packages/logger/tsdown.config.ts`: tsdown library build for three entry points, declaration generation, dependency externalization, package validation.
- Modify `packages/logger/tsconfig.json`: declaration-friendly compiler settings and package-local typechecking.
- Modify `packages/logger/src/workers.ts`: export a reusable traced service binding type and env logger helper.
- Modify `packages/logger/src/index.ts`: export the env helper if it belongs in the root entry point.
- Modify `packages/logger/src/middleware.ts`: make Hono error handling explicit and configurable.
- Modify `packages/logger/src/hono.ts`: export any new middleware option types.
- Modify or add tests under `packages/logger/src/*.test.ts`: cover exported type/helper behavior and Hono error handling.
- Modify `packages/logger/README.md`: publish install/build/runtime/DX docs.
- Modify root `package.json`: add root scripts for package build, typecheck, pack, and e2e.
- Create `scripts/e2e-local.ps1`: repo-local e2e harness that starts `pnpm dev`, probes Worker routes, and stops only the process it started.
- Modify `.gitignore`: ensure `packages/logger/dist`, package tarballs, and e2e temporary logs are ignored unless the project intentionally commits build output.

## Task 1: Package Build With tsdown

**Files:**
- Modify: `packages/logger/package.json`
- Create: `packages/logger/tsdown.config.ts`
- Modify: `packages/logger/tsconfig.json`
- Test: package build output under `packages/logger/dist`

- [ ] **Step 1: Add build scripts and publish metadata**

Update `packages/logger/package.json` to this shape:

```json
{
  "name": "@cf-logger/logger",
  "version": "0.0.1",
  "description": "Structured logging and trace propagation for Cloudflare Workers and Node.js.",
  "type": "module",
  "sideEffects": false,
  "files": [
    "dist",
    "README.md",
    "package.json"
  ],
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepack": "pnpm run build && pnpm run typecheck && pnpm run test",
    "pack:dry": "pnpm pack --dry-run"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./hono": {
      "types": "./dist/hono.d.ts",
      "import": "./dist/hono.js"
    },
    "./workers": {
      "types": "./dist/workers.d.ts",
      "import": "./dist/workers.js"
    }
  },
  "types": "./dist/index.d.ts",
  "dependencies": {
    "pino": "catalog:"
  },
  "peerDependencies": {
    "hono": "catalog:"
  },
  "peerDependenciesMeta": {
    "hono": {
      "optional": true
    }
  },
  "devDependencies": {
    "@cloudflare/workers-types": "catalog:",
    "@types/node": "catalog:",
    "hono": "catalog:",
    "publint": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "wrangler": "catalog:"
  }
}
```

If `catalog:` entries do not exist for `tsdown` and `publint` yet, Task 1 Step 2 adds them at workspace level.

- [ ] **Step 2: Add workspace catalog entries**

Update the `catalog` section in `pnpm-workspace.yaml`:

```yaml
  'tsdown': '^0.22.3'
  'publint': '^0.3.21'
```

If installation resolves newer compatible versions, keep the lockfile-resolved versions. Do not change unrelated catalog entries.

- [ ] **Step 3: Install dependencies**

Run:

```powershell
pnpm install
```

Expected: exits `0`, updates `pnpm-lock.yaml`, and installs `tsdown`, `publint`, and `typescript` for `@cf-logger/logger`.

- [ ] **Step 4: Create tsdown config**

Create `packages/logger/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    hono: './src/hono.ts',
    workers: './src/workers.ts',
  },
  dts: {
    resolver: 'tsc',
  },
  format: ['esm'],
  platform: 'neutral',
  sourcemap: true,
  clean: true,
  publint: true,
  deps: {
    neverBundle: ['pino', 'hono', 'cloudflare:workers', 'node:async_hooks'],
  },
})
```

Rationale: this package should not bundle `pino` or optional `hono`; `cloudflare:workers` and `node:async_hooks` must remain runtime-provided imports.

- [ ] **Step 5: Adjust package tsconfig for package-local typechecking**

Update `packages/logger/tsconfig.json` only if needed so it includes source and tests for `tsc --noEmit`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node", "@cloudflare/workers-types"],
    "allowImportingTsExtensions": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "vitest.config.ts", "tsdown.config.ts"]
}
```

If the existing config already has equivalent settings, make the smallest change that enables `pnpm --filter @cf-logger/logger typecheck`.

- [ ] **Step 6: Build**

Run:

```powershell
pnpm --filter @cf-logger/logger build
```

Expected:

```text
dist/index.js
dist/index.d.ts
dist/hono.js
dist/hono.d.ts
dist/workers.js
dist/workers.d.ts
```

- [ ] **Step 7: Verify pack contents**

Run:

```powershell
pnpm --filter @cf-logger/logger pack:dry
```

Expected: tarball contents include `dist/**`, `README.md`, and `package.json`; they do not include `src/**/*.test.ts`, `vitest.config.ts`, `tsdown.config.ts`, or local Worker fixtures.

- [ ] **Step 8: Commit**

Run:

```powershell
git add packages/logger/package.json packages/logger/tsdown.config.ts packages/logger/tsconfig.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build: add tsdown package build"
```

## Task 2: Public Types and Env Helper DX

**Files:**
- Modify: `packages/logger/src/types.ts`
- Modify: `packages/logger/src/workers.ts`
- Modify: `packages/logger/src/index.ts`
- Test: `packages/logger/src/workers.test.ts`

- [ ] **Step 1: Write failing tests for public Worker binding type and env helper**

Add to `packages/logger/src/workers.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { TracedServiceBinding } from './workers'
import { loggerOptionsFromEnv } from './workers'

interface ExampleSession {
  add(a: number, b: number): Promise<number>
}

describe('public worker DX helpers', () => {
  test('TracedServiceBinding describes the session factory contract', () => {
    const binding: TracedServiceBinding<ExampleSession> = {
      session(traceparent, fields, tracestate) {
        expect(traceparent).toBe('00-11111111111111111111111111111111-2222222222222222-01')
        expect(fields).toEqual({ requestId: 'req-1' })
        expect(tracestate).toBe('vendor=value')
        return {
          async add(a, b) {
            return a + b
          },
        }
      },
    }

    return expect(
      binding
        .session('00-11111111111111111111111111111111-2222222222222222-01', { requestId: 'req-1' }, 'vendor=value')
        .add(2, 3),
    ).resolves.toBe(5)
  })

  test('loggerOptionsFromEnv maps Cloudflare env conventions', () => {
    expect(loggerOptionsFromEnv({
      NAME: 'api',
      LOG_LEVEL: 'debug',
      ENVIRONMENT: 'production',
      VERSION: '1.2.3',
    })).toEqual({
      service: 'api',
      level: 'debug',
      environment: 'production',
      version: '1.2.3',
    })
  })

  test('loggerOptionsFromEnv has safe defaults', () => {
    expect(loggerOptionsFromEnv({})).toEqual({
      service: 'unknown',
      level: 'info',
      environment: 'unknown',
      version: 'unknown',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify red**

Run:

```powershell
pnpm --filter @cf-logger/logger test -- src/workers.test.ts
```

Expected: fails because `TracedServiceBinding` and `loggerOptionsFromEnv` are not exported yet.

- [ ] **Step 3: Export public type and helper**

Modify `packages/logger/src/workers.ts`:

```ts
export type TracedServiceBinding<T> = {
  session(traceparent: string, fields?: LogFields, tracestate?: string): T
}

export function loggerOptionsFromEnv(env: unknown): LoggerOptions {
  const e = env as Record<string, unknown>
  return {
    service: (e.NAME as string) ?? 'unknown',
    level: ((e.LOG_LEVEL as string) ?? 'info') as LogLevel,
    environment: (e.ENVIRONMENT as string) ?? 'unknown',
    version: (e.VERSION as string) ?? 'unknown',
  }
}
```

Replace internal calls to `envLoggerOptions(this.env)` with `loggerOptionsFromEnv(this.env)`, then delete the private `envLoggerOptions()` helper.

Update binding parameters in `tracedSession()` and `withTrace()`:

```ts
export function tracedSession<T>(
  binding: TracedServiceBinding<T>,
  fields?: LogFields,
): T {
  const trace = getTraceContext()
  const traceparent = trace ? buildTraceparent(trace) : ''
  return binding.session(traceparent, fields, trace?.tracestate)
}

export async function withTrace<T, R>(
  binding: TracedServiceBinding<T>,
  fn: (session: T) => Promise<R> | R,
  fields?: LogFields,
): Promise<R> {
  const session = tracedSession(binding, fields)
  return fn(session)
}
```

- [ ] **Step 4: Export helper from root entry point**

Modify `packages/logger/src/index.ts`:

```ts
export type { TracedServiceBinding } from './workers'
export { loggerOptionsFromEnv } from './workers'
```

Keep `TracedSession`, `tracedWorker`, and `withTrace` on the `./workers` subpath; root only gets the lightweight type/helper.

- [ ] **Step 5: Run tests to verify green**

Run:

```powershell
pnpm --filter @cf-logger/logger test -- src/workers.test.ts
```

Expected: all tests in `workers.test.ts` pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add packages/logger/src/workers.ts packages/logger/src/index.ts packages/logger/src/workers.test.ts
git commit -m "feat: expose traced service binding helpers"
```

## Task 3: Hono Error Observation Contract

**Files:**
- Modify: `packages/logger/src/middleware.ts`
- Test: `packages/logger/src/middleware.test.ts`

- [ ] **Step 1: Add failing tests that logger middleware does not own error responses**

Add tests to `packages/logger/src/middleware.test.ts`:

```ts
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, test } from 'vitest'
import { createLogger, _captureEntries, _reset } from './logger'
import { useLogger } from './middleware'

describe('useLogger error observation', () => {
  test('lets app-level Hono error handling own thrown route errors', async () => {
    const entries = _captureEntries()
    const app = new Hono()
    app.onError((err, c) => c.text(`handled: ${err.message}`, 418))
    app.use(useLogger(createLogger({ service: 'api', level: 'info' })))
    app.get('/boom', () => {
      throw new Error('boom')
    })

    const res = await app.request('/boom')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('handled: boom')
    expect(entries).toContainEqual(expect.objectContaining({
      message: 'request.end GET /boom',
      statusCode: 418,
    }))
    expect(entries).toContainEqual(expect.objectContaining({
      message: 'request.error GET /boom',
      statusCode: 418,
      err: expect.objectContaining({ message: 'boom' }),
    }))
    _reset()
  })

  test('logs HTTPException status when the thrown error carries one', async () => {
    const entries = _captureEntries()
    const app = new Hono()
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return err.getResponse()
      }
      return c.text('handled', 500)
    })
    app.use(useLogger(createLogger({ service: 'api', level: 'info' })))
    app.get('/bad-request', () => {
      throw new HTTPException(400, { message: 'bad request' })
    })

    const res = await app.request('/bad-request')
    expect(res.status).toBe(400)
    expect(entries).toContainEqual(expect.objectContaining({
      message: 'request.end GET /bad-request',
      statusCode: 400,
    }))
    _reset()
  })
})
```

If existing test setup already calls `_reset()` in hooks, use the existing pattern instead of duplicating cleanup.

- [ ] **Step 2: Run tests to verify red**

Run:

```powershell
pnpm --filter @cf-logger/logger test -- src/middleware.test.ts
```

Expected: app-level error handler ownership test fails because current middleware catches errors and replaces the response before Hono's `onError()` can own it.

- [ ] **Step 3: Replace response-owning catch with Hono `c.error` observation**

Modify `packages/logger/src/middleware.ts`:

```ts
export function useLogger<T extends LogFields = LogFields>(
  loggerOrFactory: Logger<T> | ((c: Parameters<MiddlewareHandler>[0]) => Logger<T>),
): MiddlewareHandler {
  return async (c, next) => {
    // existing setup...

    await runWithLogger(
      { logger, trace },
      async () => {
        // existing context setup...
        await next()

        const duration = Date.now() - start
        const statusCode = c.res.status

        if (c.error) {
          logger.error({ err: c.error, method, path, statusCode, duration }, `request.error ${method} ${path}`)
        }
        logger.info({ method, path, statusCode, duration }, `request.end ${method} ${path}`)

        c.header('X-Request-Id', requestId)
        c.header('X-Trace-Id', trace.traceId)
        c.header('traceparent', buildTraceparent(trace))
        if (trace.tracestate) {
          c.header('tracestate', trace.tracestate)
        }
      },
    )
  }
}
```

This intentionally does not catch errors. Hono's compose layer catches downstream `Error` values, sets `c.error`, runs `app.onError()`, assigns the returned response to `c.res`, then returns to upstream middleware. That means this middleware can observe `c.error` and final `c.res.status` after `await next()` without owning or guessing the response.

- [ ] **Step 4: Keep Hono entry exports unchanged**

Confirm `packages/logger/src/hono.ts` still exports only middleware utilities:

```ts
export { useLogger, generateId } from './middleware'
export type { GenerateIdOptions } from './middleware'
```

- [ ] **Step 5: Run tests to verify green**

Run:

```powershell
pnpm --filter @cf-logger/logger test -- src/middleware.test.ts
```

Expected: middleware tests pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add packages/logger/src/middleware.ts packages/logger/src/hono.ts packages/logger/src/middleware.test.ts
git commit -m "fix: let Hono own route error responses"
```

## Task 4: Runtime and Publish Documentation

**Files:**
- Modify: `packages/logger/README.md`
- Modify: `README.md`
- Modify: `docs/rpc-trace-propagation.md`

- [ ] **Step 1: Update package install and runtime docs**

In `packages/logger/README.md`, add a Cloudflare runtime section near the install section:

````md
## Cloudflare Worker Requirements

`@cf-logger/logger` uses `AsyncLocalStorage` through `node:async_hooks`.
Cloudflare Workers must enable Node.js compatibility in `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

The package expects these environment variables when using `loggerOptionsFromEnv()` or `tracedWorker()`:

```jsonc
{
  "vars": {
    "NAME": "my-worker",
    "LOG_LEVEL": "info",
    "ENVIRONMENT": "production",
    "VERSION": "1.0.0"
  }
}
```
````

- [ ] **Step 2: Update service binding convention docs**

Replace local hand-written binding examples with:

```ts
import type { TracedServiceBinding } from '@cf-logger/logger/workers'

interface Env {
  BIND: TracedServiceBinding<BindService>
  MATH: TracedServiceBinding<MathService>
}
```

- [ ] **Step 3: Document middleware error behavior**

Add to the Hono middleware section:

```md
`useLogger()` does not own route error responses. It lets Hono run downstream handlers and app-level `onError()` normally, then checks `c.error` after `await next()`. Failed requests emit `request.error` with the final `c.res.status`; all requests emit `request.end` with the final `c.res.status`.

This follows Hono's structured logger middleware pattern: `await next()`, then inspect `c.error` and `c.res.status`. Unlike Hono's structured logger, this package keeps `request.end` as a true lifecycle event and emits it for both success and failure. It does not catch, rethrow, create, or replace responses.
```

- [ ] **Step 4: Update root README scope**

Clarify that `workers/` is a local/e2e fixture, not a published package:

```md
`workers/` contains local Cloudflare Worker fixtures used to verify real RPC trace propagation. The only package intended for npm publish is `packages/logger`.
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add README.md packages/logger/README.md docs/rpc-trace-propagation.md
git commit -m "docs: clarify package publish and runtime requirements"
```

## Task 5: Local E2E Release Harness

**Files:**
- Create: `scripts/e2e-local.ps1`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create e2e script**

Create `scripts/e2e-local.ps1`:

```powershell
$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $env:TEMP 'cf-logger-e2e.out.log'
$err = Join-Path $env:TEMP 'cf-logger-e2e.err.log'
Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue

$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  throw "Port 8787 is already in use by process $($existing.OwningProcess). Stop it before running e2e."
}

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) {
  $pnpm = (Get-Command pnpm).Source
}

$process = Start-Process -FilePath $pnpm -ArgumentList 'dev' -WorkingDirectory $repo -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden

try {
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $out) {
      $content = Get-Content $out -Raw
      if ($content -match 'Ready on http://127\.0\.0\.1:8787') {
        $ready = $true
        break
      }
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $ready) {
    throw "Wrangler dev server did not become ready. Stdout: $(Get-Content $out -Raw) Stderr: $(Get-Content $err -Raw)"
  }

  $base = 'http://127.0.0.1:8787'
  $traceId = '11111111111111111111111111111111'
  $parentSpanId = '2222222222222222'
  $headers = @{
    'traceparent' = "00-$traceId-$parentSpanId-01"
    'tracestate' = 'vendor=value'
    'X-Request-Id' = 'req-e2e-local'
  }

  function Convert-Body($Content) {
    if (-not $Content) { return $null }
    try { return $Content | ConvertFrom-Json } catch { return $Content }
  }

  function Probe($Path, [int]$ExpectedStatus) {
    $res = Invoke-WebRequest -Uri "$base$Path" -Headers $headers -SkipHttpErrorCheck
    [PSCustomObject]@{
      Path = $Path
      Status = [int]$res.StatusCode
      Expected = $ExpectedStatus
      Body = Convert-Body $res.Content
      XRequestId = $res.Headers['X-Request-Id'] | Select-Object -First 1
      XTraceId = $res.Headers['X-Trace-Id'] | Select-Object -First 1
      Traceparent = $res.Headers['traceparent'] | Select-Object -First 1
      Tracestate = $res.Headers['tracestate'] | Select-Object -First 1
    }
  }

  $results = @(
    Probe '/' 200
    Probe '/multi-hop' 200
    Probe '/trace' 200
    Probe '/error' 500
  )

  $failures = New-Object System.Collections.Generic.List[string]
  foreach ($r in $results) {
    if ($r.Status -ne $r.Expected) { $failures.Add("$($r.Path) status actual=$($r.Status) expected=$($r.Expected)") }
    if ($r.XRequestId -ne 'req-e2e-local') { $failures.Add("$($r.Path) X-Request-Id actual=$($r.XRequestId)") }
    if ($r.XTraceId -ne $traceId) { $failures.Add("$($r.Path) X-Trace-Id actual=$($r.XTraceId)") }
    if ($r.Traceparent -notlike "00-$traceId-*-01") { $failures.Add("$($r.Path) traceparent actual=$($r.Traceparent)") }
    if ($r.Tracestate -ne 'vendor=value') { $failures.Add("$($r.Path) tracestate actual=$($r.Tracestate)") }
  }

  $root = $results | Where-Object Path -eq '/'
  $multi = $results | Where-Object Path -eq '/multi-hop'
  $trace = $results | Where-Object Path -eq '/trace'
  $errorProbe = $results | Where-Object Path -eq '/error'

  if ($root.Body.total -ne 12) { $failures.Add("/ total actual=$($root.Body.total)") }
  if ($root.Body.traceId -ne $traceId) { $failures.Add("/ body traceId actual=$($root.Body.traceId)") }
  if ($multi.Body.result -ne 15) { $failures.Add("/multi-hop result actual=$($multi.Body.result)") }
  if ($multi.Body.traceId -ne $traceId) { $failures.Add("/multi-hop body traceId actual=$($multi.Body.traceId)") }
  if ($trace.Body.traceId -ne $traceId) { $failures.Add("/trace body traceId actual=$($trace.Body.traceId)") }
  if ($trace.Body.parentSpanId -ne $parentSpanId) { $failures.Add("/trace parentSpanId actual=$($trace.Body.parentSpanId)") }
  if ($errorProbe.Body.error -ne 'Division by zero') { $failures.Add("/error error actual=$($errorProbe.Body.error)") }

  if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Output $_ }
    throw 'E2E assertions failed'
  }

  $results | ConvertTo-Json -Depth 6
}
finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
```

- [ ] **Step 2: Add root scripts**

Modify root `package.json` scripts:

```json
{
  "scripts": {
    "dev": "wrangler dev -c workers/main-worker/wrangler.jsonc -c workers/bind-worker/wrangler.jsonc -c workers/math-worker/wrangler.jsonc",
    "deploy": "wrangler deploy -c workers/main-worker/wrangler.jsonc && wrangler deploy -c workers/bind-worker/wrangler.jsonc && wrangler deploy -c workers/math-worker/wrangler.jsonc",
    "cf-typegen": "wrangler types --include-runtime=false",
    "logger:build": "pnpm --filter @cf-logger/logger build",
    "logger:typecheck": "pnpm --filter @cf-logger/logger typecheck",
    "logger:test": "pnpm --filter @cf-logger/logger test",
    "logger:pack": "pnpm --filter @cf-logger/logger pack:dry",
    "e2e:local": "powershell -ExecutionPolicy Bypass -File scripts/e2e-local.ps1",
    "release:check": "pnpm logger:build && pnpm logger:typecheck && pnpm logger:test && pnpm logger:pack && pnpm e2e:local"
  }
}
```

- [ ] **Step 3: Update gitignore**

Add:

```gitignore
packages/logger/dist/
*.tgz
```

- [ ] **Step 4: Run e2e script**

Run:

```powershell
pnpm e2e:local
```

Expected: exits `0`, prints JSON route results, and leaves no listener on port `8787`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add scripts/e2e-local.ps1 package.json .gitignore
git commit -m "test: add local Worker e2e release check"
```

## Task 6: Final Release Verification

**Files:**
- No source changes expected unless verification finds a defect.

- [ ] **Step 1: Run package release check**

Run:

```powershell
pnpm release:check
```

Expected:
- `tsdown` build exits `0`.
- `tsc --noEmit` exits `0`.
- Vitest reports all package tests passing.
- `pnpm pack --dry-run` includes only publishable package files.
- Local Worker e2e reports all four routes passing.

- [ ] **Step 2: Inspect package tarball contents if needed**

Run:

```powershell
pnpm --filter @cf-logger/logger pack
```

Expected: creates an `@cf-logger/logger` tarball containing `dist/**`, `README.md`, and `package.json`.

Delete the generated `.tgz` after inspection unless the release workflow needs it.

- [ ] **Step 3: Commit any verification fixes**

If verification required changes:

```powershell
git add <changed-files>
git commit -m "chore: finalize logger publish checks"
```

If no changes were required, do not create an empty commit.

## Self-Review

- Spec coverage: The plan covers package-only publishing, tsdown build/bundling, package-local typecheck, public DX helpers, middleware error observation without response ownership, docs, and local e2e verification.
- Placeholder scan: No `TBD`, `TODO`, or implementation-free "add tests" steps remain.
- Type consistency: `TracedServiceBinding<T>` consistently uses `session(traceparent, fields?, tracestate?)`; `loggerOptionsFromEnv()` consistently returns `LoggerOptions`.
