#!/usr/bin/env node
/**
 * 공식 목록 짓기 — `node scripts/build.mjs`
 *
 * 1. `npm ci` 로 package-lock.json 에 박힌 판 그대로 받는다(`--skip-install` 이면 건너뛴다).
 * 2. 플러그인마다(`plugins/<이름>/`) 언어 서버를 esbuild 로 파일 하나로 묶고, plugin.json · 라이선스와 함께 묶음 zip 을 짓는다.
 * 3. 엔진 판마다 패키지 폴더를 그대로 zip 뿌리에 담는다 — 앱이 이 zip 을 `engines/<종류>/<판>/` 에 바로 풀기 때문이다.
 * 4. `dist/*.zip` 과 뿌리의 `index.json`(url · sha256 · size)을 쓴다.
 *
 * **같은 입력이면 같은 바이트가 나온다.** zip 항목은 이름 차례로, 시각은 1980-01-01 로, 권한은 0644/0755 둘로 고정한다.
 * zip 규칙은 앱의 풀기(`apps/server/src/modules/plugins/bundle.js`)에 맞춘다 — zip64 없음 · deflate/stored 만 · 링크 없음 · 200MB/20,000 항목 이하.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, '.build')
const DIST = path.join(ROOT, 'dist')
const PLUGINS = path.join(ROOT, 'plugins')
const BASE_URL = 'https://raw.githubusercontent.com/RoJaebl/editor-plugins/main/dist/'
/** 한 파일이 이보다 크면 멈춘다 — GitHub 저장소에 그대로 올리는 파일이라 50MB 경고선 아래에 둔다. */
const FILE_MAX = 50 * 1024 * 1024
/** 앱의 풀기 상한(bundle.js 의 BUNDLE_LIMITS) — 넘으면 앱이 거절하므로 여기서 먼저 멈춘다. */
const APP_LIMITS = { maxBytes: 200 * 1024 * 1024, maxEntries: 20000 }

const args = new Set(process.argv.slice(2))
const log = (...a) => console.log('[build]', ...a)
const die = (msg) => {
  console.error(`[build] 멈춤: ${msg}`)
  process.exit(1)
}

// ── zip 쓰기(결정적) ────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 1980-01-01 00:00 — DOS 시각의 처음. */
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/**
 * @param {{ name: string, data: Buffer, mode: number }[]} files  이름은 `/` 로 이은 상대 경로
 */
