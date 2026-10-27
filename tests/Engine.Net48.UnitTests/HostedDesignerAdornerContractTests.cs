using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Forms.Design;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class HostedDesignerAdornerContractTests
    {
        [Fact]
        public void LegacyRectangle_RemainsRenderOnlyWithNoCommandAuthority()
        {
            RunSta(() =>
            {
                using var designer = new ContractDesigner(new LegacyItem());
                DesignerAdornerInfo item = Assert.Single(HostedDesignerAdornerContract.Read(designer));
                Assert.True(item.HitTestable);
                Assert.Equal("", item.CommandId);
                Assert.Equal("", item.KeyboardCommandId);
                Assert.False(item.Enabled);
                Assert.Equal("render_only", item.DisabledReasonCode);
                Assert.False(HostedDesignerAdornerContract.TryGetCommand(designer, item.Id, out string command, out string reason));
                Assert.Equal("", command);
                Assert.Equal("render_only", reason);
                Assert.Equal(0, designer.HitCalls);
            });
        }

        [Fact]
        public void CommandDescriptor_UsesOneStableIdentityForPointerAndKeyboardWithoutInvocation()
        {
            RunSta(() =>
            {
                using var designer = new ContractDesigner(new CommandItem());
                DesignerAdornerInfo item = Assert.Single(HostedDesignerAdornerContract.Read(designer));
                Assert.Equal("sample.caption", item.Id);
                Assert.Equal("sample.apply", item.CommandId);
                Assert.Equal(item.CommandId, item.KeyboardCommandId);
                Assert.True(item.Enabled);
                Assert.Equal("", item.DisabledReasonCode);
                Assert.True(HostedDesignerAdornerContract.TryGetCommand(designer, item.Id, out string command, out string reason));
                Assert.Equal("sample.apply", command);
                Assert.Equal("", reason);
                Assert.Equal(0, designer.HitCalls);
            });
        }

        [Fact]
        public void DisabledCommand_ExposesReasonAndCannotHitOrReturnExecutableIdentity()
        {
            RunSta(() =>
            {
                var item = new CommandItem { Enabled = false, DisabledReasonCode = "selection_read_only" };
                using var designer = new ContractDesigner(item);
                Assert.False(Assert.Single(HostedDesignerAdornerContract.Read(designer)).HitTestable);
                Assert.False(HostedDesignerAdornerContract.ConfirmsHit(designer, item.Id, new Point(2, 2)));
                Assert.False(HostedDesignerAdornerContract.TryGetCommand(designer, item.Id, out string command, out string reason));
                Assert.Equal("", command);
                Assert.Equal("selection_read_only", reason);
                Assert.Equal(0, designer.HitCalls);
            });
        }

        [Fact]
        public void ResolveCommand_RevalidatesCurrentMetadataInsteadOfUsingPublishedEnabledState()
        {
            RunSta(() =>
            {
                var item = new CommandItem();
                using var designer = new ContractDesigner(item);
                Assert.True(HostedDesignerAdornerContract.TryGetCommand(designer, item.Id, out _, out _));
                item.Enabled = false;
                item.DisabledReasonCode = "capability_revoked";
                Assert.False(HostedDesignerAdornerContract.TryGetCommand(designer, item.Id, out _, out string reason));
                Assert.Equal("capability_revoked", reason);
                Assert.Equal(0, designer.HitCalls);
            });
        }

        [Theory]
        [InlineData("other.command", true, "")]
        [InlineData("sample.apply", false, "")]
        [InlineData("sample.apply", true, "unexpected_reason")]
        [InlineData("sample.apply", false, "reason with whitespace")]
        public void IncompleteOrContradictoryCommandMetadata_IsRejected(string keyboard, bool enabled, string reason)
        {
            RunSta(() =>
            {
                using var designer = new ContractDesigner(new CommandItem
                {
                    KeyboardCommandId = keyboard, Enabled = enabled, DisabledReasonCode = reason,
                });
                Assert.Throws<InvalidOperationException>(() => HostedDesignerAdornerContract.Read(designer));
                Assert.Equal(0, designer.HitCalls);
            });
        }

        [Fact]
        public void InvalidIdsAndUnboundedRectangles_AreRejectedBeforeHitCallback()
        {
            RunSta(() =>
            {
                using var unsafeId = new ContractDesigner(new CommandItem { Id = "../write.cs" });
                Assert.Throws<InvalidOperationException>(() => HostedDesignerAdornerContract.Read(unsafeId));
                using var overflow = new ContractDesigner(new CommandItem { Bounds = new Rectangle(int.MaxValue, 0, 5, 5) });
                Assert.Throws<InvalidOperationException>(() => HostedDesignerAdornerContract.Read(overflow));
                using var duplicate = new ContractDesigner(new CommandItem(), new CommandItem());
                Assert.Throws<InvalidOperationException>(() => HostedDesignerAdornerContract.Read(duplicate));
            });
        }

        [Fact]
        public void EnumerationBound_CountsNullEntriesAsWellAsPublishedDescriptors()
        {
            RunSta(() =>
            {
                using var designer = new ContractDesigner(new object[33]);
                Assert.Throws<InvalidOperationException>(() => HostedDesignerAdornerContract.Read(designer));
            });
        }

        public sealed class ContractDesigner : ControlDesigner
        {
            private readonly object[] _items;
            private readonly DesignerServiceKernelSession _session;
            private bool _disposed;
            public int HitCalls { get; private set; }
            public ContractDesigner(params object[] items)
            {
                _items = items;
                _session = DesignerServiceKernel.CreateFormSession();
                try
                {
                    // Framework ControlDesigner.Dispose reads shadow descriptors from its initialized component.
                    // Give this metadata fixture a real headless owner instead of relying on modern disposal of an
                    // uninitialized designer. Its own hit callback and all contract assertions remain unchanged.
                    Initialize(_session.CreateComponent(typeof(Button), "adornerTarget"));
                }
                catch
                {
                    _session.Dispose();
                    throw;
                }
            }
            public IEnumerable<object> GetHostedDesignerAdorners() => _items;
            public bool HitTestHostedDesignerAdorner(string id, Point point) { HitCalls++; return true; }

            protected override void Dispose(bool disposing)
            {
                if (_disposed) return;
                _disposed = true;
                try { base.Dispose(disposing); }
                finally { if (disposing) _session.Dispose(); }
            }
        }

        public class LegacyItem
        {
            public string Id { get; set; } = "sample.caption";
            public string DisplayName { get; set; } = "Caption";
            public Rectangle Bounds { get; set; } = new Rectangle(0, 0, 30, 20);
            public bool HitTestable { get; set; } = true;
        }

        public sealed class CommandItem : LegacyItem
        {
            public string CommandId { get; set; } = "sample.apply";
            public string KeyboardCommandId { get; set; } = "sample.apply";
            public bool Enabled { get; set; } = true;
            public string DisabledReasonCode { get; set; } = "";
        }

        private static void RunSta(Action action)
        {
            Exception? failure = null;
            var thread = new Thread(() => { try { action(); } catch (Exception ex) { failure = ex; } });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            Assert.True(thread.Join(TimeSpan.FromSeconds(5)), "Adorner inspection exceeded its test bound.");
            if (failure != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }
}
