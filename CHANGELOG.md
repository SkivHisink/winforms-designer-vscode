# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Marketplace icon and README screenshots (designer surface, property grid,
  toolbox, and the Choose Toolbox Items dialog).
- `Release` workflow: pushing a `vX.Y.Z` tag builds, gates on e2e, packages a
  self-contained VSIX, creates a GitHub Release, and (when `VSCE_PAT` / `OVSX_PAT`
  secrets are set) publishes to the VS Code Marketplace and Open VSX.

### Notes
- Animated GIFs of the live edit/drag/resize loop are still to be added.

## [0.1.0] — 2026-06-30

First public preview.

### Added
- **Live form rendering** of `.Designer.cs` via a headless .NET 9 engine
  (full-frame render plus per-control dirty-region patches).
- **Visual Studio–style custom editor** — opening a form's `.cs` opens the
  designer; **View Code** switches back to text.
- **Property grid** — primitives, enums, complex types (`Point`, `Size`,
  `Color`, `Font`, `Padding`, `Rectangle`), composite expansion, and
  standard-value dropdowns.
- **Toolbox** — auto-populated from `System.Windows.Forms` plus project-assembly
  controls; add controls to the surface.
- **Direct manipulation** — select, move, resize (8 handles), multi-select +
  rubber-band, group move/delete, align toolbar, tab-order editor, snaplines.
- **Events** — wire / unwire / rewire handlers, generate a stub, navigate to the
  handler body.
- **Component tray** and **document outline**.
- **Safe save** — byte-minimal targeted edits guarded by representability and
  statement-diff gates; encoding/BOM preserved.
- **MSBuild design-time assembly resolution** (multi-target aware) plus an
  explicit `assemblyPath` setting.
- **Export Designer Diagnostics** command.
- Workspace-Trust gating and interpreter allowlists for safe rendering.

[Unreleased]: https://github.com/SkivHisink/winforms-designer-vscode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SkivHisink/winforms-designer-vscode/releases/tag/v0.1.0
