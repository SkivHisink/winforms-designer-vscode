// Types for SimplifiedDesignerStyleTests: one short name declared in the form's own namespace and in an imported
// one, one declared in two imported namespaces, and one in a nested and in a global-rooted namespace of the same name.
namespace Engine.UnitTests.SimplifiedScope.Own
{
    public sealed class Widget { }
}

namespace Engine.UnitTests.SimplifiedScope.Imported
{
    public sealed class Widget { }
    public sealed class Gadget { }
    public sealed class Twin { }
}

namespace Engine.UnitTests.SimplifiedScope.Other
{
    public sealed class Twin { }
}

namespace Engine.UnitTests.SimplifiedScope.Rel
{
    public sealed class Thing { }
}

namespace Rel
{
    public sealed class Thing { }
}
