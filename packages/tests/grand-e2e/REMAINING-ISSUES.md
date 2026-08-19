# Retired production-readiness queue

This file no longer carries a second issue register. Its former contents were a
pre-merge working queue and had begun contradicting the code and the maintained
documents.

Use:

- [`ISSUES.md`](ISSUES.md) for the current open issues;
- [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md) for the six properties,
  test contracts and historical red→green analysis;
- [`FINDINGS.md`](FINDINGS.md) for measured conclusions and the next boundary;
- [`HANDOFF.md`](HANDOFF.md) for the current run playbook.

The retired analysis remains available in git history. Do not add new work to
this file or copy the old `(owner, token_type, value)` marker model back into
current documentation: PR #45 persists exact unshielded marker identities
`(owner, intent_hash, output_no)`, and Phase (d) has now switched the
classifier onto them, so the shape model is dead on both the write and the
read side.
