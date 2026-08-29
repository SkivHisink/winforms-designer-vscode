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

        [Fact]
        public void V2_FND_001_S043_SlowStandardValuesConverter_TimesOutWithoutDropdown_OnNet48()
        {
            SlowNet48StandardValuesConverter.ResetProbe();
            using (var component = new SlowNet48StandardValuesComponent())
            {
                var desc = CompiledDescriber.Describe(component, "slow", "slow", false, "this");
                var mode = Assert.Single(desc.Properties, property => property.Name == nameof(SlowNet48StandardValuesComponent.Mode));

                Assert.Equal("Alpha", mode.Value);
                Assert.Null(mode.StandardValues);
                Assert.False(mode.StandardValuesExclusive);
                Assert.Equal("CONVERTER_TIMEOUT", mode.MetadataDiagnosticCode);
            }

            Assert.True(SlowNet48StandardValuesConverter.WaitForProbe(),
                "the abandoned net48 converter probe should finish during the test");

            using (var healthy = new HealthyNet48StandardValuesComponent())
            {
                var desc = CompiledDescriber.Describe(healthy, "healthy", "healthy", false, "this");
                var mode = Assert.Single(desc.Properties, property => property.Name == nameof(HealthyNet48StandardValuesComponent.Mode));
                Assert.Equal(new[] { "Alpha", "Beta" }, mode.StandardValues);
                Assert.Null(mode.MetadataDiagnosticCode);
            }
        }

        // S043 above passes on an idle machine whatever the guard does. It failed on a CI runner because the guard
        // ran converter queries on the THREAD POOL: a stalled converter parks its thread for good, .NET injects
        // replacements slowly, and the next query then spent its whole budget queued — so the property lost its
        // VALUE, not just its dropdown. Pin the property that made that possible, since it is the part a fast
        // developer machine cannot observe.
        [Fact]
        public void ConverterQueries_NeverRunOnAThreadPoolThread_OnNet48()
        {
            ThreadAffinityNet48Converter.RanOnPoolThread = null;
            using (var component = new ThreadAffinityNet48Component())
            {
                CompiledDescriber.Describe(component, "affinity", "affinity", false, "this");
            }

            Assert.False(ThreadAffinityNet48Converter.RanOnPoolThread,
                "a converter query running on a pool thread makes a busy machine drop property values");
        }
    }

    [DefaultEvent(nameof(Activated))]
    internal sealed class DefaultEventComponent : Component
    {
        public event EventHandler? Activated;

        public void RaiseActivated() => Activated?.Invoke(this, EventArgs.Empty);
    }

    internal sealed class SlowNet48StandardValuesComponent : Component
    {
        [DefaultValue("Alpha")]
        [TypeConverter(typeof(SlowNet48StandardValuesConverter))]
        public string Mode { get; set; } = "Alpha";
    }

    internal sealed class HealthyNet48StandardValuesComponent : Component
    {
        [DefaultValue("Alpha")]
        [TypeConverter(typeof(HealthyNet48StandardValuesConverter))]
        public string Mode { get; set; } = "Alpha";
    }

    internal sealed class SlowNet48StandardValuesConverter : StringConverter
    {
        private static readonly System.Threading.ManualResetEventSlim ProbeFinished =
            new System.Threading.ManualResetEventSlim(true);

        public static void ResetProbe() => ProbeFinished.Reset();

        public static bool WaitForProbe() => ProbeFinished.Wait(TimeSpan.FromSeconds(2));

        public override bool GetStandardValuesSupported(ITypeDescriptorContext context)
        {
            try
            {
                System.Threading.Thread.Sleep(TimeSpan.FromMilliseconds(300));
                return true;
            }
            finally
            {
                ProbeFinished.Set();
            }
        }

        public override StandardValuesCollection GetStandardValues(ITypeDescriptorContext context) =>
            new StandardValuesCollection(new[] { "Alpha", "Beta" });
    }

    internal sealed class ThreadAffinityNet48Component : Component
    {
        [DefaultValue("Alpha")]
        [TypeConverter(typeof(ThreadAffinityNet48Converter))]
        public string Mode { get; set; } = "Alpha";
    }

    internal sealed class ThreadAffinityNet48Converter : StringConverter
    {
        // null until the converter is asked anything — Assert.False then fails, which is the honest outcome.
        internal static bool? RanOnPoolThread;

        public override bool GetStandardValuesSupported(ITypeDescriptorContext context)
        {
            RanOnPoolThread = System.Threading.Thread.CurrentThread.IsThreadPoolThread;
            return false;
        }
    }

    internal sealed class HealthyNet48StandardValuesConverter : StringConverter
    {
        public override bool GetStandardValuesSupported(ITypeDescriptorContext context) => true;

        public override bool GetStandardValuesExclusive(ITypeDescriptorContext context) => true;

        public override StandardValuesCollection GetStandardValues(ITypeDescriptorContext context) =>
            new StandardValuesCollection(new[] { "Alpha", "Beta" });
    }
}
