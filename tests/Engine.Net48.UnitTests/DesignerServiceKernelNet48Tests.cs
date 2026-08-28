using System;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Threading;
using System.Windows.Forms;
using FakeVendor;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class DesignerServiceKernelNet48Tests
    {
        [Fact(DisplayName = "V2-FND-001-S091/S092 shared net48 kernel cancels reentrancy and refuses unsupported service")]
        [Trait("V2Scenario", "V2-FND-001-S091")]
        [Trait("V2Scenario", "V2-FND-001-S092")]
        public void SharedKernel_CancelsNestedTransactionAndRecordsUnsupportedService()
        {
            Exception? error = null;
            var thread = new Thread(() =>
            {
                try
                {
                    using (var component = new HostedServiceControl
                    {
                        Text = "Before service action",
                        Size = new System.Drawing.Size(100, 30),
                    })
                    using (var session = DesignerServiceKernel.CreateHostedSession(
                        component,
                        "hostedServiceControl1",
                        designerCreator: (target, baseType) =>
                            System.ComponentModel.TypeDescriptor.CreateDesigner(target, baseType)))
                    {
                        var designer = Assert.IsType<HostedServiceControlDesigner>(session.Host.GetDesigner(component));
                        Assert.True(designer.CompleteHostObserved);
                        Assert.True(designer.UnsupportedServiceObserved);
                        Assert.Null(component.Site?.GetService(typeof(IDesignerSerializationService)));
                        Assert.True(session.TryGetServiceRefusal(
                            typeof(IDesignerSerializationService), out var unsupported));
                        Assert.Contains(typeof(IDesignerSerializationService).FullName, unsupported.Reason);

                        var action = Assert.IsType<HostedServiceControlActionList>(designer.ActionLists[0]);
                        int opened = 0;
                        int committed = 0;
                        int cancelled = 0;
                        session.Host.TransactionOpened += (_, __) => opened++;
                        session.Host.TransactionClosed += (_, args) =>
                        {
                            if (args.TransactionCommitted) committed++;
                            else cancelled++;
                        };

                        action.CancelReentrantServiceAction();

                        Assert.False(session.Host.InTransaction);
                        Assert.Equal(1, opened);
                        Assert.Equal(0, committed);
                        Assert.Equal(1, cancelled);
                        Assert.Equal("Before service action", component.Text);
                        Assert.Equal(new System.Drawing.Size(100, 30), component.Size);
                        Assert.True(session.TryGetServiceRefusal(typeof(DesignerTransaction), out var reentrant));
                        Assert.Contains("Nested designer transactions", reentrant.Reason);
                    }
                }
                catch (Exception ex) { error = ex; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (error != null) throw error;
        }
    }
}
