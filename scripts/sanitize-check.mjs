#!/usr/bin/env node
/**
 * 脱敏门禁：扫描仓库文本，禁止出现本机路径、私有包前缀、内网地址、凭据前缀。
 *
 * 用法：node scripts/sanitize-check.mjs
 * 退出码：0 = 干净；1 = 有命中（逐条打印 file:line + 原因）。
 *
 * 两点约定：
 * 1. 所有 needle 都用拼接 / 正则源码构造，避免本文件被自己的门禁命中——
 *    门禁是对整个仓库做的，写下字面量会自报家门。
 * 2. `sk-` 与 `100.` 这类短 needle 用「带边界或带长度」的正则：
 *    CSS 类名 `ep-task-pill`、进度文案 `100%` 都不该被误判成
 *    凭据前缀或 Tailscale 内网地址。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.staging']);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2',
]);
/** 本地备份（.gitignore 已覆盖，永不入库）：不参与扫描，但末尾单独列出提醒清理。 */
const BACKUP_NAME = /\.bak(-|\b)/;
const MAX_BYTES = 2 * 1024 * 1024;

const NEEDLES = [
  { reason: 'private key material', text: 'PRIVATE' + ' KEY' },
  { reason: 'personal home path (macOS)', text: ['', 'Users', ''].join('/') },
  { reason: 'personal home path (Linux)', text: ['', 'home', ''].join('/') },
  { reason: 'private package scope', text: '@' + 'local' },
  { reason: 'internal gateway name', text: 'mag' + 'pie' },
  { reason: 'cloud vendor host', text: 'cty' + 'un' },
  { reason: 'loopback IPv4 address', text: [127, 0, 0, 1].join('.') },
  { reason: 'loopback hostname', text: 'local' + 'host' },
  { reason: 'tailscale / internal IP', re: /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { reason: 'api key prefix', re: /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/ },
  { reason: 'github token prefix', text: 'gh' + 'o_' },
  { reason: 'github token prefix', text: 'gh' + 'p_' },
];

function walk(dir, out = [], backups = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out, backups);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (BACKUP_NAME.test(name)) {
      backups.push(relative(ROOT, join(dir, name)));
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0 && SKIP_EXT.has(name.slice(dot).toLowerCase())) continue;
    out.push(join(dir, name));
  }
  return { files: out, backups };
}

const hits = [];
const { files, backups } = walk(ROOT);

for (const file of files) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // 二进制

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const needle of NEEDLES) {
      const hit = needle.re !== undefined ? needle.re.test(line) : line.includes(needle.text);
      if (!hit) continue;
      hits.push(`${relative(ROOT, file)}:${i + 1}: ${needle.reason}`);
    }
  }
}

if (backups.length > 0) {
  console.log(`sanitize-check: note — ${backups.length} local backup file(s) skipped (gitignored, never committed):`);
  for (const backup of backups) console.log(`  ${backup}`);
}

if (hits.length === 0) {
  console.log('sanitize-check: clean (0 hits)');
  process.exit(0);
}

console.error(`sanitize-check: ${hits.length} hit(s)`);
for (const hit of hits) console.error(`  ${hit}`);
process.exit(1);
