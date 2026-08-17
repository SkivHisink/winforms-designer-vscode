# Code generation

The designer aims for **byte-level Visual Studio parity** in what it writes. If VS would write it, so does this
extension; if VS would not, neither does it.

## Add → Form / User Control (Explorer)

Right-click a project file or folder → **Add** → Windows Form, User Control, Component, or Class.

A form is generated as the Visual Studio item template, not an approximation:

```csharp
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MyApp
{
    public partial class Form1 : Form
    {
        public Form1()
        {
            InitializeComponent();
        }
    }
}
```

and the designer half carries the documented members and the generated-code region, with only the assignments
the template itself writes.

Decisions worth knowing:

| Aspect | Behavior |
|---|---|
| `using` block | Omitted when the project enables **implicit usings**; placed inside the namespace when `.editorconfig` sets `csharp_using_directive_placement = inside_namespace` |
| Base type | Unqualified (`: Form`), as VS writes it |
| `.resx` | **Not** seeded on an SDK project (VS does not either); classic projects get one with its `EmbeddedResource` item |
| `AutoScaleDimensions` | **Not** written by the template — a constant pair would rescale the form wherever the default font differs |
| Project items | SDK projects rely on implicit items; classic or `EnableDefaultItems=false` projects receive exact `Compile`/`EmbeddedResource` entries in the **same undoable edit** as the files |

Refused before anything is written: ambiguous project ownership, shared `.projitems`, dynamic or conditioned
MSBuild properties, unsupported wildcard item shapes, non-WinForms targets for a form, and any companion-file
collision. A failed Add cannot leave half a form behind.

## Dropping a control

The generated code follows Visual Studio's own shape:

```csharp
private void InitializeComponent()
{
    this.button1 = new System.Windows.Forms.Button();     // constructors: one leading run
    this.checkBox1 = new System.Windows.Forms.CheckBox();
    this.SuspendLayout();
    // 
    // button1                                            // one commented block per control
    // 
    this.button1.Location = new System.Drawing.Point(124, 80);
    this.button1.Name = "button1";
    this.button1.Size = new System.Drawing.Size(75, 23);
    this.button1.TabIndex = 0;
    this.button1.Text = "button1";
    this.button1.UseVisualStyleBackColor = true;
    // 
    // Form1                                              // the form's own block, alphabetical
    // 
    this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
    this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
    this.ClientSize = new System.Drawing.Size(800, 450);
    this.Controls.Add(this.checkBox1);                    // newest FIRST → on top of the z-order
    this.Controls.Add(this.button1);
    this.Name = "Form1";
    this.Text = "Form1";
    this.ResumeLayout(false);
}

#endregion

private System.Windows.Forms.Button button1;             // fields below the region
private System.Windows.Forms.CheckBox checkBox1;
```

Details that matter:

- **Field names** follow VS: only the first letter is lowered (`checkBox1`, `dataGridView1`).
- **Z-order**: the newest `Controls.Add` comes first, so a freshly dropped control is on top — the same as VS.
- **`AutoScaleDimensions`** is persisted from the **live rendered form** on the first drop into a form that has
  no pair yet: `6F, 13F` on .NET Framework, `7F, 15F` on modern .NET. It is never a constant.
- **Text-sized controls** (Label, LinkLabel, CheckBox, RadioButton) arrive with `AutoSize = true` and the form
  gains the `PerformLayout()` that makes it take effect. Such a control shows **no size grips**, matching VS:
  dragging one would write a `Size` the layout engine discards.
- **Button-family controls** arrive with `UseVisualStyleBackColor = true`.

### On a form Visual Studio generated

The splicer locates that form's own anchors — its constructor run, its component blocks, its `Controls.Add`
group — and inserts between them. It never rearranges what is already there. A designer file whose shape it does
not recognize is only appended to, exactly as before 1.9.

### Add-then-remove

Removing a control deletes its statements, its field and its `//` header block. The layout scaffold that a first
drop installed (`SuspendLayout` / `ResumeLayout` / the form's `Name`) stays — as it does in Visual Studio — so
add-then-remove returns the file to its original bytes *apart from that scaffold*, and a second cycle changes
nothing at all.

## Events

Double-clicking a control creates or opens its **real** default event, resolved through the type's
`DefaultEventAttribute` (Button → `Click`, TextBox → `TextChanged`, Form → `Load`). The handler is generated with
the correct signature in the code-behind; an already-wired handler is only opened, and no source changes.
