import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const roles = ['code_reviewer', 'test_reviewer', 'spec_reviewer', 'security_reviewer'];
const maxRepairCycles = 3;
// 新しいToolは親が実効権限を監査してから許可する。Sandboxの代替ではない。
const isolatedTools = new Set([
  'apply_patch', 'clock__curr_time', 'view_image', 'web__run',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
]);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every(text);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireEvidence = (condition, field) => {
  if (!condition) throw new Error(`Evidence契約不正: ${field}`);
};

const validateReview = (review, cycle, index, seenThreads) => {
  requireEvidence(object(review) && roles.includes(review.role), 'role');
  requireEvidence(text(review.threadId) && !seenThreads.has(review.threadId), 'threadId');
  seenThreads.add(review.threadId);
  const runtime = review.runtime;
  requireEvidence(object(runtime) && runtime.sandbox === 'read-only' && runtime.approvalPolicy === 'never', 'runtime');
  requireEvidence(strings(runtime.availableTools) && runtime.availableTools.every((tool) => isolatedTools.has(tool)), 'availableTools');
  for (const field of ['sandboxEvidence', 'probeEvidence', 'toolInventoryEvidence']) {
    requireEvidence(text(runtime[field]), field);
  }
  const output = review.output;
  requireEvidence(object(output) && output.role === review.role && output.cycle === index, 'output identity');
  requireEvidence(output.baseCommit === cycle.baseCommit && output.diffId === cycle.diffId, 'output target');
  requireEvidence(['pass', 'fail', 'blocked'].includes(output.result), 'result');
  for (const field of ['missingEvidence', 'reviewedScope', 'unverified', 'residualRisk']) {
    requireEvidence(strings(output[field]), field);
  }
  requireEvidence(output.reviewedScope.length > 0 && Array.isArray(output.findings), 'reviewedScope/findings');
  for (const finding of output.findings) {
    requireEvidence(object(finding) && ['Blocker', 'Major', 'Minor'].includes(finding.severity), 'finding severity');
    requireEvidence(
      (finding.file === null && finding.line === null) ||
        (text(finding.file) && Number.isInteger(finding.line) && finding.line > 0),
      'finding location',
    );
    for (const field of ['evidence', 'requirement_or_doc_rule', 'minimum_fix']) requireEvidence(text(finding[field]), field);
  }
  if (output.result === 'pass') requireEvidence(output.findings.length === 0 && output.missingEvidence.length === 0, 'pass with unresolved evidence');
  if (output.result === 'fail') requireEvidence(output.findings.length + output.missingEvidence.length > 0, 'fail without reason');
  return output;
};

const classify = (cycle, index, seenThreads) => {
  requireEvidence(object(cycle) && text(cycle.baseCommit) && text(cycle.diffId), 'cycle target');
  requireEvidence(Array.isArray(cycle.reviews) && cycle.reviews.length === roles.length, 'four reviews');
  requireEvidence(new Set(cycle.reviews.map((review) => review?.role)).size === roles.length, 'distinct roles');
  const outputs = cycle.reviews.map((review) => validateReview(review, cycle, index, seenThreads));
  // 未承認Decision等のBlockerを親が解釈して自動修正しない。
  if (outputs.some((output) => output.result === 'blocked' || output.findings.some((finding) => finding.severity === 'Blocker'))) return 'blocked';
  return outputs.every((output) => output.result === 'pass') ? 'pass' : 'fail';
};

/**
 * 親が検証・保存した4役の結果を集計し、Draft PR／修正／停止の次工程を返す。
 * Evidence参照の真偽や実際のSandboxを強制するToolではない。親による実物照合が前提。
 * @param {unknown} input 固定した最新対象と、初回から修正後までの全Cycleの記録。
 * @returns {{result: string, action: string, reason: string}} 不正・不明な入力はblocked／stop。
 */
export const evaluateReviewCycle = (input) => {
  try {
    requireEvidence(object(input) && object(input.currentTarget), 'currentTarget');
    requireEvidence(Array.isArray(input.cycles) && input.cycles.length >= 1 && input.cycles.length <= maxRepairCycles + 1, 'repair count');
    const current = input.cycles.at(-1);
    requireEvidence(object(current) && current.baseCommit === input.currentTarget.baseCommit && current.diffId === input.currentTarget.diffId, 'latest target');
    const seenThreads = new Set();
    const blockedHistory = input.blockedHistory === undefined ? [] : input.blockedHistory;
    requireEvidence(Array.isArray(blockedHistory), 'blockedHistory');
    for (const entry of blockedHistory) {
      requireEvidence(object(entry) && Number.isInteger(entry.cycle) && entry.cycle >= 0 && entry.cycle < input.cycles.length, 'blocked history cycle');
      requireEvidence(text(entry.resolutionEvidence), 'blocked resolution evidence');
      requireEvidence(classify(entry.review, entry.cycle, seenThreads) === 'blocked', 'stopped review');
      const resumed = input.cycles[entry.cycle];
      requireEvidence(
        entry.review.baseCommit === resumed.baseCommit && entry.review.diffId === resumed.diffId,
        'resolved blocked target',
      );
    }
    const results = input.cycles.map((cycle, index) => classify(cycle, index, seenThreads));
    for (let index = 0; index < results.length - 1; index += 1) {
      if (results[index] === 'fail') continue;
      const previous = input.cycles[index];
      const next = input.cycles[index + 1];
      requireEvidence(
        results[index] === 'pass' && text(next.previousTargetInvalidated) &&
          (previous.baseCommit !== next.baseCommit || previous.diffId !== next.diffId),
        'history after terminal gate',
      );
    }
    const result = results.at(-1);
    if (result === 'blocked') return { result, action: 'stop', reason: 'blocked-review' };
    if (result === 'pass') return { result, action: 'draft-pr', reason: 'four-pass' };
    if (input.cycles.length === maxRepairCycles + 1) return { result: 'blocked', action: 'stop', reason: 'repair-limit' };
    return { result: 'fail', action: 'repair', reason: 'review-findings' };
  } catch (error) {
    return { result: 'blocked', action: 'stop', reason: error instanceof Error ? error.message : 'invalid-evidence' };
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = evaluateReviewCycle(JSON.parse(await readFile(process.argv[2], 'utf8')));
  } catch {
    result = { result: 'blocked', action: 'stop', reason: 'input-unreadable-or-invalid-json' };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.result === 'pass' ? 0 : result.result === 'fail' ? 1 : 2;
}
