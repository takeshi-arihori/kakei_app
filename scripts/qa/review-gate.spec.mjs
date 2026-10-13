import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateReviewCycle } from './review-gate.mjs';

const roles = ['code_reviewer', 'test_reviewer', 'spec_reviewer', 'security_reviewer'];
const finding = {
  severity: 'Major', file: 'fixture.mjs', line: 1, evidence: '境界値で再現した',
  requirement_or_doc_rule: 'Fixtureの受入条件', minimum_fix: '境界を含める',
};

const cycle = (index, result = 'pass') => ({
  baseCommit: 'base', diffId: `diff-${index}`,
  reviews: roles.map((role) => ({
    role, threadId: `thread-${index}-${role}`,
    runtime: {
      sandbox: 'read-only', approvalPolicy: 'never',
      availableTools: ['apply_patch', 'clock__curr_time', 'view_image', 'web__run'],
      sandboxEvidence: 'session metadata', probeEvidence: 'sandbox rejected; file absent',
      toolInventoryEvidence: 'ALL_TOOLS and exposed surfaces inspected',
    },
    output: {
      role, cycle: index, baseCommit: 'base', diffId: `diff-${index}`, result,
      findings: result === 'fail' ? [finding] : [], missingEvidence: [],
      reviewedScope: ['Fixtureの全差分と契約'], unverified: [], residualRisk: [],
    },
  })),
});
const input = (cycles = [cycle(0)]) => ({
  currentTarget: { baseCommit: 'base', diffId: cycles.at(-1).diffId }, cycles,
});

test('同一最新対象の4役passだけがDraft PRへ進める', () => {
  assert.equal(evaluateReviewCycle(input()).action, 'draft-pr');
});
test('failを親が修正し新しい4役がpassした履歴を受け入れる', () => {
  assert.equal(evaluateReviewCycle(input([cycle(0, 'fail'), cycle(1)])).action, 'draft-pr');
});
test('pass後の対象変更は根拠付きの新規4役で再評価し修正回数を維持する', () => {
  const changed = cycle(1);
  changed.previousTargetInvalidated = 'Commit Hookが対象Fileを更新した記録';
  assert.equal(evaluateReviewCycle(input([cycle(0), changed])).action, 'draft-pr');
  const failed = cycle(1, 'fail');
  failed.previousTargetInvalidated = changed.previousTargetInvalidated;
  assert.equal(evaluateReviewCycle(input([cycle(0), failed])).action, 'repair');
  assert.equal(evaluateReviewCycle(input([cycle(0), failed, cycle(2, 'fail'), cycle(3, 'fail')])).reason, 'repair-limit');
});
test('pass後の再評価は対象変更と失効Evidenceの両方を必要とする', () => {
  const next = cycle(1);
  assert.equal(evaluateReviewCycle(input([cycle(0), next])).result, 'blocked');
  next.previousTargetInvalidated = '根拠';
  next.diffId = 'diff-0';
  for (const review of next.reviews) review.output.diffId = next.diffId;
  assert.equal(evaluateReviewCycle(input([cycle(0), next])).result, 'blocked');
});
test('監査済みのResource読取りToolを受け入れる', () => {
  const data = input();
  for (const review of data.cycles[0].reviews) {
    review.runtime.availableTools.push('list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource');
  }
  assert.equal(evaluateReviewCycle(data).action, 'draft-pr');
});
test('1役のfailで親のScope内修正へ戻る', () => {
  const data = input(); data.cycles[0].reviews[1].output.result = 'fail';
  data.cycles[0].reviews[1].output.findings = [finding];
  assert.equal(evaluateReviewCycle(data).action, 'repair');
});
test('1役のblockedを他のpassで上書きしない', () => {
  const data = input(); const output = data.cycles[0].reviews[2].output;
  output.result = 'blocked'; output.missingEvidence = ['Owner Decision'];
  assert.equal(evaluateReviewCycle(data).action, 'stop');
});
test('3回修正後もfailなら4回目の修正を開始しない', () => {
  const data = input([0, 1, 2, 3].map((i) => cycle(i, 'fail')));
  assert.equal(evaluateReviewCycle(data).action, 'stop');
  assert.equal(evaluateReviewCycle(data).reason, 'repair-limit');
});
test('上限内の最後の再評価で4役passならDraft PRへ進める', () => {
  assert.equal(evaluateReviewCycle(input([cycle(0, 'fail'), cycle(1, 'fail'), cycle(2, 'fail'), cycle(3)])).action, 'draft-pr');
});
test('5回目の評価を受け入れない', () => {
  assert.equal(evaluateReviewCycle(input([0, 1, 2, 3, 4].map((i) => cycle(i, 'fail')))).result, 'blocked');
});
test('役割欠落・重複、古い対象、Thread再利用を拒否する', () => {
  for (const corrupt of [
    (d) => d.cycles[0].reviews.pop(),
    (d) => { d.cycles[0].reviews[1].role = 'code_reviewer'; },
    (d) => { d.cycles[0].reviews[0].output.diffId = 'old'; },
    (d) => { d.currentTarget.diffId = 'changed-during-review'; },
    (d) => { d.cycles[0].reviews[1].threadId = d.cycles[0].reviews[0].threadId; },
  ]) {
    const data = input(); corrupt(data);
    assert.equal(evaluateReviewCycle(data).result, 'blocked');
  }
  const data = input([cycle(0, 'fail'), cycle(1)]);
  data.cycles[1].reviews[0].threadId = data.cycles[0].reviews[0].threadId;
  assert.equal(evaluateReviewCycle(data).result, 'blocked');
});
test('passを返してもFindingや不足Evidenceがあれば合格にしない', () => {
  for (const field of ['findings', 'missingEvidence']) {
    const data = input(); data.cycles[0].reviews[0].output[field] = field === 'findings' ? [finding] : ['未実施検証'];
    assert.equal(evaluateReviewCycle(data).result, 'blocked');
  }
});
test('重大Securityと書込み可能・不明な実効権限は自動修正しない', () => {
  const severe = input(); const output = severe.cycles[0].reviews[3].output;
  output.result = 'fail'; output.findings = [{ ...finding, severity: 'Blocker' }];
  assert.equal(evaluateReviewCycle(severe).action, 'stop');
  for (const corrupt of [
    (r) => { r.sandbox = 'workspace-write'; },
    (r) => { r.availableTools.push('exec_command'); },
    (r) => { r.probeEvidence = ''; },
  ]) {
    const data = input(); corrupt(data.cycles[0].reviews[0].runtime);
    assert.equal(evaluateReviewCycle(data).result, 'blocked');
  }
});
test('契約不正・検証範囲不明・理由のないfailを合格にしない', () => {
  for (const value of [null, {}, [], { cycles: [] }]) assert.equal(evaluateReviewCycle(value).result, 'blocked');
  for (const corrupt of [
    (o) => { delete o.unverified; },
    (o) => { o.reviewedScope = []; },
    (o) => { o.result = 'fail'; },
    (o) => { o.findings = [{ severity: 'Major' }]; o.result = 'fail'; },
  ]) {
    const data = input(); corrupt(data.cycles[0].reviews[0].output);
    assert.equal(evaluateReviewCycle(data).result, 'blocked');
  }
});

