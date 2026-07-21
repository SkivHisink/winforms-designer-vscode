using System;
using System.Linq;
using System.Reflection;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // Construct a compiled root the way the author's own code would write `new TheType()`. Extracted
    // shared (compile-linked into both engines) because BOTH the compiled render (most-derived type) and the
    // interpreted render (the immediate BASE type — VS model) need the identical ctor-selection rule.
    //
    // Activator.CreateInstance only finds a PUBLIC zero-argument ctor, which refuses two perfectly constructible
    // shapes: an internal parameterless ctor, and an all-optional ctor (`new T()` compiles, passing the author's
    // declared defaults, but the IL ctor still takes arguments). We never INVENT a value: an optional parameter gets
    // the author's declared default; a REQUIRED parameter is refused (guessing would run their code against a value
    // they never chose). Fewest parameters wins, so a real zero-arg ctor beats an all-optional one.
    // ============================================================================================================
    public static class CompiledRootFactory
    {
        public static object Create(Type type)
        {
            var ctors = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                            .OrderBy(c => c.GetParameters().Length)
                            .ToList();
            foreach (var c in ctors)
            {
                var ps = c.GetParameters();
                if (ps.Length > 0 && !ps.All(p => p.IsOptional)) continue; // needs a real argument → not ours to guess
                object?[] args = ps.Select(DefaultArgFor).ToArray();
                return c.Invoke(args);                                      // a ctor throw surfaces via the caller's unwrap
            }
            string sigs = ctors.Count == 0
                ? "it declares no constructors"
                : "its constructors are: " + string.Join(" | ", ctors.Select(Signature).ToArray());
            throw new MissingMethodException(
                (type.FullName ?? type.Name) + " cannot be constructed with no arguments — " + sigs +
                ". The compiled preview builds the real control, so it needs a constructor callable with no arguments" +
                " (a parameterless one, or one whose parameters are all optional).");
        }

        private static object? DefaultArgFor(ParameterInfo p)
        {
            if (p.HasDefaultValue) return p.DefaultValue;                    // the author's own default
            return p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
        }

        private static string Signature(ConstructorInfo c)
        {
            string vis = c.IsPublic ? "public" : c.IsAssembly ? "internal" : c.IsFamily ? "protected" : "private";
            return vis + " .ctor(" + string.Join(", ", c.GetParameters()
                .Select(p => p.ParameterType.Name + (p.IsOptional ? " = default" : "")).ToArray()) + ")";
        }
    }
}
