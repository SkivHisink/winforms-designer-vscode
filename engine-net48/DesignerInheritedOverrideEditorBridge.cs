using System;
using System.Text;
using Microsoft.CodeAnalysis.CSharp;

namespace WinFormsDesigner.Engine
{
    internal static class DesignerControlEditor
    {
        public static bool IsValidIdentifier(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            if (!((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z') || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
                if (!((s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= 'a' && s[i] <= 'z')
                    || (s[i] >= '0' && s[i] <= '9') || s[i] == '_')) return false;
            return SyntaxFacts.GetKeywordKind(s) == SyntaxKind.None && SyntaxFacts.IsValidIdentifier(s);
        }
    }

    internal static class StringCompatibilityExtensions
    {
        public static string Replace(this string source, string oldValue, string newValue, StringComparison comparisonType)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            if (string.IsNullOrEmpty(oldValue)) throw new ArgumentException("oldValue cannot be empty", nameof(oldValue));

            int start = source.IndexOf(oldValue, comparisonType);
            if (start < 0) return source;

            var result = new StringBuilder(source.Length);
            int offset = 0;
            while (start >= 0)
            {
                result.Append(source, offset, start - offset);
                result.Append(newValue);
                offset = start + oldValue.Length;
                start = source.IndexOf(oldValue, offset, comparisonType);
            }
            result.Append(source, offset, source.Length - offset);
            return result.ToString();
        }
    }
}