const stopped = (index) => {
  const review = cycle(index);
  for (const entry of review.reviews) entry.threadId += '-blocked';
  review.reviews[2].output.result = 'blocked';
  review.reviews[2].output.missingEvidence = ['Owner Decision待ち'];
  return { cycle: index, review, resolutionEvidence: 'Owner Decisionが確定した記録' };
};
test('解消済みblockedの原結果を保持し同じ修正回数・対象で新規4役を受け入れる', () => {
  const data = input([cycle(0, 'fail'), cycle(1)]);
  data.blockedHistory = [stopped(1)];
  assert.equal(evaluateReviewCycle(data).action, 'draft-pr');
});
test('blocked再開の解消根拠・対象・Thread・原結果を検証する', () => {
  for (const corrupt of [
    (d) => { d.blockedHistory[0].resolutionEvidence = ''; },
    (d) => {
      d.blockedHistory[0].review.diffId = 'different';
      for (const review of d.blockedHistory[0].review.reviews) review.output.diffId = 'different';
    },
    (d) => { d.blockedHistory[0].review.reviews[0].threadId = d.cycles[0].reviews[0].threadId; },
    (d) => { d.blockedHistory[0].review = cycle(0); },
    (d) => { d.blockedHistory[0].cycle = 1; },
    (d) => { d.blockedHistory = {}; },
    (d) => { d.blockedHistory = null; },
  ]) {
    const data = input(); data.blockedHistory = [stopped(0)]; corrupt(data);
    assert.equal(evaluateReviewCycle(data).result, 'blocked');
  }
});
test('blocked再開で最大3回の修正上限や未解消の停止を迂回しない', () => {
  const data = input([0, 1, 2, 3].map((i) => cycle(i, 'fail')));
  data.blockedHistory = [stopped(3)];
  assert.equal(evaluateReviewCycle(data).reason, 'repair-limit');
  const unresolved = input([stopped(0).review, cycle(1)]);
  assert.equal(evaluateReviewCycle(unresolved).result, 'blocked');
});
