using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class ValueConverterTests
{
    [Theory]
    [InlineData("System.Drawing.Point", "12, 34", "Point")]
    [InlineData("System.Drawing.Size", "640, 480", "Size")]
    [InlineData("System.Drawing.Rectangle", "1, 2, 30, 40", "Rectangle")]
    [InlineData("System.Windows.Forms.Padding", "1, 2, 3, 4", "Padding")]
    [InlineData("System.Drawing.Color", "Red", "Color.Red")]
    public void ToExpression_RepresentableFrameworkValue_EmitsCSharp(string type, string value, string fragment)
    {
        string? expression = DesignerValueConverter.ToExpression(type, value);
        Assert.NotNull(expression);
        Assert.Contains(fragment, expression, StringComparison.Ordinal);
    }

    [Fact]
    public void ToExpression_FontWithInstalledFamily_EmitsFontConstruction()
    {
        string? expression = DesignerValueConverter.ToExpression("System.Drawing.Font", "Arial, 9pt, style=Bold, Italic");
        Assert.NotNull(expression);
        Assert.Contains("Font", expression, StringComparison.Ordinal);
        Assert.Contains("Bold", expression, StringComparison.Ordinal);
        Assert.Contains("Italic", expression, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("System.Drawing.Point", "")]
    [InlineData("System.Drawing.Point", "not-a-point")]
    [InlineData("System.String", "hello")]
    [InlineData("System.Drawing.Font", "__WFD_Font_That_Does_Not_Exist__, 9pt")]
    public void ToExpression_InvalidOrUnsupportedValue_ReturnsNull(string type, string value) =>
        Assert.Null(DesignerValueConverter.ToExpression(type, value));
}
