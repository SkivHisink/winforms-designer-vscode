# Adapter SDK Preview diagnostics

An adapter diagnostic has a stable code and schema path. Rejected paths, file contents, stdout and arbitrary child
exception messages are not trusted user-facing diagnostic text. Inspect the package first, then check the code before
trying an invocation. Static declaration validity, file integrity, compatibility, trust, execution and source
application are separate checks.

| Code or family | Meaning and author action |
|---|---|
| `ADAPTER_SDK_UNSUPPORTED`, `ADAPTER_PROTOCOL_UNSUPPORTED` | Use SDK 0.1.0 and child protocol 1; migrate before changing either version |
| `ADAPTER_OBJECT_INVALID`, `ADAPTER_FIELD_REQUIRED`, `ADAPTER_FIELD_UNKNOWN`, `ADAPTER_FIELD_INVALID` | Fix the exact schema path; unknown fields are refused rather than silently ignored |
| `ADAPTER_PACKAGE_INVALID`, `ADAPTER_PACKAGE_DUPLICATE` | Correct entrypoint membership, file aliases, contribution IDs, cohort range or inconsistent declarations |
| `ADAPTER_PATH_INVALID` | Use portable relative package paths without traversal, streams, device names or ambiguous segments |
| `ADAPTER_CAPABILITY_UNDECLARED`, `ADAPTER_CAPABILITY_UNUSED` | Match each action/editor contribution to its exact declared capability |
| `ADAPTER_SERVICE_UNSUPPORTED` | Remove an unknown service requirement; do not treat an unavailable service as a working stub |
| `ADAPTER_PROVENANCE_UNSUPPORTED` | The current executable policy is local development with certification `none`; a JSON vendor-signature claim is insufficient |
| `ADAPTER_RESPONSE_ID_MISMATCH`, `ADAPTER_RESULT_TARGET_MISMATCH` | Return the exact request identity and selected component/property |
| `ADAPTER_RESULT_TYPE_MISMATCH`, `ADAPTER_RESULT_VALUE_INVALID` | Return the declared live property type and canonical bounded invariant value |
| `ADAPTER_CANCEL_IGNORED` | Honor cancellation; return `cancelled` with no intent |
| `ADAPTER_EDITOR_CHOICE_INVALID` | Use a declared dropdown choice for the explicit input and returned intent; the existing property value may remain outside the list |
| `ADAPTER_MESSAGE_TOO_LARGE`, `ADAPTER_MESSAGE_INVALID`, `ADAPTER_MULTIPLE_REQUESTS`, `ADAPTER_REQUEST_INCOMPLETE` | Use one bounded newline-terminated JSON request/result and no extra stdout |
| `ADAPTER_SAMPLE_REFUSED`, `ADAPTER_SAMPLE_CHOICE_INVALID` | Deliberate sample refusals, useful for conformance; no source is accepted |

The product loader adds diagnostics for trust/enablement, cohort mismatch, file changes, symlinks/reparse points,
undeclared imports, deadline, process failure and late/stale results. Consult the actual inspection/invocation code
returned by the host; a generic retry must never clear a refusal or grant permission. Rebuild a modified package and
reinspect it before deliberately enabling its new hash. Do not relabel a package as certified to suppress a failure.

Manifest JSON, executable `.mjs` modules, and child result bytes must be valid UTF-8. Malformed byte sequences are
refused without replacement decoding: `ADAPTER_MANIFEST_INVALID`, `ADAPTER_MODULE_INVALID`, or
`ADAPTER_RESPONSE_INVALID`, respectively. A valid encoding of the Unicode replacement character remains ordinary
text. A leading BOM is retained during decoding, preserving the existing JSON manifest/result refusal; no child
output or malformed source is copied into a diagnostic.

The child has an execution deadline of at most 5 seconds. Cancellation, revocation, an output bound, or that deadline
starts a separate cleanup-confirmation phase of at most 5 seconds: on Windows the host waits for both the child to
close and its invocation-owned `taskkill /PID /T /F` helper to finish. The original refusal code is preserved after
confirmed termination, including a child that already exited before the helper could find its PID. Unconfirmed
termination reports `ADAPTER_PROCESS_CLEANUP_FAILED`; it never permits a result to be applied. The runtime retains a
live child's physical admission until its actual close. The maximum execution-plus-cleanup allowance after spawn is
10 seconds, excluding package inspection and ordinary event-loop scheduling; cleanup does not grant another adapter
execution or a retry.

The conformance runner asserts exact source preservation on refusal/cancellation and one-step public Undo after
success. The complete product acceptance also supplies modified entrypoints, wrong result types, missing services and
revoked enablement. A passing local sample is evidence for the published adapter contract, not vendor certification,
physical hardware acceptance, or compatibility with an arbitrary native/modal designer binary.
