# WinForms Designer for VS Code

A Windows Forms designer that runs inside VS Code: it renders your form from its **live `.Designer.cs`**, lets you
edit it on a canvas and in a property grid, and writes changes back as **minimal, targeted source edits**.

This wiki is written for two audiences:

- **Users** who want to know what the designer does with their code, and why it sometimes refuses.
- **Maintainers** who need the internal model before changing anything.

## Start here

| Page | What it answers |
|---|---|
| [Architecture](Architecture) | How a form becomes a picture, and why there are two engines |
| [Editing model and safety gates](Editing-model-and-safety-gates) | What the designer writes, what it refuses, and why |
| [Code generation](Code-generation) | Exactly what `Add → Form` and dropping a control produce |
| [Localization](Localization) | The `.resx` model, cultures, `Add Localization`, and **externally localized forms** |
| [.NET Framework and DevExpress](Framework-and-DevExpress) | How `net4x` projects are rendered and what differs |
| [Troubleshooting](Troubleshooting) | Blank previews, refused saves, missing toolbox items |
| [Development](Development) | Building, the four test suites, and where the code lives |

## The one idea worth carrying everywhere

The designer treats your `.Designer.cs` as **your file, not its output**.

Visual Studio regenerates `InitializeComponent` wholesale whenever it saves a form: anything it did not put there
— a helper call, a loop, a comment in the wrong place — is at risk. This designer never does that. Every gesture
is translated into the smallest possible source edit, and each edit passes a gate that verifies it changed *only*
what it claimed to change. When a gate cannot prove that, the gesture is **refused** and the file is left alone.

That single decision explains most of what feels unusual here: why some properties are read-only, why a form can
be previewed but not edited, and why a conversion sometimes declines instead of doing its best.

## Status

The core designer loop is stable and follows semantic versioning from 1.0. The **.NET Framework 4.8 engine**
(used for `net4x` / DevExpress projects) is **experimental** — see
[.NET Framework and DevExpress](Framework-and-DevExpress).
