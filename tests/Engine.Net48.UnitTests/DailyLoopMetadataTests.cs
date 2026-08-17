using System;
using System.ComponentModel;
using WinFormsDesigner.Engine.Net48;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class DailyLoopMetadataTests
    {
        [Fact]
        public void CompiledDescribe_UsesTheRealDefaultEventAttribute()
        {
            using (var component = new DefaultEventComponent())
            {
                var desc = CompiledDescriber.Describe(component, "button1", "button1", false, "this");

                Assert.Equal(nameof(DefaultEventComponent.Activated), desc.DefaultEvent);
                Assert.Contains(desc.Events, e => e.Name == nameof(DefaultEventComponent.Activated));
            }
        }

        [Fact]
        public void SourceMetadata_InjectsEditableDesignNameForAField()
        {
            const string source = @"
partial class Form1
{
    private System.ComponentModel.Component button1, button2;
    private void InitializeComponent()
    {
        this.button1 = new System.ComponentModel.Component();
    }
}";
            var desc = new ComponentDesc
            {
                Id = "button1",
                Name = "button1",
                Type = typeof(Component).FullName,
                IsRoot = false,
            };

            SourceMetadata.Apply(desc, null, source);

            var designName = Assert.Single(desc.Properties, p => p.Name == "(Name)");
            Assert.Equal("button1", designName.Value);
            Assert.Equal("Design", designName.Category);
            Assert.True(designName.DesignTime);
            Assert.False(designName.ReadOnly);
        }
    }

    [DefaultEvent(nameof(Activated))]
    internal sealed class DefaultEventComponent : Component
    {
        public event EventHandler? Activated;

        public void RaiseActivated() => Activated?.Invoke(this, EventArgs.Empty);
    }
}
