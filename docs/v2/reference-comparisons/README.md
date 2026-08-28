# Product-to-Visual-Studio render comparisons

This directory contains product PNGs and machine-readable pixel comparisons against the immutable Visual Studio
reference traces in `../reference-traces`. The comparison is restricted to the 360×180 WinForms client surface; Visual
Studio chrome, tool windows, selection handles outside the form, and the standalone preview's non-client chrome are not
part of the claim.

Run `scripts/compare-visual-studio-reference-renders.ps1` from the repository root to rebuild both engines, render the
modern S013 Button plus net48 interpreted S011 generic-base form and S014 TextBox through the actual product paths,
verify the archived trace/source hashes, crop the matching client regions, and enforce the frozen tolerance. A missing
Button image, focused runtime-style TextBox, or false generic-base compiled fallback therefore fails the gate.

The current archived `VS18.7.11911.148-20260821T124034Z-product` run records all three comparisons. S013 and S014 are
pixel-exact; S011 differs on 113 of 64,800 pixels (0.174383%, MAE/channel 0.149388), including the Visual Studio
inheritance adornment and remaining within the frozen 1%/1.0 tolerance. This is bounded evidence for S011/S013/S014
only; it does not imply that the other Visual Studio reference scenarios were executed.
