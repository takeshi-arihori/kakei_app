# Group Management Domain

`group.ts` is the compatibility-facing Aggregate module. Domain primitives that have their own validation/equality responsibility live separately:

- `group-value-objects.ts`: Group/Participant/Invitation/close intent identifiers, actor subject, UTC instant
- `group-invariant-violation.ts`: Group invariant violation code and error

`group.ts` re-exports these symbols so existing imports remain compatible while the `Group` Aggregate stays focused on lifecycle and invariant orchestration.
