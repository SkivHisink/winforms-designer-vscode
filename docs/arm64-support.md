# Windows ARM64 support

Version 1.4.0 ships repository-side packaging for two Windows VSIX artifacts:

- `winforms-designer-win32-x64.vsix` targets `win32-x64` and bundles a modern engine published with `dotnet publish -r win-x64`.
- `winforms-designer-win32-arm64.vsix` targets `win32-arm64` and bundles a modern engine published with `dotnet publish -r win-arm64`.

The ARM64 package is native for the modern .NET engine only. Modern WinForms projects targeting `net8.0-windows`, `net9.0-windows`, or `net10.0-windows` should use the ARM64 VS Code Extension Host plus the ARM64 .NET Desktop Runtime.

## .NET Framework compatibility policy

The .NET Framework 4.8 engine is not represented as native ARM64. It remains the x64 compatibility engine because the classic .NET Framework and many vendor WinForms control suites are x64-oriented on Windows ARM64.

On Windows ARM64, `net4x` / DevExpress scenarios are therefore reduced-feature compatibility fallback:

- The ARM64 VSIX may contain the x64 net48 compatibility engine for projects that can run through Windows x64 emulation.
- It is not a native ARM64 .NET Framework engine, and release notes or Marketplace metadata must not describe it that way.
- If the user's vendor controls, targeting packs, or runtime dependencies cannot run under x64 compatibility on Windows ARM64, the net48 designer path is unsupported on that machine.
- Source persistence safety is unchanged: unsupported forms or unrepresentable constructs must remain disclosed and fail closed.

## Release verification expectations

CI and release packaging must prove both artifacts:

- `vsce package --target win32-x64` with modern RID `win-x64`.
- `vsce package --target win32-arm64` with modern RID `win-arm64`.
- `scripts/assert-vsix.ps1` checks the VSIX target, modern deps RID, modern apphost PE machine, and net48 compatibility engine PE machine.

Run the ARM64 package from `extension/` with the RID environment variable set for the whole `vsce` prepublish step;
otherwise `npm run bundle-engine` intentionally defaults back to x64:

```powershell
$env:WFD_BUNDLE_RID = 'win-arm64'
try {
  npx --yes @vscode/vsce@3.9.2 package --target win32-arm64 --no-dependencies -o winforms-designer-win32-arm64.vsix
  powershell -NoProfile -ExecutionPolicy Bypass -File ..\scripts\assert-vsix.ps1 `
    -VsixPath winforms-designer-win32-arm64.vsix `
    -ExpectedTarget win32-arm64 `
    -ExpectedRuntimeIdentifier win-arm64 `
    -ExpectedModernMachine 0xAA64 `
    -ExpectedNet48Machine 0x8664
} finally {
  Remove-Item Env:\WFD_BUNDLE_RID -ErrorAction SilentlyContinue
}
```
