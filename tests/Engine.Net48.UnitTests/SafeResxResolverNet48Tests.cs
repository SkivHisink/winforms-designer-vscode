using System;
using System.ComponentModel;
using System.Windows.Forms;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests
{
    /// <summary>The shared .resx resolver on the .NET Framework runtime: the localizable value types are served as
    /// themselves from the text the framework's resource writer writes, a framework name in another assembly is refused,
    /// and GetString of an entry of another type is no string.</summary>
    public sealed class SafeResxResolverNet48Tests
    {
        public static TheoryData<object> LocalizableValues()
        {
            var data = new TheoryData<object>
            {
                'A', ImageLayout.Zoom, Keys.Control | Keys.A, new LinkArea(1, 3), FormStartPosition.CenterScreen,
                TextImageRelation.ImageBeforeText, Orientation.Vertical, ImeMode.Hiragana, ScrollBars.Both,
                HorizontalAlignment.Center, TabAlignment.Bottom, ToolStripItemImageScaling.None,
            };
            // The classic toolbar's types, which only the .NET Framework has.
            foreach (string name in new[] { "System.Windows.Forms.ToolBarAppearance", "System.Windows.Forms.ToolBarTextAlign" })
            {
                var type = typeof(Control).Assembly.GetType(name, throwOnError: true);
                data.Add(Enum.GetValues(type).GetValue(1));
            }
            return data;
        }

        [Theory]
        [MemberData(nameof(LocalizableValues))]
        public void ALocalizableValueType_IsServedAsItself(object expected)
        {
            Type type = expected.GetType();
            string text = TypeDescriptor.GetConverter(type).ConvertToInvariantString(expected);
            string resx = "<root><data name=\"v\" type=\"" + type.FullName + ", " + type.Assembly.GetName().Name + "\"><value>"
                + System.Security.SecurityElement.Escape(text) + "</value></data></root>";

            var r = SafeResxResolver.Parse(resx);
            Assert.Equal(ResourceLookup.Value, r.Lookup("v", false, out var value, out var error));
            Assert.True(error == null, error);
            Assert.Equal(type, value.GetType());
            Assert.Equal(expected, value);
        }

        [Fact]
        public void AFrameworkNameInAnotherAssembly_IsRefused()
        {
            var r = SafeResxResolver.Parse("<root><data name=\"v\" type=\"System.Drawing.Point, identity-probe\"><value>1, 2</value></data></root>");
            Assert.Equal(ResourceLookup.Refused, r.Lookup("v", false, out _, out _));
        }

        [Fact]
        public void GetString_OfAnEntryOfAnotherType_IsNotAString()
        {
            var r = SafeResxResolver.Parse("<root><data name=\"n\" type=\"System.Int32, mscorlib\"><value>5</value></data></root>");
            Assert.Equal(ResourceLookup.NotString, r.Lookup("n", true, out _, out _));
            Assert.Null(r.Resolve("n", true));
            Assert.True(r.HasResource("n"));
        }
    }
}
