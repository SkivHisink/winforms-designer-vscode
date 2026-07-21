# Third-Party Notices

This file lists third-party material distributed with the **WinForms Designer for VS Code**
extension (the `.vsix` package). The extension itself is licensed under the
[MIT License](LICENSE); the components below are licensed by their respective owners under the
terms reproduced here.

Only material that is **actually redistributed inside the `.vsix`** is listed:

| What ships | Where in the package |
| --- | --- |
| The VS Code codicon font | `extension/media/codicon.ttf` |
| `vscode-jsonrpc` (bundled into the extension code by esbuild) | `extension/dist/extension.js` |
| .NET engine dependencies (managed assemblies) | `extension/engine/`, `extension/engine-net48/` |

**DevExpress components are _not_ redistributed.** The .NET Framework engine renders DevExpress
controls by reflecting over the assemblies already installed on the user's machine and referenced
by the user's own project. No DevExpress binary, resource, or license file is included in this
repository or in the `.vsix`.

---

## 1. Visual Studio Code Codicons

- **Component:** `@vscode/codicons` (icon font — `codicon.ttf`, font version 1.15)
- **Version:** 0.0.45
- **Upstream:** https://github.com/microsoft/vscode-codicons
- **Author:** Microsoft Corporation
- **License:** [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) (Creative Commons Attribution 4.0 International)

`extension/media/codicon.ttf` is an **unmodified**, byte-for-byte copy of `dist/codicon.ttf` from
the `@vscode/codicons` 0.0.45 package
(SHA-256 `2bb558cb693451e73c28c33fe64aa89bc19b1a4b70f95948322c243f93476920`). The extension declares
its own `@font-face` rule and glyph class names; no other file from the package is redistributed.

The upstream project states its licensing as follows (verbatim from the package `README.md`,
"Legal Notices"):

