# Localization

Two different things share this word, and the difference decides what the designer can do for you:

1. **WinForms resource localization** — the model Visual Studio implements. A form is *localizable*: its
   generated code applies properties from a `.resx` through `ComponentResourceManager.ApplyResources`, with one
   `.resx` per culture. **The designer supports this end to end.**
2. **Your own localization layer** — a shared class called from `InitializeComponent`
   (`this.label1.Text = Loc.GetString("Key")`). The designer **does not manage** this, renders around it, and
   protects it. See [Externally localized forms](#externally-localized-forms).

---

## The WinForms model

A localizable form looks like this:

```csharp
System.ComponentModel.ComponentResourceManager resources =
    new System.ComponentModel.ComponentResourceManager(typeof(Form1));
...
resources.ApplyResources(this.button1, "button1");
this.button1.Name = "button1";
```

with values in sibling files:

```
Form1.resx          neutral   →  button1.Text = "Save"
Form1.ru-RU.resx    Russian   →  button1.Text = "Сохранить"
```

### Choosing a culture

The globe button in the editor toolbar picks which resource set you are looking at and editing. `(Default)` is
the neutral `.resx`; any sibling `Form1.<culture>.resx` is offered, and **Create culture…** accepts any real .NET
culture name. A culture whose `.resx` does not exist yet is created by your **first edit** in that culture — pick
the culture, then change a property (Text, for example) in the Properties panel.

Culture names are validated against real .NET cultures. A well-formed but non-existent tag such as `en-EN` is
refused: ICU would accept it, but the resulting `Form1.en-EN.resx` would never be loaded by any `ResourceManager`.

### Editing a localizable form

- Properties backed by `ApplyResources` are written to the **selected** culture's `.resx`, never into code.
- Structural changes (adding, deleting, reparenting controls) are **refused** on a localizable form: they belong
  to generated source, which the resource-first model owns. Edit those as code.
- The canvas shows a persistent notice naming the culture you are editing. It can be collapsed to its icon; it is
  never removed, because "this edit goes into resources, not code" must stay visible.

### Add Localization (converting a plain form)

Picking a culture on a form that is not localizable offers **Add Localization** — Visual Studio's
`Localizable = true`. It:

- lifts every localizable value (text, position, size, tab order, fonts, anchoring) out of `InitializeComponent`
  into the neutral `.resx`, replacing them with one `resources.ApplyResources(...)` call per component;
- leaves `Name`, event wiring, `Controls.Add` and all structural code exactly where they are;
- reads values from the **live rendered form**, so the picture does not change — the engine test suite compares
  the rendered PNG byte-for-byte across the conversion;
- applies source and `.resx` as **one undoable edit**, and writes both to disk together.

It **refuses** rather than approximating when: the form contains constructs the engine cannot interpret, a
value's type cannot round-trip through the resource writer, or the form is already localizable.

---

## Externally localized forms

Many products localize through a shared manager instead of per-form `.resx`:

```csharp
this._azimuthLabel.Text = Localization.LocalizationManager.GetString("Azimuth") + ":";
```

This is **not** the WinForms model, and the designer treats it as your code, not its own.

**What works.** The form opens and renders. Layout, sizes, containment, adding and deleting controls, editing
other properties — all normal, and all byte-local: your localization calls are not touched.

**What you will notice.** The modern engine (.NET 10, serving `net8.0-windows` / `net9.0-windows` /
`net10.0-windows` projects) cannot evaluate a call into your assembly — it never executes project code when opening
a designer — so that statement is reported as skipped and the control renders **without its text**. The banner
tells you how many constructs were skipped. On a `net4x`/DevExpress project such a call is a construct the
interpreter cannot represent, so that form drops to its **disclosed compiled fallback** — the last build — and the
real localized text *is* visible.

**What to avoid.** Editing the very property that the call assigns (usually `Text`) replaces the call with a
literal:

```diff
- this._azimuthLabel.Text = Localization.LocalizationManager.GetString("Azimuth") + ":";
+ this._azimuthLabel.Text = "Азимут";
```

Change such text in code, not in the property grid.

**Why the engine does not just call your method.** Executing project code to resolve a string would mean running
arbitrary user code — static constructors, file and network access, process launches — during "open the
designer". Neither `static`, nor `returns string`, nor "the assembly is already loaded" is a security boundary,
and a timeout limits waiting, not side effects. The compiled `net4x` fallback is the explicit, disclosed place
where your real code runs — it is entered automatically with a named reason, not opted into — while the
live-source interpreter deliberately stays out of it.

**Add Localization and your scheme do not collide.** The conversion refuses any form containing constructs it
cannot interpret, which includes these calls — so it will not try to migrate your shared localization into
per-form `.resx`.
