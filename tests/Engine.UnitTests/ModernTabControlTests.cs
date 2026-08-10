using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

[CollectionDefinition("Modern tab designer STA", DisableParallelization = true)]
public sealed class ModernTabDesignerStaCollection { }

[Collection("Modern tab designer STA")]
public sealed class ModernTabControlTests
{
    private static readonly StaDispatcher Sta = new();

    [Fact]
    public void RenderWithLayout_EmitsHostAndAppliesOnlyValidSelectedPageMembership()
    {
        var file = Sample("TabForm.Designer.cs");
        var source = File.ReadAllText(file);

        var baseline = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, sourceText: source));
        var host = Assert.Single(baseline.Controls, c => c.Id == "tabControl1");
        Assert.True(host.IsTabHost);
        Assert.Contains(baseline.Controls, c => c.Id == "pageButton1");
        Assert.DoesNotContain(baseline.Controls, c => c.Id == "pageLabel2");

        var page2 = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            file, sourceText: source, selectedTabs: new[] { "tabControl1=tabPage2" }));
        Assert.Contains(page2.Controls, c => c.Id == "tabPage2" && c.ParentId == "tabControl1");
        Assert.Contains(page2.Controls, c => c.Id == "pageLabel2");
        Assert.DoesNotContain(page2.Controls, c => c.Id == "pageButton1");

        foreach (var invalid in new[] {
            "tabControl1=noSuchPage",
            "tabControl1=pageButton1",
            "noSuchHost=tabPage2",
            "tabControl1=tabPage2=extra",
        })
        {
            var result = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
                file, sourceText: source, selectedTabs: new[] { invalid }));
            Assert.Contains(result.Controls, c => c.Id == "pageButton1");
            Assert.DoesNotContain(result.Controls, c => c.Id == "pageLabel2");
        }
    }

    [Fact]
    public void HitTestTab_UsesActualHeadersAndFailsClosedEverywhereElse()
    {
        var file = Sample("TabForm.Designer.cs");
        var source = File.ReadAllText(file);
        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(file, sourceText: source));
        var host = Assert.Single(layout.Controls, c => c.Id == "tabControl1");

        var first = Sta.Invoke(() => DesignerRenderer.HitTestTab(
            file, "tabControl1", host.X + 10, host.Y + 10, sourceText: source));
        Assert.Equal("tabPage1", first.PageId);
        Assert.Equal("Page 1", first.Text);

        var second = Sta.Invoke(() => DesignerRenderer.HitTestTab(
            file, "tabControl1", host.X + 80, host.Y + 10, sourceText: source,
            selectedTabs: new[] { "tabControl1=tabPage2" }));
        Assert.Equal("tabPage2", second.PageId);
        Assert.Equal("Page 2", second.Text);

        Assert.Equal("", Sta.Invoke(() => DesignerRenderer.HitTestTab(
            file, "tabControl1", host.X + 10, host.Y + 100, sourceText: source)).PageId);
        Assert.Equal("", Sta.Invoke(() => DesignerRenderer.HitTestTab(
            file, "pageButton1", host.X + 10, host.Y + 10, sourceText: source)).PageId);
        Assert.Equal("", Sta.Invoke(() => DesignerRenderer.HitTestTab(
            file, "unknown", host.X + 10, host.Y + 10, sourceText: source)).PageId);
    }

    [Fact]
    public void AddedTabPage_IsSelectableOnTheNextSourceRender()
    {
        var file = Sample("TabForm.Designer.cs");
        var source = File.ReadAllText(file);
        var added = DesignerRenderer.AddTabPage(file, "tabControl1", "System.Windows.Forms.TabPage", source);
        Assert.True(added.Safe, added.Reason);
        Assert.NotNull(added.NewText);

        var layout = Sta.Invoke(() => DesignerRenderer.RenderWithLayout(
            file, sourceText: added.NewText, selectedTabs: new[] { $"tabControl1={added.Name}" }));
        Assert.True(layout.Controls.Any(c => c.Id == added.Name && c.ParentId == "tabControl1"),
            $"controls=[{string.Join(",", layout.Controls.Select(c => $"{c.Id}:{c.ParentId}"))}]; "
            + $"unrepresentable=[{string.Join(" | ", layout.Unrepresentable)}]");
    }

    private static string Sample(string name)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "engine", "samples", name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("sample not found: " + name);
    }
}
