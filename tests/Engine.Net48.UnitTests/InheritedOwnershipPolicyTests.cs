using System;
using WinFormsDesigner.Engine.Net48;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class InheritedOwnershipPolicyTests
    {
        private class BaseFormIdentity { }
        private sealed class DerivedFormIdentity : BaseFormIdentity { }
        private sealed class UnrelatedIdentity { }

        [Fact]
        public void FromDeclaration_DistinguishesCurrentInheritedAndUnresolved()
        {
            Assert.Equal(InheritedOwnershipPolicy.CurrentSource,
                InheritedOwnershipPolicy.FromDeclaration(typeof(DerivedFormIdentity), typeof(DerivedFormIdentity)));
            Assert.Equal(InheritedOwnershipPolicy.Inherited,
                InheritedOwnershipPolicy.FromDeclaration(typeof(DerivedFormIdentity), typeof(BaseFormIdentity)));
            Assert.Equal(InheritedOwnershipPolicy.Unresolved,
                InheritedOwnershipPolicy.FromDeclaration(typeof(DerivedFormIdentity), typeof(UnrelatedIdentity)));
            Assert.Equal(InheritedOwnershipPolicy.Unresolved,
                InheritedOwnershipPolicy.FromDeclaration(typeof(DerivedFormIdentity), null));
        }

        [Theory]
        [InlineData(InheritedOwnershipPolicy.Root, true)]
        [InlineData(InheritedOwnershipPolicy.CurrentSource, true)]
        [InlineData(InheritedOwnershipPolicy.Inherited, false)]
        [InlineData(InheritedOwnershipPolicy.Unresolved, false)]
        [InlineData("futureValue", false)]
        [InlineData(null, false)]
        public void IsEditable_FailsClosedOutsideRootAndCurrentSource(string ownership, bool expected)
        {
            Assert.Equal(expected, InheritedOwnershipPolicy.IsEditable(ownership));
        }

        [Fact]
        public void NewOwnershipDtos_DefaultToUnresolvedAndReadOnly()
        {
            AssertReadOnly(new LayoutControl().Ownership, new LayoutControl().Editable, new LayoutControl().ReadOnlyReason);
            AssertReadOnly(new ComponentDesc().Ownership, new ComponentDesc().Editable, new ComponentDesc().ReadOnlyReason);
            AssertReadOnly(new TrayComponent().Ownership, new TrayComponent().Editable, new TrayComponent().ReadOnlyReason);
            AssertReadOnly(new ToolStripItemBounds().Ownership, new ToolStripItemBounds().Editable, new ToolStripItemBounds().ReadOnlyReason);
        }

        [Fact]
        public void ReadOnlyReason_IsEmptyOnlyForEditableOwnership()
        {
            Assert.Equal("", InheritedOwnershipPolicy.ReadOnlyReason(InheritedOwnershipPolicy.Root));
            Assert.Equal("", InheritedOwnershipPolicy.ReadOnlyReason(InheritedOwnershipPolicy.CurrentSource));
            Assert.Contains("base type", InheritedOwnershipPolicy.ReadOnlyReason(InheritedOwnershipPolicy.Inherited));
            Assert.Contains("could not be proven", InheritedOwnershipPolicy.ReadOnlyReason(InheritedOwnershipPolicy.Unresolved));
        }

        [Fact]
        public void EditorMetadataDtos_DefaultToNoAdvertisedRoute()
        {
            var property = new PropertyDesc();
            Assert.False(property.GenericCollection);
            Assert.Null(property.UiTypeEditor);
            Assert.Null(property.Properties);
            Assert.False(property.PropertiesTruncated);

            var child = new ExpandablePropertyDesc();
            Assert.True(child.ReadOnly);
            Assert.False(child.SourceEditable);
            Assert.Null(child.Properties);
            Assert.False(child.PropertiesTruncated);
        }

        private static void AssertReadOnly(string ownership, bool editable, string reason)
        {
            Assert.Equal(InheritedOwnershipPolicy.Unresolved, ownership);
            Assert.False(editable);
            Assert.False(string.IsNullOrWhiteSpace(reason));
        }
    }
}
