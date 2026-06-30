# Security Policy

## Threat model

Rendering a WinForms designer is **not a passive operation**. To produce a
faithful preview, the engine:

- **Loads and runs your project's control assemblies** — control constructors
  and `OnPaint` execute when a preview is built.
- **Interprets `.Designer.cs`** (constructors, static calls, static reads,
  property setters) through Roslyn.

Two layers contain this:

1. **Workspace Trust** — the extension declares `untrustedWorkspaces.supported:
   false`, so it is **disabled in untrusted workspaces**. Only open projects you
   trust.
2. **Interpreter allowlists** — the engine's `Eval` path executes code from
   `.Designer.cs` only through strict allowlists (known-safe constructions,
   static invocations, and static reads), and edits are guarded by minimality /
   statement-diff gates. Arbitrary code in the file is treated as
   *unrepresentable*, not executed.

A bug that lets a crafted `.Designer.cs` escape these allowlists (e.g. achieve
arbitrary construction, code execution, file-system access, or process
spawning **without** an explicit project-assembly reference) is considered a
**high-severity vulnerability**.

## Supported versions

This project is in preview; security fixes are applied to the latest release on
the `main` branch.

| Version | Supported |
|---------|-----------|
| latest `main` / newest release | ✅ |
| older preview builds | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via **GitHub Security Advisories**:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (`https://github.com/SkivHisink/winforms-designer-vscode/security/advisories/new`).
2. Include a description, affected version, reproduction steps, and ideally a
   minimal `.Designer.cs` that triggers the issue.

If you cannot use GitHub Security Advisories, email the maintainer privately at
**a.khorunzhenko@g.nsu.ru**.

### What to expect

- We aim to acknowledge a report within a few days.
- We'll work with you to confirm, assess severity, and prepare a fix.
- Please give us a reasonable window to ship a fix before public disclosure.
  We're happy to credit you in the advisory unless you prefer to remain
  anonymous.

Thank you for helping keep users safe.
