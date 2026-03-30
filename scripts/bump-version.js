#!/usr/bin/env node
/**
 * Version bump script for AI Readiness Scanner.
 * 
 * Usage:
 *   node scripts/bump-version.js          # auto-detect from git log
 *   node scripts/bump-version.js patch    # force patch bump
 *   node scripts/bump-version.js minor    # force minor bump
 *   node scripts/bump-version.js major    # force major bump
 * 
 * Reads .versionrc.json for conventional commit → version mapping.
 * Updates package.json, package-lock.json, and CHANGELOG.md.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const versionrcPath = path.join(ROOT, '.versionrc.json');

// Read current version
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

// Read version config
const config = JSON.parse(fs.readFileSync(versionrcPath, 'utf-8'));

// Determine bump type
let bumpType = process.argv[2]; // manual override

if (!bumpType) {
  // Auto-detect from git log since last tag
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null', { encoding: 'utf-8' }).trim();
    const commits = execSync(`git log ${lastTag}..HEAD --pretty=format:"%s"`, { encoding: 'utf-8' }).trim().split('\n');
    
    bumpType = 'patch'; // default
    for (const msg of commits) {
      if (msg.includes('BREAKING CHANGE') || msg.startsWith('!')) {
        bumpType = 'major';
        break;
      }
      const prefix = msg.split(':')[0].split('(')[0].trim();
      const rule = config.rules[prefix];
      if (rule === 'minor' && bumpType !== 'major') bumpType = 'minor';
    }
  } catch {
    // No tags yet — check recent commits
    try {
      const commits = execSync('git log --oneline -20 --pretty=format:"%s"', { encoding: 'utf-8' }).trim().split('\n');
      bumpType = 'patch';
      for (const msg of commits) {
        const prefix = msg.split(':')[0].split('(')[0].trim().replace(/^"/, '');
        if (config.rules[prefix] === 'minor') { bumpType = 'minor'; break; }
      }
    } catch {
      bumpType = 'patch';
    }
  }
}

// Compute new version
let newVersion;
switch (bumpType) {
  case 'major': newVersion = `${major + 1}.0.0`; break;
  case 'minor': newVersion = `${major}.${minor + 1}.0`; break;
  default: newVersion = `${major}.${minor}.${patch + 1}`; break;
}

console.log(`Bumping: ${pkg.version} → ${newVersion} (${bumpType})`);

// Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Update package-lock.json if exists
const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  lock.version = newVersion;
  if (lock.packages && lock.packages['']) lock.packages[''].version = newVersion;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

// Prepend to CHANGELOG.md
if (config.changelog && fs.existsSync(changelogPath)) {
  const today = new Date().toISOString().split('T')[0];
  const changelog = fs.readFileSync(changelogPath, 'utf-8');
  
  // Get commits since last version
  let commitLog = '';
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null', { encoding: 'utf-8' }).trim();
    commitLog = execSync(`git log ${lastTag}..HEAD --pretty=format:"- %s"`, { encoding: 'utf-8' }).trim();
  } catch {
    commitLog = execSync('git log --oneline -10 --pretty=format:"- %s"', { encoding: 'utf-8' }).trim();
  }

  const newEntry = `\n## [${newVersion}] — ${today}\n\n${commitLog}\n`;
  const updated = changelog.replace(
    /^(# Changelog.*?\n)/s,
    `$1${newEntry}`
  );
  fs.writeFileSync(changelogPath, updated);
}

console.log(`✅ Version bumped to ${newVersion}`);
console.log(`Run: git add -A && git commit -m "${config.commitMessage.replace('${version}', newVersion)}" && git tag ${config.tagPrefix}${newVersion}`);
