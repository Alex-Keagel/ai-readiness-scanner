import { describe, it, expect } from 'vitest';
import {
  filterReviewers,
  parseGitNumstat,
  buildTopCollaborators,
  processPR,
  PersonProfile,
} from '../../live/developerNetwork';

// ─── filterReviewers ────────────────────────────────────────────────

describe('filterReviewers', () => {
  it('excludes TEAM FOUNDATION groups', () => {
    const reviewers = [
      { displayName: 'Alice', vote: 10 },
      { displayName: '[TEAM FOUNDATION]\\ZTS Backend', vote: 0 },
      { displayName: 'Bob', vote: -5 },
    ];
    const result = filterReviewers(reviewers);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.displayName)).toEqual(['Alice', 'Bob']);
  });

  it('excludes bracketed group names', () => {
    const reviewers = [
      { displayName: '[Security Reviewers]', vote: 10 },
      { displayName: 'Alice', vote: 10 },
    ];
    expect(filterReviewers(reviewers)).toHaveLength(1);
    expect(filterReviewers(reviewers)[0].displayName).toBe('Alice');
  });

  it('excludes auto-assigned CODEOWNERS with vote=0', () => {
    const reviewers = [
      { displayName: 'Alice', vote: 0 },   // CODEOWNERS auto-assign, never voted
      { displayName: 'Bob', vote: 10 },     // approved
      { displayName: 'Carol', vote: -10 },  // rejected
      { displayName: 'Dave', vote: 5 },     // approved with suggestions
      { displayName: 'Eve', vote: -5 },     // waiting for author
    ];
    const result = filterReviewers(reviewers);
    expect(result).toHaveLength(4);
    expect(result.map(r => r.displayName)).toEqual(['Bob', 'Carol', 'Dave', 'Eve']);
  });

  it('returns empty array when all reviewers are auto-assigned', () => {
    const reviewers = [
      { displayName: 'Alice', vote: 0 },
      { displayName: 'Bob', vote: 0 },
    ];
    expect(filterReviewers(reviewers)).toHaveLength(0);
  });

  it('handles empty reviewers array', () => {
    expect(filterReviewers([])).toHaveLength(0);
  });

  it('handles reviewers with missing displayName', () => {
    const reviewers = [
      { vote: 10 },
      { displayName: null, vote: 5 },
      { displayName: 'Alice', vote: 10 },
    ];
    // null/undefined displayName doesn't include TEAM FOUNDATION or [, so it passes through
    expect(filterReviewers(reviewers)).toHaveLength(3);
  });
});

// ─── parseGitNumstat ────────────────────────────────────────────────

