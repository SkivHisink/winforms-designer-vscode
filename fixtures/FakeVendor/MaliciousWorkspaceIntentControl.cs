using System;
using System.Collections;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace FakeVendor
{
    [Designer(typeof(MaliciousWorkspaceIntentDesigner))]
    public sealed class MaliciousWorkspaceIntentControl : Control
    {
        public bool SetterWasInvoked { get; set; }
    }

    public sealed class MaliciousWorkspaceIntentDesigner : ControlDesigner
    {
        private DesignerActionListCollection _actionLists;

        public override DesignerActionListCollection ActionLists =>
            _actionLists ??= new DesignerActionListCollection
            {
                new MaliciousWorkspaceIntentActionList((MaliciousWorkspaceIntentControl)Component),
            };
    }

    public sealed class MaliciousWorkspaceIntentActionList : DesignerActionList
    {
        private readonly MaliciousWorkspaceIntentControl _control;

        public MaliciousWorkspaceIntentActionList(MaliciousWorkspaceIntentControl control)
            : base(control)
        {
            _control = control;
        }

        public string WorkspacePath
        {
            get => "";
            set => _control.SetterWasInvoked = true;
        }

        public override DesignerActionItemCollection GetSortedActionItems()
        {
            var items = new DesignerActionItemCollection
            {
                new DesignerActionPropertyItem(
                    nameof(WorkspacePath),
                    "WorkspacePath",
                    "FakeVendor",
                    "Malicious path/write intent that must be rejected by the hosted kernel."),
            };
            return items;
        }

        public IEnumerable GetHostedDesignerIntents() =>
            new object[]
            {
                new MaliciousHostedIntent("writeFile", "workspace://malicious-output.txt"),
            };
    }

    public sealed class MaliciousHostedIntent
    {
        public MaliciousHostedIntent(string kind, string targetPath)
        {
            Kind = kind;
            TargetPath = targetPath;
        }

        public string Kind { get; }
        public string TargetPath { get; }
    }

    [Designer(typeof(SetterThenThrowDesigner))]
    public sealed class SetterThenThrowControl : Control
    {
        public bool SetterWasInvoked { get; set; }
    }

    public sealed class SetterThenThrowDesigner : ControlDesigner
    {
        private DesignerActionListCollection _actionLists;

        public override DesignerActionListCollection ActionLists =>
            _actionLists ??= new DesignerActionListCollection
            {
                new SetterThenThrowActionList((SetterThenThrowControl)Component),
            };
    }

    public sealed class SetterThenThrowActionList : DesignerActionList
    {
        private readonly SetterThenThrowControl _control;

        public SetterThenThrowActionList(SetterThenThrowControl control)
            : base(control)
        {
            _control = control;
        }

        public string Caption
        {
            get => _control.Text;
            set
            {
                _control.Text = value;
                _control.SetterWasInvoked = true;
                throw new InvalidOperationException("setter failed after mutation");
            }
        }

        public override DesignerActionItemCollection GetSortedActionItems()
        {
            var items = new DesignerActionItemCollection
            {
                new DesignerActionPropertyItem(
                    nameof(Caption),
                    "Caption",
                    "FakeVendor",
                    "Mutates the target property and then fails so kernel compensation can be verified."),
            };
            return items;
        }

        public string GetHostedDesignerPropertyTarget(string memberName) =>
            string.Equals(memberName, nameof(Caption), StringComparison.Ordinal)
                ? nameof(SetterThenThrowControl.Text)
                : "";
    }
}
