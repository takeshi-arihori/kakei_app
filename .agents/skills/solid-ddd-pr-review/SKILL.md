---
name: solid-ddd-pr-review
description: Review a GitHub Task implementation before Draft PR creation for meaningful SOLID, DRY, DDD, context-boundary, and Japanese JSDoc issues. Use after implementation and verification, before independent task evaluation and publishing a PR.
---

# SOLID, DRY, and DDD PR Review

Review the concrete Task diff before a Draft PR is created. Treat GitHub requirements, accepted ADRs, and repository architecture documents as authoritative. This is a focused quality gate, not a redesign exercise.

## Inputs

Read only what is needed to understand the change:

- The GitHub Task, Done Criteria, dependency state, and linked Epic.
- Accepted ADRs and relevant repository rules.
- The complete changed-file diff, including tests and documentation.
- Existing neighboring code when needed to establish a real pattern or duplication.

Do not infer an unaccepted decision from code, directory names, diagrams, or old issues. When an unresolved decision affects the change, report it as a blocker and identify the dependent scope.

## Review dimensions

### DDD and boundaries

- Check that each behavior belongs to its owning Bounded Context and layer.
- Check that Domain rules and invariants are enforced by the appropriate Aggregate, Entity, or Value Object, rather than GraphQL, persistence, or orchestration code.
- Treat an Aggregate Root as an Entity with the additional role of guarding an Aggregate boundary. Do not recommend a duplicate Entity wrapper or duplicate type placement.
- Distinguish child Entities by stable identity and lifecycle; do not classify snapshots or data shapes as Entities from their names alone.
- Check Application Use Cases for orchestration, authorization, transaction boundaries, and Port calls. Keep transport and persistence details at their adapters.
- Check that Contexts communicate through accepted IDs, Ports, or explicit public contracts, not direct access to another Context's model or storage.
- Do not recommend microservices or new workspace packages merely because a Context or layer exists. Evaluate the accepted Modular Monolith and actual reuse/ownership needs.

### SOLID and cohesion

- Identify concrete reasons a module has multiple change drivers or a use case owns unrelated behavior.
- Check abstractions against real variation, ownership, and dependency direction; avoid interface-per-class or speculative extensibility recommendations.
- Check substitutability and interface segregation where implementations or consumers demonstrate a real mismatch.
- Check dependency inversion across layer boundaries and whether dependencies are injected at a suitable composition boundary.

### DRY

- Report duplication only when the repeated logic has the same meaning, change reason, and ownership.
- Keep coincidentally similar rules separate when they belong to different Contexts or evolve independently.
- Prefer a small local implementation over premature shared utilities or a new package.

### Japanese JSDoc

- New or changed exported classes, functions, interfaces, types, constants, public methods/properties, and every field in an exported object type or interface must have Japanese JSDoc. Document each discriminated result field as well as the containing type.
- JSDoc should explain purpose and meaningful constraints, failure behavior, or security/transaction semantics. Avoid repeating what a self-explanatory name or type already says.
- Private implementation details and every-line narration do not need JSDoc.
- Report missing, English-only, stale, or misleading public JSDoc as a finding.

## Finding threshold

Report only evidence-backed issues that materially affect correctness, changeability, security, or the accepted architecture. Do not block for personal naming preference, theoretical purity, speculative future reuse, or unrelated pre-existing debt.

Use these severities:

- **Blocker**: violates a confirmed requirement/accepted decision, breaks a critical invariant or security boundary, or depends on a decision that is not accepted.
- **Major**: likely causes a correctness defect, significant coupling, a broken layer/context boundary, or makes a core behavior hard to change safely.
- **Minor**: a localized clarity, cohesion, duplication, or JSDoc issue that does not prevent safe review.

Every finding must include the changed file and line, observed behavior, why it matters under a project rule or Task requirement, and the smallest useful correction. Do not create findings against unchanged code unless the diff introduces or relies on the defect.

## Workflow

1. Read the Task and relevant accepted design sources.
2. Inspect the full diff and trace important dependencies into neighboring code.
3. Evaluate the dimensions above and record concrete findings with severity and file/line evidence.
4. If no findings exist, report **Pass** and state the reviewed dimensions.
5. If Blocker or Major findings exist, fix them before independent evaluation. Fix Minor findings when within Task scope; otherwise record a concise reason and follow-up need.
6. After fixes, rerun the verification affected by the changes and review the updated diff.
7. Pass the final change to the independent Task evaluator. This Skill does not replace that evaluator or authorize PR Ready/merge.

## Output

Return:

- **Result**: Pass or Needs changes.
- **Findings**: severity, file/line, issue, project-grounded reason, and correction; or `None`.
- **Reviewed scope**: Task/ADR and changed areas considered.
- **Verification**: checks rerun after any review-driven correction.
- **Residual Minor items**: reason and follow-up, or `None`.