> Microsoft and any contributors grant you a license to the Microsoft documentation and other content
> in this repository under the [Creative Commons Attribution 4.0 International Public License](https://creativecommons.org/licenses/by/4.0/legalcode),
> see the [LICENSE](LICENSE) file, and grant you a license to any code in the repository under the [MIT License](https://opensource.org/licenses/MIT), see the
> [LICENSE-CODE](LICENSE-CODE) file.
>
> Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation
> may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries.
> The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks.

The font is generated from the icon artwork, which is the "content" covered by the Creative Commons
Attribution 4.0 International Public License. The full license text is available at
https://creativecommons.org/licenses/by/4.0/legalcode and in the `LICENSE` file of the upstream
repository.

Disclaimer notice, as required by CC BY 4.0 § 5: unless otherwise separately undertaken by the
Licensor, to the extent possible, the Licensor offers the Licensed Material as-is and as-available,
and makes no representations or warranties of any kind concerning the Licensed Material, whether
express, implied, statutory, or other.

---

## 2. vscode-jsonrpc

- **Component:** `vscode-jsonrpc` (bundled into `extension/dist/extension.js` by esbuild)
- **Version:** 9.0.0
- **Upstream:** https://github.com/microsoft/vscode-languageserver-node
- **License:** MIT

Verbatim from `node_modules/vscode-jsonrpc/License.txt`:

```
Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## 3. .NET engine dependencies

The two rendering engines (`extension/engine/`, `extension/engine-net48/`) ship the managed
assemblies listed below, together with their localized satellite resource assemblies
(`cs/`, `de/`, `es/`, `fr/`, `it/`, `ja/`, `ko/`, `pl/`, `pt-BR/`, `ru/`, `tr/`, `zh-Hans/`,
`zh-Hant/`), which are covered by the license of their parent component.

**Every component in this section is licensed under the MIT License.** The copyright notices are
reproduced per component, followed by the single MIT permission notice that applies to all of them.

| Component | Version | Upstream | Copyright |
| --- | --- | --- | --- |
| MessagePack | 2.5.302 | https://github.com/MessagePack-CSharp/MessagePack-CSharp | © Yoshifumi Kawai and contributors. All rights reserved. |
| MessagePack.Annotations | 2.5.302 | https://github.com/MessagePack-CSharp/MessagePack-CSharp | © Yoshifumi Kawai and contributors. All rights reserved. |
| Microsoft.Bcl.AsyncInterfaces | 10.0.1 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| Microsoft.Bcl.HashCode | 6.0.0 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| Microsoft.CodeAnalysis.Common | 5.6.0 | https://github.com/dotnet/roslyn | © Microsoft Corporation. All rights reserved. |
| Microsoft.CodeAnalysis.CSharp | 5.6.0 | https://github.com/dotnet/roslyn | © Microsoft Corporation. All rights reserved. |
| Microsoft.NET.StringTools | 18.4.0 | https://github.com/dotnet/msbuild | © Microsoft Corporation. All rights reserved. |
| Microsoft.VisualStudio.Threading.Only | 17.14.15 | https://microsoft.github.io/vs-threading/ | © Microsoft Corporation. All rights reserved. |
| Microsoft.VisualStudio.Validation | 17.13.22 | https://github.com/Microsoft/vs-validation | © Microsoft Corporation. All rights reserved. |
| Microsoft.Win32.Registry | 5.0.0 | https://github.com/dotnet/runtime | © Microsoft Corporation. All rights reserved. |
| Nerdbank.MessagePack | 1.2.4 | https://aarnott.github.io/Nerdbank.MessagePack/ | © Andrew Arnott. All rights reserved. |
| Nerdbank.Streams | 2.13.16 | https://github.com/AArnott/Nerdbank.Streams | © Andrew Arnott. All rights reserved. |
| Newtonsoft.Json | 13.0.3 | https://www.newtonsoft.com/json | Copyright (c) 2007 James Newton-King |
| PolyType | 1.3.1 | https://github.com/eiriktsarpalis/PolyType | Eirik Tsarpalis, 2024 (see note below) |
| StreamJsonRpc | 2.25.29 | https://github.com/microsoft/vs-streamjsonrpc | © Microsoft Corporation. All rights reserved. |
| System.Buffers | 4.6.1 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| System.Collections.Immutable | 10.0.1 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Diagnostics.DiagnosticSource | 8.0.1 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.IO.Pipelines | 8.0.0 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Memory | 4.6.3 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| System.Numerics.Vectors | 4.6.1 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| System.Reflection.Metadata | 10.0.1 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Runtime.CompilerServices.Unsafe | 6.1.2 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| System.Security.AccessControl | 5.0.0 | https://github.com/dotnet/runtime | © Microsoft Corporation. All rights reserved. |
| System.Security.Principal.Windows | 5.0.0 | https://github.com/dotnet/runtime | © Microsoft Corporation. All rights reserved. |
| System.Text.Encoding.CodePages | 8.0.0 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Text.Encodings.Web | 8.0.0 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Text.Json | 8.0.6 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Threading.Tasks.Dataflow | 8.0.1 | https://dot.net/ | © Microsoft Corporation. All rights reserved. |
| System.Threading.Tasks.Extensions | 4.6.3 | https://github.com/dotnet/maintenance-packages | © Microsoft Corporation. All rights reserved. |
| System.ValueTuple | 4.5.0 | https://dot.net/ | Copyright (c) .NET Foundation and Contributors |

Notes on the table above:

- The copyright column reproduces the `<copyright>` field of each package's `.nuspec`, except for
  **Newtonsoft.Json** and **System.ValueTuple**, where the notice is taken verbatim from the
  `LICENSE.md` / `LICENSE.TXT` file shipped inside the package itself.
- The components published from `dotnet/runtime`, `dotnet/maintenance-packages` and `dot.net`
  declare `© Microsoft Corporation. All rights reserved.` in their package metadata, while the
  upstream repository's `LICENSE.TXT` carries `Copyright (c) .NET Foundation and Contributors`.
  Both parties are therefore credited here.
- **PolyType** declares `MIT` as its license expression and `Eirik Tsarpalis` as its author, but its
  package metadata carries only `2024` as the copyright value and ships no `LICENSE` file, so no
  verbatim copyright line could be established from the package. The canonical notice is in the
  upstream repository.

### MIT License

The following permission notice applies to every component listed in section 3, in conjunction with
that component's copyright notice above:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Some of the Microsoft-published components above (StreamJsonRpc, Microsoft.VisualStudio.Threading,
vscode-jsonrpc) ship a `NOTICE` file stating:

> This software incorporates material from third parties. Microsoft makes certain open source code
> available at https://3rdpartysource.microsoft.com, or you may send a check or money order for
> US $5.00, including the product name, the open source component name, platform, and version
> number, to: Source Code Compliance Team, Microsoft Corporation, One Microsoft Way, Redmond,
> WA 98052, USA.
>
> Notwithstanding any other terms, you may reverse engineer this software to the extent required to
> debug changes to any libraries licensed under the GNU Lesser General Public License.
