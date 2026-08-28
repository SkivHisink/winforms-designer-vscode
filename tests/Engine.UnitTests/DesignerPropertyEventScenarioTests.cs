using WinFormsDesigner.Engine;
using System.Threading;

namespace Engine.UnitTests;

[Collection("Modern inherited designer STA")]
public sealed class DesignerPropertyEventScenarioTests
{
    private const string DesignerPath = "Form1.Designer.cs";

    private const string ButtonDesigner = """
        namespace Product.Ui;

        public partial class Form1 : System.Windows.Forms.Form
        {
            private System.Windows.Forms.Button button1;

            private void InitializeComponent()
            {
                this.button1 = new System.Windows.Forms.Button();
                this.button1.Name = "button1";
                this.button1.Padding = new System.Windows.Forms.Padding(3, 4, 5, 6);
                this.Controls.Add(this.button1);
            }
        }
        """;

    private const string ButtonCode = """
        namespace Product.Ui;

        public partial class Form1 : System.Windows.Forms.Form
        {
        }
        """;

    [Fact]
    public void V2_FND_001_S042_PaddingEditChangesOnlyTheTargetAssignment()
    {
        var result = DesignerRenderer.ApplyPropertyEdit(
            DesignerPath,
            "button1",
            "Padding",
            "new System.Windows.Forms.Padding(8, 4, 5, 6)",
            ButtonDesigner);

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.NewText);
        Assert.Contains("this.button1.Padding = new System.Windows.Forms.Padding(8, 4, 5, 6);", result.NewText);
        Assert.Contains("this.button1.Name = \"button1\";", result.NewText);
        Assert.Contains("this.Controls.Add(this.button1);", result.NewText);
        Assert.DoesNotContain("new System.Windows.Forms.Padding(3, 4, 5, 6)", result.NewText);
    }

    [Fact]
    public void V2_FND_001_S049_GenerateDefaultClickHandlerUpdatesDesignerAndCodeBehindTogether()
    {
        var result = RunSta(() => DesignerRenderer.GenerateEventHandler(
            DesignerPath,
            "button1",
            "Click",
            handlerName: null,
            designerSourceText: ButtonDesigner,
            codeText: ButtonCode));

        Assert.True(result.Safe, result.Reason);
        Assert.False(result.AlreadyWired);
        Assert.Equal("button1_Click", result.HandlerName);
        Assert.NotNull(result.DesignerText);
        Assert.NotNull(result.CodeText);
        Assert.NotNull(result.CodeInsertText);
        Assert.True(result.CodeInsertOffset >= 0);
        Assert.Contains("this.button1.Click += new System.EventHandler(this.button1_Click);", result.DesignerText);
        Assert.Contains("private void button1_Click(object sender, System.EventArgs e)", result.CodeText);
    }

    [Fact]
    public void V2_FND_001_S050_SelectingExistingHandlerKeepsASingleSubscription()
    {
        const string wiredDesigner = """
            namespace Product.Ui;

            public partial class Form1 : System.Windows.Forms.Form
            {
                private System.Windows.Forms.Button button1;

                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Name = "button1";
                    this.button1.Click += new System.EventHandler(this.button1_Click);
                    this.Controls.Add(this.button1);
                }
            }
            """;
        const string code = """
            namespace Product.Ui;

            public partial class Form1 : System.Windows.Forms.Form
            {
                private void button1_Click(object sender, System.EventArgs e)
                {
                }
            }
            """;

        var result = RunSta(() => DesignerRenderer.SetEventWiring(
            DesignerPath,
            "button1",
            "Click",
            "button1_Click",
            wiredDesigner,
            code));

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.DesignerText);
        Assert.Equal(1, Count(result.DesignerText, "this.button1.Click +="));
        Assert.Equal(1, Count(result.DesignerText, "this.button1_Click"));
    }

    [Fact]
    public void V2_FND_001_S051_RewireToRenamedExistingHandlerRequiresMatchingCodeBehindSnapshot()
    {
        const string wiredDesigner = """
            namespace Product.Ui;

            public partial class Form1 : System.Windows.Forms.Form
            {
                private System.Windows.Forms.TextBox textBox1;

                private void InitializeComponent()
                {
                    this.textBox1 = new System.Windows.Forms.TextBox();
                    this.textBox1.Name = "textBox1";
                    this.textBox1.TextChanged += new System.EventHandler(this.textBox1_TextChanged);
                    this.Controls.Add(this.textBox1);
                }
            }
            """;
        const string codeWithRenamedHandler = """
            namespace Product.Ui;

            public partial class Form1 : System.Windows.Forms.Form
            {
                private void textBox1_TextChanged_Renamed(object sender, System.EventArgs e)
                {
                }
            }
            """;

        var result = RunSta(() => DesignerRenderer.SetEventWiring(
            DesignerPath,
            "textBox1",
            "TextChanged",
            "textBox1_TextChanged_Renamed",
            wiredDesigner,
            codeWithRenamedHandler));

        Assert.True(result.Safe, result.Reason);
        Assert.NotNull(result.DesignerText);
        Assert.Contains("this.textBox1.TextChanged += new System.EventHandler(this.textBox1_TextChanged_Renamed);", result.DesignerText);
        Assert.DoesNotContain("this.textBox1.TextChanged += new System.EventHandler(this.textBox1_TextChanged);", result.DesignerText);
    }

    [Fact]
    public void V2_FND_001_S052_StaleCodeBehindSnapshotRefusesBeforeDesignerMutation()
    {
        var result = RunSta(() => DesignerRenderer.SetEventWiring(
            DesignerPath,
            "button1",
            "Click",
            "button1_Click",
            ButtonDesigner,
            ButtonCode));

        Assert.False(result.Safe);
        Assert.Null(result.DesignerText);
        Assert.Contains("handler method not found", result.Reason);
    }

    [Fact]
    public void ProjectWidePartialHandlers_AreListedWiredAndNotDuplicatedInPrimaryCodeBehind()
    {
        const string projectPartial = """
            namespace Product.Ui;

            public partial class Form1
            {
                private void ProjectWideClick(object sender, System.EventArgs e)
                {
                }
            }
            """;

        var candidates = RunSta(() => DesignerRenderer.ListHandlerCandidates(
            DesignerPath,
            "button1",
            ButtonDesigner,
            ButtonCode,
            projectCodeTexts: new[] { projectPartial }));
        var click = Assert.Single(candidates, candidate => candidate.Event == "Click");
        Assert.Contains("ProjectWideClick", click.Handlers);

        var wired = RunSta(() => DesignerRenderer.SetEventWiring(
            DesignerPath,
            "button1",
            "Click",
            "ProjectWideClick",
            ButtonDesigner,
            ButtonCode,
            projectCodeTexts: new[] { projectPartial }));
        Assert.True(wired.Safe, wired.Reason);
        Assert.Contains("this.button1.Click += new System.EventHandler(this.ProjectWideClick);", wired.DesignerText);

        var generated = RunSta(() => DesignerRenderer.GenerateEventHandler(
            DesignerPath,
            "button1",
            "Click",
            "ProjectWideClick",
            ButtonDesigner,
            ButtonCode,
            projectCodeTexts: new[] { projectPartial }));
        Assert.True(generated.Safe, generated.Reason);
        Assert.False(generated.StubCreated);
        Assert.Null(generated.CodeText);
        Assert.Null(generated.CodeInsertText);
        Assert.Contains("this.button1.Click += new System.EventHandler(this.ProjectWideClick);", generated.DesignerText);
    }

    [Fact]
    public void ProjectWidePartialHandler_WithWrongSignature_IsRefused()
    {
        const string wrongPartial = """
            namespace Product.Ui;
            public partial class Form1
            {
                private void ProjectWideClick(string wrong) { }
            }
            """;

        var result = RunSta(() => DesignerRenderer.GenerateEventHandler(
            DesignerPath,
            "button1",
            "Click",
            "ProjectWideClick",
            ButtonDesigner,
            ButtonCode,
            projectCodeTexts: new[] { wrongPartial }));

        Assert.False(result.Safe);
        Assert.Contains("does not match", result.Reason);
        Assert.Null(result.DesignerText);
        Assert.Null(result.CodeText);
    }

    [Fact]
    public void SplitterPanelSyntheticSelection_CreatesAndReadsExactEventPath()
    {
        string designerPath = RepoFile("engine", "samples", "SplitterForm.Designer.cs");
        string designerSource = File.ReadAllText(designerPath);
        string code = File.ReadAllText(RepoFile("engine", "samples", "SplitterForm.cs"));

        var generated = RunSta(() => DesignerRenderer.GenerateEventHandler(
            designerPath,
            "splitContainer1.Panel2",
            "Click",
            handlerName: null,
            designerSourceText: designerSource,
            codeText: code));

        Assert.True(generated.Safe, generated.Reason);
        Assert.Equal("splitContainer1_Panel2_Click", generated.HandlerName);
        Assert.Contains(
            "this.splitContainer1.Panel2.Click += new System.EventHandler(this.splitContainer1_Panel2_Click);",
            generated.DesignerText);
        var described = RunSta(() => DesignerRenderer.DescribeComponent(
            designerPath, "splitContainer1.Panel2", sourceText: generated.DesignerText));
        Assert.Equal("splitContainer1_Panel2_Click", Assert.Single(
            described!.Events, item => item.Name == "Click").Handler);
    }

    private static int Count(string text, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }

    private static string RepoFile(params string[] segments)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            string candidate = segments.Aggregate(directory.FullName, Path.Combine);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("repository file not found: " + Path.Combine(segments));
    }

    private static T RunSta<T>(Func<T> action)
    {
        T? result = default;
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try { result = action(); }
            catch (Exception ex) { error = ex; }
        })
        {
            IsBackground = true,
            Name = "Engine.UnitTests.PropertyEventScenario.STA",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(TimeSpan.FromSeconds(10)))
            throw new TimeoutException("The STA renderer operation did not finish.");
        if (error != null) throw error;
        return result!;
    }
}
