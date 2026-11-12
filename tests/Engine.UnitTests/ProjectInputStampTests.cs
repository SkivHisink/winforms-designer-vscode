using System;
using System.IO;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// A selection's kept graph is reused only while ProjectInputStamp is unchanged, so the stamp must change with every
// project file a load may read: a source added anywhere (its global usings bind the form's type names), a source or
// resource edited, a Directory.Build file appearing above the project.
public sealed class ProjectInputStampTests
{
    [Fact]
    public void TheStamp_ChangesWithEveryProjectFileALoadMayRead()
    {
        string outer = Path.Combine(Path.GetTempPath(), "wfd-stamp-" + Guid.NewGuid().ToString("N"));
        string project = Path.Combine(outer, "Demo");
        Directory.CreateDirectory(Path.Combine(project, "Forms", "Deep"));
        try
        {
            File.WriteAllText(Path.Combine(project, "Demo.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />");
            File.WriteAllText(Path.Combine(project, "Forms", "Form1.cs"), "namespace Demo;");
            string first = Stamp(project);
            Assert.Equal(first, Stamp(project));

            File.WriteAllText(Path.Combine(project, "Forms", "Deep", "Usings.cs"), "global using System.Drawing;");
            string added = Stamp(project);
            Assert.NotEqual(first, added);

            string usings = Path.Combine(project, "Forms", "Deep", "Usings.cs");
            File.WriteAllText(usings, "global using System.Windows.Forms;");
            File.SetLastWriteTimeUtc(usings, DateTime.UtcNow.AddMinutes(1));
            string edited = Stamp(project);
            Assert.NotEqual(added, edited);

            File.WriteAllText(Path.Combine(outer, "Directory.Build.props"), "<Project />");
            Assert.NotEqual(edited, Stamp(project));
        }
        finally { try { Directory.Delete(outer, true); } catch { } }
    }

    [Fact]
    public void ARecordedRead_LooksAtNothingTheReadIsRefused_OutsideTheProjectOrBeneathALink()
    {
        string outer = Path.Combine(Path.GetTempPath(), "wfd-stamp-" + Guid.NewGuid().ToString("N"));
        string project = Path.Combine(outer, "Demo");
        string elsewhere = Path.Combine(outer, "Elsewhere");
        Directory.CreateDirectory(project);
        Directory.CreateDirectory(elsewhere);
        try
        {
            string outsideFile = Path.Combine(outer, "outside.png");
            File.WriteAllText(outsideFile, "a");
            File.WriteAllText(Path.Combine(elsewhere, "linked.png"), "a");
            Directory.CreateSymbolicLink(Path.Combine(project, "Linked"), elsewhere);

            string outsidePath = Path.Combine(project, "..", "outside.png");
            string linkedPath = Path.Combine(project, "Linked", "linked.png");
            Assert.Null(ProjectResourceResolver.ReadFileInside(project, outsidePath, 1024, out string outsideState));
            Assert.Null(ProjectResourceResolver.ReadFileInside(project, linkedPath, 1024, out string linkedState));
            Assert.Equal("outside", outsideState);
            Assert.StartsWith("link|", linkedState);
            var outsideRead = new ProjectFileRead(project, outsidePath, outsideState);
            var linkedRead = new ProjectFileRead(project, linkedPath, linkedState);

            // what lies outside or beneath the link is not part of the state, so changing it changes nothing
            File.WriteAllText(outsideFile, "a longer file");
            File.WriteAllText(Path.Combine(elsewhere, "linked.png"), "a longer file");
            Assert.True(outsideRead.Matches());
            Assert.True(linkedRead.Matches());

            // the link replaced by a real folder is a different outcome
            Directory.Delete(Path.Combine(project, "Linked"));
            Directory.CreateDirectory(Path.Combine(project, "Linked"));
            File.WriteAllText(Path.Combine(project, "Linked", "linked.png"), "inside");
            Assert.False(linkedRead.Matches());
        }
        catch (UnauthorizedAccessException) { /* symbolic links need the privilege; nothing to check without them */ }
        catch (IOException ex) when (ex.HResult == unchecked((int)0x80070522)) { /* ERROR_PRIVILEGE_NOT_HELD */ }
        finally { try { Directory.Delete(outer, true); } catch { } }
    }

    private static string Stamp(string project)
    {
        string? stamp = ProjectResourceResolver.ProjectInputStamp(project);
        Assert.NotNull(stamp);
        return stamp!;
    }
}
