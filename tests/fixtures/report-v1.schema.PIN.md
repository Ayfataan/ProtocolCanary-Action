# Pin record: `report-v1.schema.json` (#447)

This file records where `tests/fixtures/report-v1.schema.json` came from, so
the differential test in `tests/unit/report-schema-differential.test.ts` runs
against a known, byte-identical copy of the engine's published report
contract.

| Field | Value |
|---|---|
| Source repository | `StellarCanary/Protocol-Canary` |
| Source path | `docs/schemas/report-v1.schema.json` |
| Source commit (full SHA on `main`) | `2df04f71a4d65682379ab1fd36df311fe198e84a` |
| SHA-256 of the pinned file | `7a4c04b2980dfe4a0d57f940256841b3140ed8fc7291e90cf826b64bc49f4837` |
| Date pinned | 2026-10-22 |

The pinned file was fetched unchanged from the source commit (`git show
2df04f71a4d65682379ab1fd36df311fe198e84a:docs/schemas/report-v1.schema.json`)
and committed byte-for-byte; the SHA-256 above is of the committed file.

## Scope of the pin

- The schema exists on Protocol-Canary `main` but **not** in any release tag
  (`v0.1.0`, `v0.1.1`, `v0.2.0` do not contain `docs/schemas/`). Reports from
  released engines are therefore **not** evidence of conformance to this
  schema, and neither the test nor this file claims that they are.
- `.github/workflows/report-schema-sync.yml` compares this pinned copy against
  Protocol-Canary `main` on a schedule and fails with a drift report when the
  contents differ. A failed download is reported as an infrastructure problem,
  never as drift.

## Re-pinning

When the sync workflow reports drift:

1. Fetch the schema at a **full commit SHA** on Protocol-Canary `main`
   (`git show <sha>:docs/schemas/report-v1.schema.json`).
2. Replace `tests/fixtures/report-v1.schema.json` with the fetched file,
   unchanged.
3. Update the commit SHA, SHA-256 (`sha256sum tests/fixtures/report-v1.schema.json`)
   and date in the table above.
4. Review the differential test for new keywords the pinned schema may use;
   the test fails loudly on any keyword it does not implement.
5. Review `tests/fixtures/report-schema-divergences.json` and update it if the
   re-pinned schema changes an observed disagreement.