describe('parseGitNumstat', () => {
  it('parses basic numstat output', () => {
    const output = [
      '10\t2\tsrc/index.ts',
      '5\t3\tsrc/utils.ts',
      '20\t0\tsrc/domain/user.py',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(35);
    expect(result.linesDeleted).toBe(5);
    expect(result.fileTypes).toEqual({ ts: 2, py: 1 });
  });

  it('keeps committed code files (.csv, .json, .ipynb, .kql)', () => {
    const output = [
      '100\t50\tsrc/engine.ts',
      '5000\t0\tanalysis/training.csv',
      '200\t10\tconfig/settings.json',
      '300\t0\tnotebooks/analysis.ipynb',
      '50\t5\tsrc/helper.py',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(5650);
    expect(result.linesDeleted).toBe(65);
    expect(result.fileTypes).toEqual({ ts: 1, csv: 1, json: 1, ipynb: 1, py: 1 });
  });

  it('keeps files in any directory (no hardcoded path filters)', () => {
    const output = [
      '10\t2\tsrc/main.ts',
      '500\t0\tsrc/data/cache.txt',
      '300\t5\ttests/fixtures/sample.py',
      '200\t0\tapps/bot_classification/input/list.txt',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(1010);
    expect(result.linesDeleted).toBe(7);
  });

  it('filters binary ML artifacts (.pkl, .cbm, .h5, .onnx)', () => {
    const output = [
      '10\t2\tsrc/train.py',
      '0\t0\tmodels/best.cbm',
      '0\t0\texport/model.h5',
      '0\t0\texport/model.onnx',
      '0\t0\texport/model.safetensors',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(10);
    expect(result.linesDeleted).toBe(2);
    expect(result.fileTypes).toEqual({ py: 1 });
  });

  it('keeps .lock, .map, .snap, .svg, .tfevents as committed files', () => {
    const output = [
      '5000\t0\tpackage-lock.json',
      '100\t0\tdist/bundle.js.map',
      '200\t0\tassets/logo.svg',
      '50\t0\ttests/ui.test.snap',
      '300\t0\tlogs/run.tfevents',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(5650);
    expect(result.fileTypes).toEqual({ json: 1, map: 1, svg: 1, snap: 1, tfevents: 1 });
  });

  it('filters malformed git rename paths with quotes or arrows', () => {
    const output = [
      '10\t2\tsrc/index.ts',
      '903\t0\t{old => new}/module.py"',
      '50\t5\tsrc/utils.ts',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(60);  // 10 + 50 (rename filtered)
    expect(result.linesDeleted).toBe(7);
    expect(result.fileTypes).toEqual({ ts: 2 });
  });

  it('handles empty output', () => {
    const result = parseGitNumstat('');
    expect(result.linesAdded).toBe(0);
    expect(result.linesDeleted).toBe(0);
    expect(result.fileTypes).toEqual({});
  });

  it('handles output with blank lines (from --pretty=tformat:)', () => {
    const output = [
      '',
      '10\t2\tsrc/index.ts',
      '',
      '5\t1\tsrc/utils.ts',
      '',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.linesAdded).toBe(15);
    expect(result.linesDeleted).toBe(3);
  });

  it('handles binary files (shown as - in numstat)', () => {
    const output = [
      '10\t2\tsrc/index.ts',
      '-\t-\tmedia/screenshot.png',
      '5\t1\tsrc/utils.ts',
    ].join('\n');
    const result = parseGitNumstat(output);
    // Binary lines have NaN for added/deleted, should be skipped
    expect(result.linesAdded).toBe(15);
    expect(result.linesDeleted).toBe(3);
  });

  it('collects diverse file types correctly', () => {
    const output = [
      '10\t2\tsrc/app.ts',
      '5\t1\tsrc/style.css',
      '20\t3\tsrc/index.html',
      '8\t0\tsrc/module.ts',
      '15\t5\tscripts/deploy.sh',
      '30\t10\tsrc/lib.py',
      '12\t4\tsrc/Main.cs',
    ].join('\n');
    const result = parseGitNumstat(output);
    expect(result.fileTypes).toEqual({ ts: 2, css: 1, html: 1, sh: 1, py: 1, cs: 1 });
  });

  it('skips files without extension', () => {
    const output = [
      '10\t2\tsrc/index.ts',
      '5\t0\tMakefile',
      '3\t0\tDockerfile',
    ].join('\n');
    const result = parseGitNumstat(output);
    // Makefile and Dockerfile have no dot → no extension → not counted in fileTypes
    expect(result.linesAdded).toBe(18);
    expect(result.fileTypes).toEqual({ ts: 1 });
  });
});

// ─── buildTopCollaborators ──────────────────────────────────────────

describe('buildTopCollaborators', () => {
  const makePerson = (name: string, overrides?: Partial<PersonProfile>): PersonProfile => ({
    name, alias: name.toLowerCase(), theyReviewedMyPRs: 0, iReviewedTheirPRs: 0,
    theyCommentedOnMyPRs: 0, iCommentedOnTheirPRs: 0, sharedRepos: [], contributedRepos: [], repoStats: {}, theirApproveRate: 0,
    ...overrides,
  });

  it('ranks by total interaction score', () => {
    const people = [
      makePerson('Alice', { theyReviewedMyPRs: 3, theyCommentedOnMyPRs: 2 }), // score 5
      makePerson('Bob', { iReviewedTheirPRs: 10 }),                            // score 10
      makePerson('Carol', { theyReviewedMyPRs: 1 }),                           // score 1
    ];
    const result = buildTopCollaborators(people);
    expect(result[0]).toEqual({ name: 'Bob', score: 10 });
    expect(result[1]).toEqual({ name: 'Alice', score: 5 });
    expect(result[2]).toEqual({ name: 'Carol', score: 1 });
  });

  it('respects limit parameter', () => {
    const people = Array.from({ length: 20 }, (_, i) =>
      makePerson(`Person${i}`, { theyReviewedMyPRs: 20 - i })
    );
    expect(buildTopCollaborators(people, 5)).toHaveLength(5);
    expect(buildTopCollaborators(people)).toHaveLength(15); // default limit
  });

  it('handles empty array', () => {
    expect(buildTopCollaborators([])).toEqual([]);
  });

  it('sums all interaction types', () => {
    const people = [
      makePerson('Alice', {
        theyReviewedMyPRs: 2,
        iReviewedTheirPRs: 3,
        theyCommentedOnMyPRs: 4,
        iCommentedOnTheirPRs: 5,
      }),
    ];
    const result = buildTopCollaborators(people);
    expect(result[0].score).toBe(14);
  });
});

// ─── processPR ──────────────────────────────────────────────────────

describe('processPR', () => {
  const ME = 'Alex Keagel';

  function makePR(creator: string, reviewers: any[] = []) {
    return {
      createdBy: { displayName: creator, uniqueName: creator.toLowerCase() + '@corp.com' },
      reviewers,
    };
  }

  it('returns "created" for my PR', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR(ME, [{ displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' }]);
    const result = processPR(pr, ME, 'repo-a', personMap, reviewerStats);
    expect(result).toBe('created');
  });

  it('tracks reviewer who approved my PR', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR(ME, [
      { displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' },
      { displayName: 'Carol', vote: -5, uniqueName: 'carol@corp.com' },
    ]);
    processPR(pr, ME, 'repo-a', personMap, reviewerStats);

    expect(reviewerStats['Bob']).toEqual({ count: 1, approved: 1 });
    expect(reviewerStats['Carol']).toEqual({ count: 1, approved: 0 });
    expect(personMap.get('Bob')!.theyReviewedMyPRs).toBe(1);
    expect(personMap.get('Carol')!.theyReviewedMyPRs).toBe(1);
  });

  it('ignores auto-assigned CODEOWNERS (vote=0) on my PR', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR(ME, [
      { displayName: 'CodeOwner', vote: 0, uniqueName: 'codeowner@corp.com' },
      { displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' },
    ]);
    processPR(pr, ME, 'repo-a', personMap, reviewerStats);

    expect(reviewerStats['CodeOwner']).toBeUndefined();
    expect(personMap.has('CodeOwner')).toBe(false);
    expect(reviewerStats['Bob']).toEqual({ count: 1, approved: 1 });
  });

  it('does not count self as reviewer', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR(ME, [
      { displayName: ME, vote: 10 },
      { displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' },
    ]);
    processPR(pr, ME, 'repo-a', personMap, reviewerStats);

    expect(reviewerStats[ME]).toBeUndefined();
    expect(personMap.has(ME)).toBe(false);
    expect(reviewerStats['Bob']).toEqual({ count: 1, approved: 1 });
  });

  it('returns "reviewed" when I reviewed someone else\'s PR', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR('Bob', [
      { displayName: ME, vote: 10, uniqueName: 'alex@corp.com' },
    ]);
    const result = processPR(pr, ME, 'repo-a', personMap, reviewerStats);

    expect(result).toBe('reviewed');
    expect(personMap.get('Bob')!.iReviewedTheirPRs).toBe(1);
    expect(personMap.get('Bob')!.sharedRepos).toContain('repo-a');
  });

  it('returns "none" for PRs where I\'m not involved', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR('Bob', [
      { displayName: 'Carol', vote: 10 },
    ]);
    const result = processPR(pr, ME, 'repo-a', personMap, reviewerStats);
    expect(result).toBe('none');
    expect(personMap.size).toBe(0);
  });

  it('returns "none" when I\'m auto-assigned but never voted on someone else\'s PR', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR('Bob', [
      { displayName: ME, vote: 0 },  // auto-assigned, never reviewed
    ]);
    const result = processPR(pr, ME, 'repo-a', personMap, reviewerStats);
    expect(result).toBe('none');
    expect(personMap.size).toBe(0);
  });

  it('accumulates shared repos across multiple PRs', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};

    processPR(makePR(ME, [{ displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' }]), ME, 'repo-a', personMap, reviewerStats);
    processPR(makePR(ME, [{ displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' }]), ME, 'repo-b', personMap, reviewerStats);
    processPR(makePR(ME, [{ displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' }]), ME, 'repo-a', personMap, reviewerStats);

    const bob = personMap.get('Bob')!;
    expect(bob.theyReviewedMyPRs).toBe(3);
    expect(bob.sharedRepos).toEqual(['repo-a', 'repo-b']); // no duplicates
  });

  it('ignores TEAM FOUNDATION groups in reviewers', () => {
    const personMap = new Map<string, PersonProfile>();
    const reviewerStats: Record<string, { count: number; approved: number }> = {};
    const pr = makePR(ME, [
      { displayName: '[TEAM FOUNDATION]\\Backend Team', vote: 10 },
      { displayName: 'Bob', vote: 10, uniqueName: 'bob@corp.com' },
    ]);
    processPR(pr, ME, 'repo-a', personMap, reviewerStats);

    expect(personMap.size).toBe(1);
    expect(personMap.has('Bob')).toBe(true);
  });
});