function makeZip(files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (sorted.length >= 0xffff) die(`zip 항목이 너무 많습니다(${sorted.length}) — zip64 없이 담을 수 없습니다`)
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of sorted) {
    const name = Buffer.from(f.name, 'utf8')
    const deflated = deflateRawSync(f.data, { level: 9 })
    const stored = deflated.length >= f.data.length
    const body = stored ? f.data : deflated
    const method = stored ? 0 : 8
    const crc = crc32(f.data)
    if (f.data.length > 0xfffffffe || offset > 0xfffffffe) die('zip64 가 필요한 크기입니다')
    const flags = 0x0800 // 이름이 UTF-8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // 유닉스에서 만듦 — 권한을 싣는다(링크 비트는 없다)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((0o100000 | f.mode) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  if (offset > 0xfffffffe || cd.length > 0xfffffffe) die('zip64 가 필요한 크기입니다')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** 폴더 하나를 zip 항목으로 — 링크 · 보통 파일이 아닌 것은 멈춘다. `prefix` 는 zip 안 앞붙임. */
async function collect(dir, prefix = '') {
  const out = []
  async function walk(abs, rel) {
    for (const name of (await readdir(abs)).sort()) {
      const a = path.join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      const st = await lstat(a)
      if (st.isSymbolicLink()) die(`링크는 묶음에 담지 않습니다: ${a}`)
      if (st.isDirectory()) await walk(a, r)
      else if (st.isFile()) out.push({ name: prefix + r, data: await readFile(a), mode: st.mode & 0o111 ? 0o755 : 0o644 })
      else die(`보통 파일이 아닙니다: ${a}`)
    }
  }
  await walk(dir, '')
  return out
}

function checkLimits(label, files) {
  const total = files.reduce((n, f) => n + f.data.length, 0)
  if (files.length > APP_LIMITS.maxEntries) die(`${label}: 항목 ${files.length}개 — 앱 상한 ${APP_LIMITS.maxEntries}개를 넘습니다`)
  if (total > APP_LIMITS.maxBytes) die(`${label}: 풀면 ${total} 바이트 — 앱 상한 200MB 를 넘습니다`)
  for (const f of files) {
    const segs = f.name.split('/')
    if (f.name.includes('\\') || f.name.includes(':') || segs.some((s) => !s || s === '.' || s === '..')) die(`${label}: 앱이 받지 않는 경로입니다: ${f.name}`)
  }
  return total
}

// ── 짓기 ───────────────────────────────────────────────────────────

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'))

async function bundleServer(pluginDir, cfg, outDir) {
  const { build } = await import('esbuild')
  const pkgDir = path.join(ROOT, 'node_modules', cfg.server.package)
  const pkg = await readJson(path.join(pkgDir, 'package.json'))
  const entry = path.join(pkgDir, cfg.server.entry)
  const outfile = path.join(outDir, ...cfg.server.out.split('/'))
  const version = JSON.stringify(pkg.version)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    // 위 판의 cli.mjs 는 맨 위 await 를 쓰므로 ESM 그대로 둔다. `.js` 를 ESM 으로 읽게 곁에 `{"type":"module"}` 을 둔다(아래).
    format: 'esm',
    target: 'node20',
    minify: false,
    sourcemap: false,
    legalComments: 'eof',
    logLevel: 'warning',
    plugins: [
      {
        name: 'inline-package-version',
        setup(b) {
          // 런타임에 `../package.json` 을 읽어 판을 얻는다 — 묶음에는 그 파일이 없으므로 판 글자로 바꿔 넣는다.
          b.onLoad({ filter: /\.m?js$/ }, async ({ path: p }) => {
            let text = await readFile(p, 'utf8')
            const pattern = /JSON\.parse\(readFileSync\(new URL\('\.\.\/package\.json', import\.meta\.url\), \{[^}]*\}\)\)/
            if (p === entry) {
              if (!pattern.test(text)) die(`${cfg.server.package} 의 판 읽기 자리를 찾지 못했습니다 — 판을 올렸다면 build.mjs 를 고칩니다`)
              text = text.replace(pattern, `({ version: ${version} })`)
            }
            return { contents: text, loader: 'js' }
          })
        },
      },
    ],
  })
  // 묶음 안에는 node_modules 가 없다 — 바깥 패키지를 부르는 import 가 하나라도 남았으면 멈춘다(node: 내장 · 옛 이름의 내장만 허용).
  const out = await readFile(outfile, 'utf8')
  const { builtinModules } = await import('node:module')
  for (const m of out.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1] ?? m[2]
    if (!spec.startsWith('node:') && !builtinModules.includes(spec)) die(`묶은 언어 서버가 바깥 모듈을 부릅니다: ${spec}`)
  }
  await writeFile(path.join(path.dirname(outfile), 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`)
  for (const lic of cfg.server.licenses) await copyFile(path.join(pkgDir, lic), path.join(path.dirname(outfile), lic))
  return pkg.version
}

async function buildPlugin(name) {
  const pluginDir = path.join(PLUGINS, name)
  const manifest = await readJson(path.join(pluginDir, 'plugin.json'))
  const cfg = await readJson(path.join(pluginDir, 'catalog.json'))
  const stage = path.join(BUILD, name, 'plugin')
  await rm(stage, { recursive: true, force: true })
  await mkdir(path.join(stage, 'server'), { recursive: true })

  const serverVersion = await bundleServer(pluginDir, cfg, stage)
  for (const n of cfg.notices) await copyFile(path.join(pluginDir, n), path.join(stage, 'server', n))
  await writeFile(path.join(stage, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  log(`${manifest.id}: 언어 서버 ${cfg.server.package} ${serverVersion} 묶음`)

  const assets = []
  const files = await collect(stage)
  const pluginFile = `${manifest.id}-${manifest.version}-${manifest.platform}.zip`
  assets.push({ file: pluginFile, zip: makeZip(files), unpacked: checkLimits(pluginFile, files), entries: files.length })

  const engineKinds = {}
  for (const [kind, list] of Object.entries(cfg.engines)) {
    const decl = manifest.engineKinds?.[kind]
    if (!decl) die(`${manifest.id}: plugin.json 에 선언하지 않은 엔진 종류입니다: ${kind}`)
    if (decl.default && list[0]?.version !== decl.default) die(`${manifest.id}: ${kind} 의 첫 판(${list[0]?.version})이 plugin.json 의 기본 판(${decl.default})과 다릅니다`)
    engineKinds[kind] = []
    for (const { version, package: pkgName } of list) {
      const pkgDir = path.join(ROOT, 'node_modules', pkgName)
      const pkg = await readJson(path.join(pkgDir, 'package.json')).catch(() => die(`${pkgName} 이 설치되어 있지 않습니다 — package.json 의 devDependencies 에 더합니다`))
      if (pkg.version !== version) die(`${pkgName} 의 판이 ${pkg.version} 입니다(바란 판 ${version})`)
      const efiles = await collect(pkgDir)
      const file = `${manifest.id}-engine-${kind}-${version}.zip`
      assets.push({ file, zip: makeZip(efiles), unpacked: checkLimits(file, efiles), entries: efiles.length })
      engineKinds[kind].push({ version, file })
      log(`${manifest.id}: 엔진 ${kind} ${version}(${efiles.length}개 항목)`)
    }
  }

  for (const a of assets) {
    if (a.zip.length > FILE_MAX) die(`${a.file} 이 ${a.zip.length} 바이트로 50MB 를 넘습니다 — Release 로 옮겨야 합니다`)
    a.sha256 = sha256(a.zip)
    a.size = a.zip.length
  }
  const byFile = Object.fromEntries(assets.map((a) => [a.file, a]))
  const ref = (file) => ({ url: BASE_URL + file, sha256: byFile[file].sha256, size: byFile[file].size })
  const entry = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    publisher: manifest.publisher,
    versions: [{ version: manifest.version, engines: manifest.engines.editor, assets: { [manifest.platform]: ref(pluginFile) } }],
    engineKinds: Object.fromEntries(Object.entries(engineKinds).map(([k, list]) => [k, list.map(({ version, file }) => ({ version, ...ref(file) }))])),
  }
  return { entry, assets }
}

async function main() {
  if (!args.has('--skip-install')) {
    log('npm ci — package-lock.json 의 판 그대로')
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  }
  const names = (await readdir(PLUGINS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const entries = []
  const assets = []
  for (const name of names) {
    const r = await buildPlugin(name)
    entries.push(r.entry)
    assets.push(...r.assets)
  }
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })
  for (const a of assets) {
    await writeFile(path.join(DIST, a.file), a.zip)
    log(`dist/${a.file}  ${a.size} 바이트(풀면 ${a.unpacked}, 항목 ${a.entries})  sha256 ${a.sha256}`)
  }
  await writeFile(path.join(ROOT, 'index.json'), `${JSON.stringify({ plugins: entries }, null, 2)}\n`)
  log('index.json 을 썼습니다')
  await rm(BUILD, { recursive: true, force: true })
}

await main()
