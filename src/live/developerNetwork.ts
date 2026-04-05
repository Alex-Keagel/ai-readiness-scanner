import { execSync } from 'child_process';
import { logger } from '../logging';

// ─── Types ──────────────────────────────────────────────────────────

export interface RepoProfile {
  name: string;
  myPRsCreated: number;
  myPRsReviewed: number;
  myComments: number;
  myCommits: number;
  myLinesAdded: number;
  myLinesDeleted: number;
  myFileTypes: Record<string, number>;
  topReviewersForMe: { name: string; count: number; approveRate: number }[];
  totalPRs: number;
  totalContributors: number;
  lastActivity: string;
}

export interface PersonProfile {
  name: string;
  alias: string;
  theyReviewedMyPRs: number;
  iReviewedTheirPRs: number;
  theyCommentedOnMyPRs: number;
  iCommentedOnTheirPRs: number;
  sharedRepos: string[];
  contributedRepos: string[];
  repoStats: Record<string, { prsAuthored: number; prsReviewed: number; comments: number; iterations: number; linesAdded: number; linesDeleted: number }>;
  theirApproveRate: number;
}

export interface DeveloperProfile {
  currentUser: string;
  currentAlias: string;
  repos: RepoProfile[];
  people: PersonProfile[];
  totalPRsCreated: number;
  totalPRsReviewed: number;
  totalComments: number;
  totalCommits: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  fileTypeSummary: Record<string, number>;
  topCollaborators: { name: string; score: number }[];
}

// ─── Testable helpers (exported for unit tests) ─────────────────────

/** Filter PR reviewers: exclude team groups, bots, and auto-assigned CODEOWNERS who never voted */
export function filterReviewers(reviewers: any[]): any[] {
  return reviewers.filter((r: any) =>
    !r.displayName?.includes('TEAM FOUNDATION') &&
    !r.displayName?.includes('[') &&
    r.vote !== 0
  );
}

// Binary formats where git numstat shows "-" (no meaningful line counts)
const BINARY_EXT = /\.(png|jpg|jpeg|gif|ico|bmp|tiff|webp|woff|woff2|ttf|eot|otf|parquet|pb|bin|h5|onnx|pt|pth|safetensors|pkl|cbm|npy|npz|feather|arrow|sqlite|db|dll|exe|so|dylib|class|pyc|pyo|o|a|wasm)$/i;

