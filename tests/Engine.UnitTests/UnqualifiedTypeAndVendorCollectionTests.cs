using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

/// <summary>
/// Three shapes that a REAL project's designer file has and Visual Studio's generator never writes — each of which
/// used to drop the whole form to the compiled fallback, i.e. to constructing the user's actual form and running
/// their constructor, field initializers and Load:
///
///   1. an UNQUALIFIED type name resolved through the file's own `using` / namespace scope;
///   2. a component whose parameterless constructor is NON-PUBLIC (`internal MyControl()`);
///   3. a designer collection that is NOT IList but takes items through a typed `Add`.
///
/// All three were measured on a real DevExpress project before being fixed here.
/// </summary>
public sealed class UnqualifiedTypeAndVendorCollectionTests
{
    // ---------------------------------------------------------------- 1. unqualified type names ------------------

    [Fact]
    public void Builder_CarriesUsingsAndEnclosingNamespaces_InnermostFirst()
    {
        const string source = @"
using System.Windows.Forms;
namespace Product.Ui.Forms {
  using Vendor.Controls;
  partial class F {
    private void InitializeComponent() { }
  }
}";
        var doc = DesignerIrBuilder.Build(source);

        Assert.NotNull(doc);
        // C# order: the enclosing namespace's OWN members first, then the usings written in that scope, then the
        // ancestors it stands for, and only finally the file-level usings. A form's own namespace beating an import
        // is the case that decides WHICH type gets constructed when both declare the same short name.
        Assert.Equal(
            new[] { "Product.Ui.Forms", "Vendor.Controls", "Product.Ui", "Product", "System.Windows.Forms" },
            doc!.NamespaceContext);
        Assert.Null(IrValidate.Check(doc));
    }

