<!--
  Thanks for contributing! Please fill this in. Keep PRs small and focused.
  See CONTRIBUTING.md for the dev loop and conventions.
-->

## Summary

<!-- What does this PR do, and why? -->

## Related issue

<!-- e.g. "Closes #123" — PRs should usually reference an issue. -->
Closes #

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactor (no behavior change)
- [ ] 📝 Docs / infrastructure
- [ ] 🔒 Security / engine gate change

## How was this tested?

<!-- Describe what you ran. UI changes MUST be verified with a live F5 run. -->

- [ ] `dotnet build engine -c Release` — 0 warnings, 0 errors
- [ ] `npm run typecheck` (in `extension/`)
- [ ] `npm run build` (in `extension/`)
- [ ] `npm run e2e` (in `extension/`)
- [ ] `node --check` on any changed webview script (`media/*.js`)
- [ ] **Verified UI changes live via F5** (headless tests don't run webview JS)

## Checklist

- [ ] Change set is minimal and focused (one logical change).
- [ ] Comments and identifiers are in English; engine interop stays camelCase.
- [ ] I did **not** weaken any security gate (interpreter allowlists / edit-minimality gates). _If I touched one, I added tests and a review note._
- [ ] Identifiers from user input are validated before being interpolated into generated code.
- [ ] Updated `CHANGELOG.md` under **Unreleased** (if user-facing).
- [ ] No secrets, local paths, or build output committed.

## Screenshots / GIF (for UI changes)

<!-- Drag images here. Before/after is ideal. -->

## Risk & notes

<!-- Anything reviewers should watch out for: edge cases, follow-ups, known gaps. -->