/** Check if a file path looks like a malformed git rename entry */
function isMalformedPath(filePath: string): boolean {
  return /["{}<>]/.test(filePath) || filePath.includes(' => ');
}

/** Parse git numstat output into line stats and file types, filtering only binary files */
export function parseGitNumstat(numstatOutput: string): { linesAdded: number; linesDeleted: number; fileTypes: Record<string, number> } {
  let linesAdded = 0, linesDeleted = 0;
  const fileTypes: Record<string, number> = {};
  for (const line of numstatOutput.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const filePath = parts[2];
    if (BINARY_EXT.test(filePath) || isMalformedPath(filePath)) continue;
    const added = parseInt(parts[0], 10);
    const deleted = parseInt(parts[1], 10);
    if (!isNaN(added)) linesAdded += added;
    if (!isNaN(deleted)) linesDeleted += deleted;
    const ext = filePath.includes('.') ? filePath.split('.').pop() || '' : '';
    if (ext) fileTypes[ext] = (fileTypes[ext] || 0) + 1;
  }
  return { linesAdded, linesDeleted, fileTypes };
}

/** Build collaborator scores from person profiles */
export function buildTopCollaborators(people: PersonProfile[], limit = 15): { name: string; score: number }[] {
  return people
    .map(p => ({ name: p.name, score: p.theyReviewedMyPRs + p.iReviewedTheirPRs + p.theyCommentedOnMyPRs + p.iCommentedOnTheirPRs }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Process a single PR and update counters/maps. Returns contribution type. */
export function processPR(
  pr: any, currentUser: string, repoName: string,
  personMap: Map<string, PersonProfile>,
  reviewerStats: Record<string, { count: number; approved: number }>,
): 'created' | 'reviewed' | 'none' {
  const creator = pr.createdBy?.displayName || '?';
  const isMyPR = creator === currentUser;
  const reviewers = filterReviewers(pr.reviewers || []);

  if (isMyPR) {
    for (const r of reviewers) {
      const rName = r.displayName || '?';
      if (rName === currentUser) continue;
      if (!reviewerStats[rName]) reviewerStats[rName] = { count: 0, approved: 0 };
      reviewerStats[rName].count++;
      if (r.vote === 10) reviewerStats[rName].approved++;
      if (!personMap.has(rName)) personMap.set(rName, makePersonProfile(rName, r.uniqueName));
      const pp = personMap.get(rName)!;
      pp.theyReviewedMyPRs++;
      if (!pp.sharedRepos.includes(repoName)) pp.sharedRepos.push(repoName);
    }
    return 'created';
  } else {
    const iReviewed = reviewers.some((r: any) => r.displayName === currentUser);
    if (iReviewed) {
      if (!personMap.has(creator)) personMap.set(creator, makePersonProfile(creator, pr.createdBy?.uniqueName));
      const pp = personMap.get(creator)!;
      pp.iReviewedTheirPRs++;
      if (!pp.sharedRepos.includes(repoName)) pp.sharedRepos.push(repoName);
      return 'reviewed';
    }
  }
  return 'none';
}

// ─── Data Collection ────────────────────────────────────────────────

function getToken(): string {
  try {
    return execSync('az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv', {
      encoding: 'utf-8', timeout: 15000, shell: true,
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' },
    }).trim();
  } catch { return ''; }
}

function adoGet(token: string, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { headers: { 'Authorization': 'Bearer ' + token } }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export async function collectDeveloperProfile(repoNames: string[], org: string, project: string, workspaceCwd?: string): Promise<DeveloperProfile> {
  const token = getToken();
  if (!token) {
    logger.warn('DeveloperProfile: az CLI not available');
    return emptyProfile();
  }

  let currentUser = '';
  let currentAlias = '';
  try {
    currentUser = execSync('git config user.name', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
    const email = execSync('git config user.email', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
    currentAlias = email.includes('@') ? email.split('@')[0] : email;
  } catch { /* fallback */ }

  if (!currentUser) return emptyProfile();
  logger.info(`DeveloperProfile: collecting for ${currentUser} across ${repoNames.length} repos`);

  const repoProfiles: RepoProfile[] = [];
  const personMap = new Map<string, PersonProfile>();
  const globalFileTypes: Record<string, number> = {};
  let totalCreated = 0, totalReviewed = 0, totalComments = 0;
  let totalLinesAdded = 0, totalLinesDeleted = 0, totalCommits = 0;

  for (const repoName of repoNames) {
    try {
      const baseUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repoName}`;

      // Fetch recent PRs (active + completed only, skip abandoned/draft)
      const data = await adoGet(token, `${baseUrl}/pullrequests?searchCriteria.status=all&$top=100&api-version=7.1`);
      const prs = ((data.value || []) as any[]).filter((pr: any) =>
        pr.status !== 'abandoned' && !pr.isDraft
      );

      let myCreated = 0, myReviewed = 0, myComments = 0;
      const myFileTypes: Record<string, number> = {};
      const reviewerStats: Record<string, { count: number; approved: number }> = {};
      const repoContributors = new Set<string>();
      let lastDate = '';

      for (const pr of prs) {
        const creator = pr.createdBy?.displayName || '?';
        const prDate = pr.creationDate || '';
        if (!lastDate || prDate > lastDate) lastDate = prDate;
        repoContributors.add(creator);

        const isMyPR = creator === currentUser;
        const reviewers = filterReviewers(pr.reviewers || []);

        // Track ALL contributors to this repo with per-repo stats
        if (creator !== currentUser && creator !== '?') {
          if (!personMap.has(creator)) personMap.set(creator, makePersonProfile(creator, pr.createdBy?.uniqueName));
          const cp = personMap.get(creator)!;
          if (!cp.contributedRepos.includes(repoName)) cp.contributedRepos.push(repoName);
          if (!cp.repoStats[repoName]) cp.repoStats[repoName] = { prsAuthored: 0, prsReviewed: 0, comments: 0, iterations: 0, linesAdded: 0, linesDeleted: 0 };
          cp.repoStats[repoName].prsAuthored++;
        }
        for (const r of reviewers) {
          const rn = r.displayName || '?';
          if (rn === currentUser || rn === '?') continue;
          if (!personMap.has(rn)) personMap.set(rn, makePersonProfile(rn, r.uniqueName));
          const rp = personMap.get(rn)!;
          if (!rp.contributedRepos.includes(repoName)) rp.contributedRepos.push(repoName);
          if (!rp.repoStats[repoName]) rp.repoStats[repoName] = { prsAuthored: 0, prsReviewed: 0, comments: 0, iterations: 0, linesAdded: 0, linesDeleted: 0 };
          rp.repoStats[repoName].prsReviewed++;
        }

        if (isMyPR) {
          myCreated++;
          totalCreated++;

          // Track who reviews my PRs
          for (const r of reviewers) {
            const rName = r.displayName || '?';
            if (rName === currentUser) continue;
            if (!reviewerStats[rName]) reviewerStats[rName] = { count: 0, approved: 0 };
            reviewerStats[rName].count++;
            if (r.vote === 10) reviewerStats[rName].approved++;

            // Person profile: they reviewed my PR
            if (!personMap.has(rName)) personMap.set(rName, makePersonProfile(rName, r.uniqueName));
            const pp = personMap.get(rName)!;
            pp.theyReviewedMyPRs++;
            if (!pp.sharedRepos.includes(repoName)) pp.sharedRepos.push(repoName);
          }

          // Get file types for my PRs (sample first 5 PRs)
          if (myCreated <= 5) {
            try {
              const iterData = await adoGet(token, `${baseUrl}/pullrequests/${pr.pullRequestId}/iterations/1/changes?api-version=7.1`);
              for (const entry of (iterData.changeEntries || []).slice(0, 50)) {
                const filePath = entry.item?.path || '';
                if (BINARY_EXT.test(filePath)) continue;
                const ext = filePath.includes('.') ? filePath.split('.').pop() || '?' : '?';
                if (ext !== '?') {
                  myFileTypes[ext] = (myFileTypes[ext] || 0) + 1;
                  globalFileTypes[ext] = (globalFileTypes[ext] || 0) + 1;
                }
              }
            } catch { /* skip file details */ }
          }

          // Get comments on my PR
          try {
            const threads = await adoGet(token, `${baseUrl}/pullrequests/${pr.pullRequestId}/threads?api-version=7.1`);
            for (const t of (threads.value || [])) {
              for (const c of (t.comments || [])) {
                if (c.commentType === 'system') continue;
                const cAuthor = c.author?.displayName || '?';
                if (cAuthor !== currentUser) {
                  myComments++;
                  if (!personMap.has(cAuthor)) personMap.set(cAuthor, makePersonProfile(cAuthor, c.author?.uniqueName));
                  personMap.get(cAuthor)!.theyCommentedOnMyPRs++;
                }
              }
            }
          } catch { /* skip comments */ }

        } else {
          // Not my PR — check if I'm a reviewer
          const iReviewed = reviewers.some((r: any) => r.displayName === currentUser);
          if (iReviewed) {
            myReviewed++;
            totalReviewed++;

            // Person profile: I reviewed their PR
            if (!personMap.has(creator)) personMap.set(creator, makePersonProfile(creator, pr.createdBy?.uniqueName));
            const pp = personMap.get(creator)!;
            pp.iReviewedTheirPRs++;
            if (!pp.sharedRepos.includes(repoName)) pp.sharedRepos.push(repoName);
          }
        }
      }

      totalComments += myComments;

      // Collect line stats + file types + commit count from local git clone
      // Strategy: --remotes first (excludes local stash/WIP), fallback to --all minus stash
      // --no-merges: avoid double-counting merge commits
      // --diff-filter=ACMRT: exclude file Deletions (bulk cleanup inflates stats)
      let myLinesAdded = 0, myLinesDeleted = 0, myCommits = 0;
      let repoGitDir = '';
      let repoGitScope = '--remotes';
      const gitFileTypes: Record<string, number> = {};
      try {
        const pathMod = require('path');
        const fsMod = require('fs');
        const devRoot = workspaceCwd ? pathMod.dirname(workspaceCwd) : '';
        if (devRoot) {
          const candidates: string[] = [pathMod.join(devRoot, repoName)];
          if (workspaceCwd && pathMod.basename(workspaceCwd) === repoName) candidates.unshift(workspaceCwd);

          for (const dir of candidates) {
            if (!fsMod.existsSync(pathMod.join(dir, '.git'))) continue;
            try {
              // Try --remotes first (only pushed commits)
              let scope = '--remotes';
              const remoteCount = execSync(
                `git log --remotes --no-merges --author="${currentUser}" --since="6 months ago" --oneline | wc -l`,
                { cwd: dir, encoding: 'utf-8', timeout: 10000, shell: true }
              );
              if (parseInt(remoteCount.trim(), 10) === 0) {
                // No pushed commits — fall back to all branches minus stash
                scope = "--all --exclude='refs/stash'";
              }

              const commitCount = execSync(
                `git log ${scope} --no-merges --author="${currentUser}" --since="6 months ago" --oneline | wc -l`,
                { cwd: dir, encoding: 'utf-8', timeout: 10000, shell: true }
              );
              myCommits = parseInt(commitCount.trim(), 10) || 0;

              const numstat = execSync(
                `git log ${scope} --no-merges --diff-filter=ACMRT --author="${currentUser}" --since="6 months ago" --pretty=tformat: --numstat`,
                { cwd: dir, encoding: 'utf-8', timeout: 15000, shell: true, maxBuffer: 10 * 1024 * 1024 }
              );
              const parsed = parseGitNumstat(numstat);
              myLinesAdded = parsed.linesAdded;
              myLinesDeleted = parsed.linesDeleted;
              Object.assign(gitFileTypes, parsed.fileTypes);
              repoGitDir = dir;
              repoGitScope = scope;
              break;
            } catch { /* git log failed */ }
          }
        }
      } catch { /* skip line counting */ }
      totalLinesAdded += myLinesAdded;
      totalLinesDeleted += myLinesDeleted;
      totalCommits += myCommits;
      for (const [ext, count] of Object.entries(gitFileTypes)) {
        if (!myFileTypes[ext] || count > myFileTypes[ext]) myFileTypes[ext] = count;
        if (!globalFileTypes[ext] || count > (globalFileTypes[ext] || 0)) globalFileTypes[ext] = count;
      }

      // Collect per-contributor line stats for this repo (batch: one git log, all authors)
      if (repoGitDir) {
        try {
          const allNumstat = execSync(
            `git log ${repoGitScope} --no-merges --diff-filter=ACMRT --since="6 months ago" --format=">>>%aN" --numstat`,
            { cwd: repoGitDir, encoding: 'utf-8', timeout: 20000, shell: true, maxBuffer: 10 * 1024 * 1024 }
          );
          let curAuthor = '';
          const authorLines: Record<string, { added: number; deleted: number }> = {};
          for (const line of allNumstat.split('\n')) {
            if (line.startsWith('>>>')) {
              curAuthor = line.substring(3).trim();
              continue;
            }
            const parts = line.trim().split('\t');
            if (parts.length < 3 || !curAuthor || curAuthor === currentUser) continue;
            if (BINARY_EXT.test(parts[2])) continue;
            const a = parseInt(parts[0], 10), d = parseInt(parts[1], 10);
            if (!authorLines[curAuthor]) authorLines[curAuthor] = { added: 0, deleted: 0 };
            if (!isNaN(a)) authorLines[curAuthor].added += a;
            if (!isNaN(d)) authorLines[curAuthor].deleted += d;
          }
          for (const [author, lines] of Object.entries(authorLines)) {
            const pp = personMap.get(author);
            if (pp && pp.repoStats[repoName]) {
              pp.repoStats[repoName].linesAdded = lines.added;
              pp.repoStats[repoName].linesDeleted = lines.deleted;
            }
          }
        } catch { /* skip contributor line stats */ }
      }

      const topReviewers = Object.entries(reviewerStats)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([name, s]) => ({ name, count: s.count, approveRate: s.count > 0 ? Math.round(s.approved / s.count * 100) : 0 }));

      if (myCreated > 0 || myReviewed > 0 || myCommits > 0) {
        repoProfiles.push({
          name: repoName,
          myPRsCreated: myCreated,
          myPRsReviewed: myReviewed,
          myComments,
          myCommits,
          myLinesAdded,
          myLinesDeleted,
          myFileTypes,
          topReviewersForMe: topReviewers,
          totalPRs: prs.length,
          totalContributors: repoContributors.size,
          lastActivity: lastDate ? new Date(lastDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '',
        });
      }
    } catch (err) {
      logger.warn(`DeveloperProfile: failed for ${repoName}`, { error: String(err) });
    }
  }

  // Build top collaborators (sorted by total interaction score)
  const topCollabs = buildTopCollaborators([...personMap.values()]);

  logger.info(`DeveloperProfile: ${repoProfiles.length} repos, ${personMap.size} people, ${totalCreated} PRs created, ${totalReviewed} reviewed`);

  return {
    currentUser,
    currentAlias,
    repos: repoProfiles,
    people: [...personMap.values()].sort((a, b) =>
      (b.theyReviewedMyPRs + b.iReviewedTheirPRs) - (a.theyReviewedMyPRs + a.iReviewedTheirPRs)
    ),
    totalPRsCreated: totalCreated,
    totalPRsReviewed: totalReviewed,
    totalComments,
    totalCommits,
    totalLinesAdded,
    totalLinesDeleted,
    fileTypeSummary: globalFileTypes,
    topCollaborators: topCollabs,
  };
}

function makePersonProfile(name: string, uniqueName?: string): PersonProfile {
  const alias = (uniqueName || '').includes('@') ? (uniqueName || '').split('@')[0] : (uniqueName || name);
  return { name, alias, theyReviewedMyPRs: 0, iReviewedTheirPRs: 0, theyCommentedOnMyPRs: 0, iCommentedOnTheirPRs: 0, sharedRepos: [], contributedRepos: [], repoStats: {}, theirApproveRate: 0 };
}

function emptyProfile(): DeveloperProfile {
  return { currentUser: '', currentAlias: '', repos: [], people: [], totalPRsCreated: 0, totalPRsReviewed: 0, totalComments: 0, totalCommits: 0, totalLinesAdded: 0, totalLinesDeleted: 0, fileTypeSummary: {}, topCollaborators: [] };
}

// ─── Repo Detection ─────────────────────────────────────────────────

export function detectADORepos(cwd: string): { org: string; project: string; repos: string[] } {
  const repos: string[] = [];
  let org = 'msazure';
  let project = 'One';

  try {
    const remotes = execSync('git remote -v', { cwd, encoding: 'utf-8', timeout: 3000, shell: true });
    for (const line of remotes.split('\n')) {
      const m1 = line.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^\s]+)/);
      if (m1) { org = m1[1]; project = m1[2]; if (!repos.includes(m1[3])) repos.push(m1[3]); }
      const m2 = line.match(/(\w+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^\s]+)/);
      if (m2) { org = m2[1]; project = m2[2]; if (!repos.includes(m2[3])) repos.push(m2[3]); }
    }
  } catch { /* no git */ }

  try {
    const path = require('path');
    const fs = require('fs');
    const parentDir = path.dirname(cwd);
    const siblings = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      try {
        const remote = execSync('git remote get-url origin', { cwd: path.join(parentDir, entry.name), encoding: 'utf-8', timeout: 2000, shell: true }).trim();
        const m = remote.match(/(?:dev\.azure\.com|visualstudio\.com)\/(?:DefaultCollection\/)?([^/]+)\/([^/]+)\/_git\/([^\s]+)/);
        if (m && !repos.includes(m[3])) { repos.push(m[3]); org = m[1]; project = m[2]; }
      } catch { /* not a git repo */ }
    }
  } catch { /* skip */ }

  return { org, project, repos };
}