    [Fact]
    public void Host_PrefersTheFormsOwnNamespaceOverAnImport_LikeTheCompiler()
    {
        // `namespace App { using Vendor; class Widget… ; new Widget(); }` compiles to App.Widget. The interpreter
        // must not construct Vendor.Widget instead — it would silently render and mutate a different component type.
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""),
            new[] { "Engine.UnitTests.OwnScope", "Engine.UnitTests.ImportedScope" });

        Assert.Equal(typeof(OwnScope.Ambiguous), host.ResolveType("Ambiguous"));
    }

    [Fact]
    public void Builder_SkipsAliasAndStaticUsings_RatherThanHalfResolvingThem()
    {
        const string source = @"
using DX = Vendor.Controls;
using static System.Math;
namespace Product {
  partial class F { private void InitializeComponent() { } }
}";
        var doc = DesignerIrBuilder.Build(source);

        Assert.NotNull(doc);
        Assert.Equal(new[] { "Product" }, doc!.NamespaceContext);
    }

    [Fact]
    public void Builder_HandlesFileScopedNamespaces()
    {
        const string source = @"
namespace Product.Ui.Forms;
using Vendor.Controls;
partial class F { private void InitializeComponent() { } }";
        var doc = DesignerIrBuilder.Build(source);

        Assert.NotNull(doc);
        Assert.Equal(
            new[] { "Product.Ui.Forms", "Vendor.Controls", "Product.Ui", "Product" },
            doc!.NamespaceContext);
    }

    [Fact]
    public void Builder_ComposesNestedNamespaceDeclarations()
    {
        const string source = @"
namespace Product {
  namespace Ui {
    using Vendor.Controls;
    partial class F { private void InitializeComponent() { } }
  }
}";
        var doc = DesignerIrBuilder.Build(source);

        Assert.NotNull(doc);
        // The real namespace is Product.Ui — not just the innermost declaration's own name.
        Assert.Equal(new[] { "Product.Ui", "Vendor.Controls", "Product" }, doc!.NamespaceContext);
    }

    [Fact]
    public void Host_ResolvesUnqualifiedNameThroughTheFilesOwnScope()
    {
        var withContext = new AssemblyIrHost(new[] { typeof(object).Assembly }, new DesignTimeContainer(),
            SafeResxResolver.Parse(""), new[] { "System.Windows.Forms" });
        var withoutContext = new AssemblyIrHost(new[] { typeof(object).Assembly }, new DesignTimeContainer(),
            SafeResxResolver.Parse(""));

        Assert.Equal(typeof(Button), withContext.ResolveType("Button"));
        Assert.Null(withoutContext.ResolveType("Button"));      // exactly the old behaviour without a scope
        Assert.Null(withContext.ResolveType("NoSuchControl"));  // and the scope invents nothing
    }

    [Fact]
    public void Host_PrefersTheFirstNamespaceInScope()
    {
        // Both namespaces really contain a `Timer`; the first candidate must win, as C# binds it.
        var formsFirst = new AssemblyIrHost(new[] { typeof(object).Assembly }, new DesignTimeContainer(),
            SafeResxResolver.Parse(""), new[] { "System.Windows.Forms", "System.Threading" });
        var threadingFirst = new AssemblyIrHost(new[] { typeof(object).Assembly }, new DesignTimeContainer(),
            SafeResxResolver.Parse(""), new[] { "System.Threading", "System.Windows.Forms" });

        Assert.Equal(typeof(System.Windows.Forms.Timer), formsFirst.ResolveType("Timer"));
        Assert.Equal(typeof(System.Threading.Timer), threadingFirst.ResolveType("Timer"));
    }

    [Fact]
    public void Validate_RefusesAForgedNamespaceContext()
    {
        var doc = DesignerIrBuilder.Build("namespace N { partial class F { private void InitializeComponent() { } } }")!;
        doc.NamespaceContext = new List<string> { "not a namespace!" };
        Assert.Equal("invalid namespace candidate", IrValidate.Check(doc));

        doc.NamespaceContext = new List<string>();
        for (int i = 0; i <= IrLimits.MaxNamespaceContext; i++) doc.NamespaceContext.Add("N" + i);
        Assert.Equal("too many namespace candidates", IrValidate.Check(doc));

        doc.NamespaceContext = null!;
        Assert.Equal("NamespaceContext is null", IrValidate.Check(doc));
    }

    // ---------------------------------------------------------------- 2. non-public constructors -----------------

    internal sealed class InternallyConstructedControl : UserControl
    {
        internal InternallyConstructedControl() { }
    }

    /// <summary>All parameters optional — `new OptionalCtorControl()` compiles, so the interpreter must accept it.</summary>
    internal sealed class OptionalCtorControl : UserControl
    {
        internal OptionalCtorControl(int value = 17) { Value = value; }
        public int Value { get; }
    }

    /// <summary>No designer file could write `new PrivateCtorControl()` — the interpreter must not either.</summary>
    internal sealed class PrivateCtorControl : UserControl
    {
        private PrivateCtorControl() { }
    }

    [Fact]
    public void Host_ConstructsAComponentWhoseConstructorIsNotPublic()
    {
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));

        var instance = host.CreateComponent(typeof(InternallyConstructedControl), "control1", withContainer: false);

        Assert.IsType<InternallyConstructedControl>(instance);
        // …and it is SITED, which is what makes DesignMode true for the replayed graph.
        Assert.True(((IComponent)instance).Site?.DesignMode);
    }

    [Fact]
    public void Host_ConstructsThroughAnAllOptionalConstructor_AsTheCompilerWould()
    {
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));

        var instance = host.CreateComponent(typeof(OptionalCtorControl), "control1", withContainer: false);

        Assert.Equal(17, Assert.IsType<OptionalCtorControl>(instance).Value); // the author's own default
    }

    [Fact]
    public void Host_RefusesAConstructorTheDesignerSourceCouldNotCall()
    {
        // Accessibility is the boundary: internal is callable from the designer partial, private is not — and the
        // interpreter must never construct what the source it replays could not.
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));

        Assert.Throws<MissingMethodException>(
            () => host.CreateComponent(typeof(PrivateCtorControl), "control1", withContainer: false));
    }

    [Fact]
    public void Host_RefusesAnInternalConstructorFromAnotherAssembly()
    {
        // `internal` is only callable inside its OWN assembly. A host that does not know that assembly must refuse.
        var foreignHost = new AssemblyIrHost(new[] { typeof(Control).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));

        Assert.Throws<MissingMethodException>(
            () => foreignHost.CreateComponent(typeof(InternallyConstructedControl), "control1", withContainer: false));
    }

    // ---------------------------------------------------------------- 3. non-IList vendor collections ------------

    /// <summary>A vendor-shaped collection: ICollection + a TYPED Add, and NO IList — measured shape of
    /// PGMUI/DevExpress's TreeListColumnCollection. The no-argument Add() overload is present on purpose: it CREATES
    /// an element in the real vendor type, so choosing it would silently add the wrong thing.</summary>
    public sealed class VendorItemCollection : ICollection, IEnumerable<Control>
    {
        public readonly List<Control> Items = new();
        public int Add(Control item) { Items.Add(item); return Items.Count - 1; }
        public Control Add() { var c = new Label(); Items.Add(c); return c; }
        public IEnumerator<Control> GetEnumerator() => Items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => Items.GetEnumerator();
        public void CopyTo(Array array, int index) => ((ICollection)Items).CopyTo(array, index);
        public int Count => Items.Count;
        public bool IsSynchronized => false;
        public object SyncRoot => this;
    }

    public sealed class HostWithVendorCollection : UserControl
    {
        public VendorItemCollection Columns { get; } = new();
    }

    [Fact]
    public void Executor_AddsToAVendorCollectionThatIsNotAnIList()
    {
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly, typeof(Control).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));
        var doc = new IrDocument
        {
            DesignedTypeName = "Engine.UnitTests.Fake",
            Statements =
            {
                new IrConstructComponent { Name = "hostCtl", TypeName = typeof(HostWithVendorCollection).FullName! },
                new IrConstructComponent { Name = "col1", TypeName = typeof(Button).FullName! },
                new IrAddCollectionItem
                {
                    TargetName = "hostCtl",
                    PropertyPath = { "Columns" },
                    Item = new IrComponentRef { Name = "col1" },
                },
            },
            TotalSourceStatements = 3,
            RepresentedStatements = 3,
        };
        Assert.Null(IrValidate.Check(doc));

        var result = DesignerIrExecutor.Execute(doc, new UserControl(), host);

        Assert.True(result.Ok, result.FailureReason);
        var owner = Assert.IsType<HostWithVendorCollection>(result.Instances["hostCtl"]);
        Assert.Single(owner.Columns.Items);
        Assert.Same(result.Instances["col1"], owner.Columns.Items[0]); // the ITEM, not one the collection created
    }

    [Fact]
    public void Executor_PicksTheMostSpecificAddOverload_LikeTheCompiler()
    {
        var host = new AssemblyIrHost(new[] { typeof(UnqualifiedTypeAndVendorCollectionTests).Assembly, typeof(Control).Assembly },
            new DesignTimeContainer(), SafeResxResolver.Parse(""));
        var doc = new IrDocument
        {
            DesignedTypeName = "Engine.UnitTests.Fake",
            Statements =
            {
                new IrConstructComponent { Name = "hostCtl", TypeName = typeof(Overloads.OverloadedAddHost).FullName! },
                new IrConstructComponent { Name = "btn", TypeName = typeof(Button).FullName! },
                new IrAddCollectionItem { TargetName = "hostCtl", PropertyPath = { "Items" }, Item = new IrComponentRef { Name = "btn" } },
            },
            TotalSourceStatements = 3,
            RepresentedStatements = 3,
        };

        var result = DesignerIrExecutor.Execute(doc, new UserControl(), host);

        Assert.True(result.Ok, result.FailureReason);
        var owner = Assert.IsType<Overloads.OverloadedAddHost>(result.Instances["hostCtl"]);
        Assert.Equal("Control", owner.Items.LastOverload); // not the object-typed overload
    }
}
