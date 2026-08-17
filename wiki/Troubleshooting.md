# Troubleshooting

## A control renders without its text

The value comes from an expression the interpreter cannot evaluate — most often a call into your own code:

```csharp
this.label1.Text = Loc.GetString("Azimuth") + ":";
```

The banner reports it as a skipped construct. This is expected on the modern engine, which never executes project
code when opening a designer; a `net4x` project shows the real text because it renders your compiled build. Do
not "fix" it by typing into the property grid — that replaces the call with a literal. See
[Localization → Externally localized forms](Localization#externally-localized-forms).

## "N constructs skipped from this designer"

Some statements in `InitializeComponent` fall outside the interpreter's modeled set. The form still renders; the
listed constructs simply did not take effect in the preview. Click **Show details** for the exact statements and
reasons. Everything else on the form remains fully editable.

## The preview is blank, or shows an old picture

- **Render failed** — the canvas keeps the last good picture and goes read-only until a render succeeds. The
  banner carries the reason; **Retry** and **Rebuild** are offered.
- **Missing type** in the diagnostics means the control's assembly is not loadable from the form's project.
  Use **Choose Control Assembly…** to point the designer at the right build output.

## Saving fails

- *"changed on disk since the designer read it"* — an external writer (git checkout, another editor, a code
  generator) got there first. Revert the file to adopt their version; the designer will not blindly overwrite it.
- *"can't be saved for a localizable form"* — a dirty generated-source buffer on a localizable form, normally a
  recovered hot-exit backup that no longer agrees with the `.resx`. Revert to discard it.

## The toolbox has no "Project Controls"

The log line

```
[toolbox auto-discovery] no related build-output roots; skipped=2 …
```

means the related projects have **not been built yet** — discovery scans build output, so there is nothing to
scan. Build the project and the controls appear. The line is printed once per distinct result, not on a loop.

## A culture was selected but no `.resx` appeared

Selecting a culture only chooses which resource set you edit. The file is created by your **first edit** in that
culture — change a property (Text, for example) in the Properties panel.

## `Add Localization` refused

The conversion declines rather than approximating when:

- the form contains constructs the engine cannot interpret (including calls into your own localization layer);
- a value's type cannot round-trip through the resource writer;
- the form is already localizable.

Nothing is written when it refuses.

## A property is greyed out

Depending on the case: the form's preview failed (everything is read-only), the property is genuinely read-only
on the type, the control is locked, or the form is localizable and the property is not resource-backed. The
status bar states which.

## Nothing happens when I drag a text-sized control's size grips

Label, LinkLabel, CheckBox and RadioButton are created with `AutoSize = true`, so they size themselves to their
content and show no grips — the same as Visual Studio. Set `AutoSize` to `false` in the property grid if you want
a fixed size.

## Reporting a problem

**Export Diagnostics** (command palette) produces a Markdown report with engine state, environment, the active
document and settings — attach it to the issue. It writes no files on its own; it opens an untitled document.
