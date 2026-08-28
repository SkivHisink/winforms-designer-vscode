using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class ProjectDataProperty
    {
        public string Name { get; init; } = "";
        public string TypeName { get; init; } = "";
        public string Kind { get; init; } = "";
        public bool ReadOnly { get; init; }
    }

    public sealed class ProjectDataSchema
    {
        public string Key { get; init; } = "";
        public string Name { get; init; } = "";
        public string TypeName { get; init; } = "";
        /// <summary>`object` for an ordinary DTO, `typedDataSetTable` for one table exposed by a generated typed DataSet.</summary>
        public string SourceKind { get; init; } = "object";
        /// <summary>Typed-DataSet table/DataMember name; empty for ordinary object schemas.</summary>
        public string DataMember { get; init; } = "";
        public List<ProjectDataProperty> Properties { get; init; } = new();
        public List<string> ExistingBindingSources { get; init; } = new();
    }

    public sealed class ProjectApplicationSetting
    {
        public string Key { get; init; } = "";
        public string Name { get; init; } = "";
        public string TypeName { get; init; } = "";
        public string Scope { get; init; } = "";
    }

    public sealed class DataSourcesResult
    {
        public bool Ok { get; init; }
        public List<ProjectDataSchema> Schemas { get; init; } = new();
        public List<ProjectApplicationSetting> Settings { get; init; } = new();
        public string Reason { get; init; } = "";
        public string? RefusalCode { get; init; }
    }

    public sealed class DataSourceGenerationResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
        public string? Text { get; init; }
        public List<string> CreatedIds { get; init; } = new();
        public string BoundProperty { get; init; } = "";
        public string? RefusalCode { get; init; }
    }

    public static class DesignerDataSourceGenerator
    {
        private const int MaxProjectFiles = 1200;
        private const int MaxSourceBytes = 512 * 1024;
        private const int MaxSchemaProperties = 64;
        private const string BindingSourceType = "System.Windows.Forms.BindingSource";
        private const string DataGridViewType = "System.Windows.Forms.DataGridView";
        private const string TextBoxType = "System.Windows.Forms.TextBox";
        private const string LabelType = "System.Windows.Forms.Label";
        private const string BindingNavigatorType = "System.Windows.Forms.BindingNavigator";
        private const string DataGridViewColumnType = "System.Windows.Forms.DataGridViewColumn";
        private const string DataGridViewTextBoxColumnType = "System.Windows.Forms.DataGridViewTextBoxColumn";

        private static readonly Dictionary<string, string> ScalarAliases = new(StringComparer.Ordinal)
        {
            ["string"] = "System.String",
            ["bool"] = "System.Boolean",
            ["byte"] = "System.Byte",
            ["sbyte"] = "System.SByte",
            ["short"] = "System.Int16",
            ["ushort"] = "System.UInt16",
            ["int"] = "System.Int32",
            ["uint"] = "System.UInt32",
            ["long"] = "System.Int64",
            ["ulong"] = "System.UInt64",
            ["float"] = "System.Single",
            ["double"] = "System.Double",
            ["decimal"] = "System.Decimal",
            ["char"] = "System.Char",
        };

        private static readonly HashSet<string> ScalarTypes = new(StringComparer.Ordinal)
        {
            "System.String", "System.Boolean", "System.Byte", "System.SByte", "System.Int16", "System.UInt16",
            "System.Int32", "System.UInt32", "System.Int64", "System.UInt64", "System.Single", "System.Double",
            "System.Decimal", "System.Char", "System.DateTime", "System.DateTimeOffset", "System.Guid",
            "System.TimeSpan",
        };

        public static DataSourcesResult ListDataSources(string designerFilePath, string? sourceText = null)
        {
            var project = ProjectInfo.FromDesigner(designerFilePath);
            if (project == null)
                return FailList("project file not found");

            string designerSource = sourceText ?? SafeRead(designerFilePath);
            var schemas = DiscoverSchemas(project, out var unsupportedProviders)
                .Select(s => new ProjectDataSchema
                {
                    Key = s.Key,
                    Name = s.Name,
                    TypeName = s.TypeName,
                    SourceKind = s.SourceKind,
                    DataMember = s.DataMember,
                    Properties = s.Properties,
                    ExistingBindingSources = ExistingBindingSourcesForSchema(designerSource, s),
                })
                .OrderBy(s => s.Name, StringComparer.Ordinal)
                .ThenBy(s => s.TypeName, StringComparer.Ordinal)
                .ToList();
            var settings = DiscoverSettings(project);

            if (schemas.Count == 0 && settings.Count == 0)
            {
                if (unsupportedProviders.Count > 0)
                    return FailList(
                        "unsupported data provider: " + string.Join(", ", unsupportedProviders.Take(5)),
                        "UNSUPPORTED_DATA_PROVIDER");
                return FailList("no supported project data sources or application settings found");
            }

            return new DataSourcesResult { Ok = true, Schemas = schemas, Settings = settings };
        }

        public static DataSourceGenerationResult GenerateDataSource(
            string designerFilePath,
            string schemaKey,
            string mode,
            string parentId,
            int x,
            int y,
            bool includeNavigator,
            string? existingBindingSourceId = null,
            string? existingGridId = null,
            string? sourceText = null)
        {
            string src = sourceText ?? SafeRead(designerFilePath);
            var listed = ListDataSources(designerFilePath, src);
            if (!listed.Ok)
                return FailEdit(listed.Reason, refusalCode: listed.RefusalCode);
            var schema = listed.Schemas.FirstOrDefault(s => string.Equals(s.Key, schemaKey, StringComparison.Ordinal));
            if (schema == null)
                return FailEdit("unknown or stale data-source schema");
            if (schema.Properties.Count == 0)
                return FailEdit("schema has no supported scalar properties");
            if (mode != "detail" && mode != "grid")
                return FailEdit("unsupported data-source generation mode: " + mode);

            var model = DesignerModel.TryCreate(src, out var modelReason);
            if (model == null)
                return FailEdit(modelReason);
            if (!model.IsSupportedContainer(parentId))
                return FailEdit("target parent is not a supported container: " + parentId);

            string? bindingSourceId = NormalizeOptional(existingBindingSourceId);
            if (bindingSourceId != null)
            {
                if (!schema.ExistingBindingSources.Contains(bindingSourceId, StringComparer.Ordinal))
                    return FailEdit("existing BindingSource does not match the selected schema: " + bindingSourceId);
            }
            else
            {
                bindingSourceId = model.UniqueName(ToCamel(schema.Name) + "BindingSource");
            }

            if (NormalizeOptional(existingGridId) is string gridId)
                return AppendGridColumns(src, model, schema, gridId, bindingSourceId);

            var plan = mode == "detail"
                ? BuildDetailPlan(model, schema, parentId, Math.Max(0, x), Math.Max(0, y), includeNavigator, bindingSourceId)
                : BuildGridPlan(model, schema, parentId, Math.Max(0, x), Math.Max(0, y), includeNavigator, bindingSourceId);

            string edited = ApplyPlan(src, model, plan);
            if (!ValidateWholeEdit(src, edited, plan.CreatedIds, out var reason))
                return FailEdit(reason, plan.CreatedIds);
            return Succeed(edited, plan.CreatedIds);
        }

        public static DataSourceGenerationResult BindApplicationSetting(
            string designerFilePath,
            string settingKey,
            string targetId,
            string? sourceText = null)
        {
            string src = sourceText ?? SafeRead(designerFilePath);
            var project = ProjectInfo.FromDesigner(designerFilePath);
            if (project == null)
                return FailEdit("project file not found");
            if (string.IsNullOrEmpty(project.SettingsNamespace))
                return FailEdit("application settings namespace could not be proven");
            var listed = ListDataSources(designerFilePath, src);
            if (!listed.Ok)
                return FailEdit(listed.Reason);
            var setting = listed.Settings.FirstOrDefault(s => string.Equals(s.Key, settingKey, StringComparison.Ordinal));
            if (setting == null)
                return FailEdit("unknown or stale application setting");

            var model = DesignerModel.TryCreate(src, out var modelReason);
            if (model == null)
                return FailEdit(modelReason);
            if (!model.Fields.TryGetValue(targetId, out var targetType))
                return FailEdit("unknown target: " + targetId);
            if (!TrySettingBindingProperty(targetType, setting.TypeName, out var property))
                return FailEdit("setting type is not compatible with the target control");
            if (HasUnsafeTriviaOnTargetBindings(model.Init, targetId))
                return FailEdit("target DataBindings contains comments or directives");
            if (HasBindingForProperty(model.Init, targetId, property))
                return FailEdit("target property already has a binding: " + property);

            string stmt = "this." + targetId + ".DataBindings.Add(new global::System.Windows.Forms.Binding("
                + SyntaxFactory.Literal(property) + ", global::" + project.SettingsNamespace
                + ".Properties.Settings.Default, " + SyntaxFactory.Literal(setting.Name)
                + ", true, global::System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged));";
            var plan = new EditPlan();
            plan.StatementBlocks.Add((model.AnchorAfterOwner(targetId), new[] { stmt }));
            string edited = ApplyPlan(src, model, plan);
            if (!ValidateWholeEdit(src, edited, Array.Empty<string>(), out var reason))
                return FailEdit(reason);
            return new DataSourceGenerationResult
            {
                Safe = true,
                NewText = edited,
                Text = edited,
                BoundProperty = property,
            };
        }

        private static DataSourceGenerationResult AppendGridColumns(
            string src,
            DesignerModel model,
            ProjectDataSchema schema,
            string gridId,
            string bindingSourceId)
        {
            if (!model.Fields.TryGetValue(gridId, out var gridType) || ShortTypeName(gridType) != "DataGridView")
                return FailEdit("existing grid is not a supported DataGridView: " + gridId);
            bool createBindingSource = !model.Fields.TryGetValue(bindingSourceId, out _);
            if (!createBindingSource)
            {
                if (!BindingSourceMatchesSchema(src, model, bindingSourceId, schema))
                    return FailEdit("existing BindingSource is stale or does not match the selected schema");
            }

            var current = DesignerGridColumnEditor.ListColumns(src, gridId);
            if (!current.Ok)
                return FailEdit(current.Reason);
            var existingMembers = new HashSet<string>(current.Columns.Select(c => c.DataPropertyName)
                .Where(v => !string.IsNullOrEmpty(v)), StringComparer.Ordinal);
            var desired = current.Columns
                .Select(c => new GridColumnItem
                {
                    Id = c.Id,
                    HeaderText = c.HeaderText,
                    Width = c.Width,
                    ReadOnly = c.ReadOnly,
                    Visible = c.Visible,
                    DataPropertyName = c.DataPropertyName,
                    Format = c.Format,
                    Alignment = c.Alignment,
                    NullValue = c.NullValue,
                })
                .ToList();
            foreach (var p in schema.Properties)
            {
                if (existingMembers.Contains(p.Name))
                    continue;
                desired.Add(new GridColumnItem
                {
                    HeaderText = p.Name,
                    DataPropertyName = p.Name,
                    Width = DefaultColumnWidth(p.TypeName),
                    ReadOnly = p.ReadOnly,
                    Alignment = IsNumeric(p.TypeName) ? "MiddleRight" : "NotSet",
                });
            }
            if (desired.Count == current.Columns.Count)
                return Succeed(src, Array.Empty<string>());

            var edit = DesignerGridColumnEditor.SetColumns(src, gridId, desired);
            if (edit.Mode == EditMode.Failed)
                return FailEdit(edit.Reason);
            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerGridColumnEditor.OnlyColumnsChanged(src, edit.NewText, gridId);
            if (!parseOk || !minimal)
                return FailEdit(!parseOk ? "edited text has syntax errors" : "edit changed more than the target columns");

            var createdIds = NewColumnIds(current.Columns, edit.NewText, gridId);
            if (!createBindingSource)
                return Succeed(edit.NewText, createdIds);

            var afterColumns = DesignerModel.TryCreate(edit.NewText, out var modelReason);
            if (afterColumns == null)
                return FailEdit(modelReason);
            var plan = new EditPlan();
            AddNewBindingSourceInfrastructure(afterColumns, plan, schema, bindingSourceId);
            plan.StatementBlocks.Add((afterColumns.AnchorAfterOwner(gridId), new[]
            {
                "this." + gridId + ".DataSource = this." + bindingSourceId + ";",
            }));
            string final = ApplyPlan(edit.NewText, afterColumns, plan);
            if (!ValidateWholeEdit(edit.NewText, final, plan.CreatedIds, out var reason))
                return FailEdit(reason);
            createdIds.AddRange(plan.CreatedIds.Where(id => !createdIds.Contains(id, StringComparer.Ordinal)));
            return Succeed(final, createdIds);
        }

        private static EditPlan BuildDetailPlan(
            DesignerModel model,
            ProjectDataSchema schema,
            string parentId,
            int x,
            int y,
            bool includeNavigator,
            string bindingSourceId)
        {
            var plan = new EditPlan();
            if (!model.Fields.ContainsKey(bindingSourceId))
            {
                AddNewBindingSourceInfrastructure(model, plan, schema, bindingSourceId);
            }

            int row = 0;
            var parentAdd = new List<string>();
            foreach (var p in schema.Properties)
            {
                string labelId = model.UniqueName(ToCamel(p.Name) + "Label", plan.CreatedIds);
                string editorId = model.UniqueName(ToCamel(p.Name) + EditorSuffix(p.TypeName), plan.CreatedIds.Concat(new[] { labelId }));
                plan.CreatedIds.Add(labelId);
                plan.CreatedIds.Add(editorId);
                plan.Fields.Add(FieldDecl(LabelType, labelId));
                plan.Fields.Add(FieldDecl(EditorType(p.TypeName), editorId));

                int yy = y + row * 28;
                plan.StatementBlocks.Add((model.CtorAnchor, new[]
                {
                    "this." + labelId + " = new " + LabelType + "();",
                    "this." + editorId + " = new " + EditorType(p.TypeName) + "();",
                }));
                var propertyStatements = new List<string>
                {
                    "this." + labelId + ".AutoSize = true;",
                    "this." + labelId + ".Location = new System.Drawing.Point(" + x.ToString(CultureInfo.InvariantCulture) + ", " + (yy + 4).ToString(CultureInfo.InvariantCulture) + ");",
                    "this." + labelId + ".Name = " + SyntaxFactory.Literal(labelId) + ";",
                    "this." + labelId + ".Text = " + SyntaxFactory.Literal(p.Name) + ";",
                    "this." + editorId + ".Location = new System.Drawing.Point(" + (x + 120).ToString(CultureInfo.InvariantCulture) + ", " + yy.ToString(CultureInfo.InvariantCulture) + ");",
                    "this." + editorId + ".Name = " + SyntaxFactory.Literal(editorId) + ";",
                    "this." + editorId + ".Size = new System.Drawing.Size(" + EditorWidth(p.TypeName).ToString(CultureInfo.InvariantCulture) + ", 23);",
                    "this." + editorId + ".TabIndex = " + row.ToString(CultureInfo.InvariantCulture) + ";",
                };
                if (p.ReadOnly)
                    propertyStatements.AddRange(ReadOnlyEditorStatements(editorId, p.TypeName));
                propertyStatements.Add("this." + editorId + ".DataBindings.Add(new System.Windows.Forms.Binding("
                    + SyntaxFactory.Literal(BoundPropertyForType(p.TypeName)) + ", this." + bindingSourceId + ", "
                    + SyntaxFactory.Literal(p.Name) + ", true, System.Windows.Forms.DataSourceUpdateMode."
                    + (p.ReadOnly ? "Never" : "OnPropertyChanged") + "));");
                plan.StatementBlocks.Add((model.PropertyAnchor(parentId), propertyStatements));
                parentAdd.Add(ParentControlsAdd(parentId, labelId));
                parentAdd.Add(ParentControlsAdd(parentId, editorId));
                row++;
            }
            plan.StatementBlocks.Add((model.AddAnchor(parentId), parentAdd));

            if (includeNavigator)
                AddNavigator(model, plan, parentId, x, y + schema.Properties.Count * 28 + 8, bindingSourceId);
            return plan;
        }

        private static EditPlan BuildGridPlan(
            DesignerModel model,
            ProjectDataSchema schema,
            string parentId,
            int x,
            int y,
            bool includeNavigator,
            string bindingSourceId)
        {
            var plan = new EditPlan();
            if (!model.Fields.ContainsKey(bindingSourceId))
            {
                AddNewBindingSourceInfrastructure(model, plan, schema, bindingSourceId);
            }

            string gridId = model.UniqueName(ToCamel(schema.Name) + "DataGridView", plan.CreatedIds);
            plan.CreatedIds.Add(gridId);
            plan.Fields.Add(FieldDecl(DataGridViewType, gridId));
            var columnIds = new List<string>();
            foreach (var p in schema.Properties)
            {
                string columnId = model.UniqueName(ToCamel(p.Name) + "Column", plan.CreatedIds.Concat(columnIds));
                columnIds.Add(columnId);
                plan.CreatedIds.Add(columnId);
                plan.Fields.Add(FieldDecl(DataGridViewTextBoxColumnType, columnId));
            }
            var ctor = new List<string> { "this." + gridId + " = new " + DataGridViewType + "();" };
            ctor.AddRange(columnIds.Select(id => "this." + id + " = new " + DataGridViewTextBoxColumnType + "();"));
            plan.StatementBlocks.Add((model.CtorAnchor, ctor));

            var props = new List<string>
            {
                "this." + gridId + ".AutoGenerateColumns = false;",
                "this." + gridId + ".ColumnHeadersHeightSizeMode = System.Windows.Forms.DataGridViewColumnHeadersHeightSizeMode.AutoSize;",
                "this." + gridId + ".Columns.AddRange(new " + DataGridViewColumnType + "[] { " + string.Join(", ", columnIds.Select(id => "this." + id)) + " });",
                "this." + gridId + ".DataSource = this." + bindingSourceId + ";",
                "this." + gridId + ".Location = new System.Drawing.Point(" + x.ToString(CultureInfo.InvariantCulture) + ", " + y.ToString(CultureInfo.InvariantCulture) + ");",
                "this." + gridId + ".Name = " + SyntaxFactory.Literal(gridId) + ";",
                "this." + gridId + ".Size = new System.Drawing.Size(420, 220);",
                "this." + gridId + ".TabIndex = 0;",
            };
            for (int i = 0; i < schema.Properties.Count; i++)
            {
                var p = schema.Properties[i];
                string column = columnIds[i];
                props.Add("this." + column + ".DataPropertyName = " + SyntaxFactory.Literal(p.Name) + ";");
                props.Add("this." + column + ".HeaderText = " + SyntaxFactory.Literal(p.Name) + ";");
                props.Add("this." + column + ".Name = " + SyntaxFactory.Literal(column) + ";");
                if (p.ReadOnly)
                    props.Add("this." + column + ".ReadOnly = true;");
                if (DefaultColumnWidth(p.TypeName) != 100)
                    props.Add("this." + column + ".Width = " + DefaultColumnWidth(p.TypeName).ToString(CultureInfo.InvariantCulture) + ";");
                if (IsNumeric(p.TypeName))
                    props.Add("this." + column + ".DefaultCellStyle.Alignment = System.Windows.Forms.DataGridViewContentAlignment.MiddleRight;");
            }
            plan.StatementBlocks.Add((model.PropertyAnchor(parentId), props));
            plan.StatementBlocks.Add((model.AddAnchor(parentId), new[] { ParentControlsAdd(parentId, gridId) }));

            if (includeNavigator)
                AddNavigator(model, plan, parentId, x, Math.Max(0, y - 28), bindingSourceId);
            return plan;
        }

        /// <summary>
        /// Add the source component(s) and BindingSource as one constructor block. Ordinary DTOs retain the
        /// established `DataSource = typeof(T)` shape. A typed DataSet table instead gets a real project DataSet
        /// instance plus `DataMember`, matching the object graph Visual Studio generates; using `typeof(DataSet)`
        /// would not select a table and would leave the generated controls without the advertised schema.
        /// </summary>
        private static void AddNewBindingSourceInfrastructure(
            DesignerModel model,
            EditPlan plan,
            ProjectDataSchema schema,
            string bindingSourceId)
        {
            plan.CreatedIds.Add(bindingSourceId);
            var statements = new List<string>();
            if (schema.SourceKind == "typedDataSetTable")
            {
                string? dataSetId = model.Fields
                    .Where(kv => SameType(kv.Value, schema.TypeName))
                    .Select(kv => kv.Key)
                    .OrderBy(id => id, StringComparer.Ordinal)
                    .FirstOrDefault();
                if (dataSetId == null)
                {
                    dataSetId = model.UniqueName(ToCamel(ShortTypeName(schema.TypeName)), plan.CreatedIds);
                    plan.CreatedIds.Add(dataSetId);
                    plan.Fields.Add(FieldDecl(schema.TypeName, dataSetId));
                    statements.Add("this." + dataSetId + " = new " + schema.TypeName + "();");
                }
                plan.Fields.Add(FieldDecl(BindingSourceType, bindingSourceId));
                statements.Add("this." + bindingSourceId + " = new " + BindingSourceType + BindingSourceCtorArgs(model) + ";");
                statements.Add("this." + bindingSourceId + ".DataMember = " + SyntaxFactory.Literal(schema.DataMember) + ";");
                statements.Add("this." + bindingSourceId + ".DataSource = this." + dataSetId + ";");
            }
            else
            {
                plan.Fields.Add(FieldDecl(BindingSourceType, bindingSourceId));
                statements.Add("this." + bindingSourceId + " = new " + BindingSourceType + BindingSourceCtorArgs(model) + ";");
                statements.Add("this." + bindingSourceId + ".DataSource = typeof(" + schema.TypeName + ");");
            }
            plan.StatementBlocks.Add((model.CtorAnchor, statements));
        }

        private static void AddNavigator(DesignerModel model, EditPlan plan, string parentId, int x, int y, string bindingSourceId)
        {
            string navigatorId = model.UniqueName("bindingNavigator", plan.CreatedIds);
            plan.CreatedIds.Add(navigatorId);
            plan.Fields.Add(FieldDecl(BindingNavigatorType, navigatorId));
            plan.StatementBlocks.Add((model.CtorAnchor, new[] { "this." + navigatorId + " = new " + BindingNavigatorType + "(this.components);" }));
            plan.StatementBlocks.Add((model.PropertyAnchor(parentId), new[]
            {
                "this." + navigatorId + ".BindingSource = this." + bindingSourceId + ";",
                "this." + navigatorId + ".Location = new System.Drawing.Point(" + x.ToString(CultureInfo.InvariantCulture) + ", " + y.ToString(CultureInfo.InvariantCulture) + ");",
                "this." + navigatorId + ".Name = " + SyntaxFactory.Literal(navigatorId) + ";",
                "this." + navigatorId + ".Size = new System.Drawing.Size(250, 25);",
                "this." + navigatorId + ".TabIndex = 0;",
            }));
            plan.StatementBlocks.Add((model.AddAnchor(parentId), new[] { ParentControlsAdd(parentId, navigatorId) }));
        }

        private static string ApplyPlan(string src, DesignerModel model, EditPlan plan)
        {
            string nl = NewLine(src);
            var inserts = new List<(int Pos, int Seq, string Text)>();
            int seq = 0;
            foreach (var block in plan.StatementBlocks)
            {
                string text = string.Concat(block.Statements.Select(s => model.Indent + s + nl));
                inserts.Add((block.Pos, seq++, text));
            }
            foreach (var group in inserts.GroupBy(i => i.Pos).OrderByDescending(g => g.Key))
            {
                string text = string.Concat(group.OrderBy(i => i.Seq).Select(i => i.Text));
                src = src.Substring(0, group.Key) + text + src.Substring(group.Key);
            }
            if (plan.Fields.Count == 0)
                return src;
            string fieldText = string.Concat(plan.Fields.Select(f => model.FieldIndent + f + nl));
            int shift = inserts.Where(i => i.Pos <= model.FieldAnchor).Sum(i => i.Text.Length);
            int fieldAnchor = model.FieldAnchor + shift;
            return src.Substring(0, fieldAnchor) + fieldText + src.Substring(fieldAnchor);
        }

        private static bool ValidateWholeEdit(string original, string edited, IEnumerable<string> createdIds, out string reason)
        {
            reason = "";
            var tree = CSharpSyntaxTree.ParseText(edited);
            if (tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                reason = "edited text has syntax errors";
                return false;
            }
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = tree.GetRoot();
            var oInit = FormClassResolver.InitMethod(oRoot);
            var eInit = FormClassResolver.InitMethod(eRoot);
            var oClass = FormClassResolver.FormClass(oRoot);
            var eClass = FormClassResolver.FormClass(eRoot);
            if (oInit?.Body == null || eInit?.Body == null || oClass == null || eClass == null)
            {
                reason = "InitializeComponent not found";
                return false;
            }
            var oStatements = oInit.Body.Statements.Select(s => Normalize(s.ToString())).ToList();
            var eStatements = eInit.Body.Statements.Select(s => Normalize(s.ToString())).ToList();
            if (!MultisetContains(eStatements, oStatements))
            {
                reason = "edit changed existing InitializeComponent statements";
                return false;
            }
            var created = new HashSet<string>(createdIds ?? Array.Empty<string>(), StringComparer.Ordinal);
            var oFields = FieldNames(oClass);
            var eFields = FieldNames(eClass);
            foreach (var field in oFields)
            {
                if (!eFields.Contains(field))
                {
                    reason = "edit removed an existing field";
                    return false;
                }
            }
            foreach (var field in eFields.Except(oFields, StringComparer.Ordinal))
            {
                if (!created.Contains(field))
                {
                    reason = "edit added an unexpected field";
                    return false;
                }
            }
            return true;
        }

        private static List<ProjectDataSchema> DiscoverSchemas(ProjectInfo project, out List<string> unsupportedProviders)
        {
            var schemas = new List<ProjectDataSchema>();
            unsupportedProviders = new List<string>();
            foreach (var file in EnumerateProjectSourceFiles(project))
            {
                string text = SafeRead(file);
                if (text.Length == 0 || text.Length > MaxSourceBytes)
                    continue;
                var root = CSharpSyntaxTree.ParseText(text).GetRoot();
                if (root.ContainsDiagnostics)
                    continue;
                foreach (var cls in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
                {
                    if (cls is not ClassDeclarationSyntax and not RecordDeclarationSyntax)
                        continue;
                    if (!IsVisibleTopLevel(cls) || cls.TypeParameterList != null || cls.Modifiers.Any(SyntaxKind.AbstractKeyword))
                        continue;
                    // A generated typed DataSet is one source with one schema per table. Its nested Row types are
                    // implementation details of that source, not duplicate top-level DTO cards.
                    if (cls.Ancestors().OfType<TypeDeclarationSyntax>().Any(IsTypedDataSetDeclaration))
                        continue;
                    if (cls.BaseList?.Types.Any(b => IsDesignerBaseType(b.Type.ToString())) == true)
                        continue;
                    string typeName = QualifiedTypeName(cls);
                    if (IsTypedDataSetDeclaration(cls))
                    {
                        schemas.AddRange(DiscoverTypedDataSetTables(cls, typeName));
                        continue;
                    }
                    if (IsUnsupportedDataProviderCandidate(cls))
                    {
                        unsupportedProviders.Add(typeName);
                        continue;
                    }
                    var props = cls.Members.OfType<PropertyDeclarationSyntax>()
                        .Select(TryDataProperty)
                        .Where(p => p != null)
                        .Select(p => p!)
                        .Take(MaxSchemaProperties + 1)
                        .ToList();
                    if (props.Count == 0 || props.Count > MaxSchemaProperties)
                        continue;
                    schemas.Add(new ProjectDataSchema
                    {
                        Key = "schema:" + typeName,
                        Name = cls.Identifier.ValueText,
                        TypeName = typeName,
                        Properties = props,
                    });
                }
            }

            return schemas.GroupBy(s => s.Key, StringComparer.Ordinal)
                .Where(g => g.Count() == 1)
                .Select(g => g.Single())
                .ToList();
        }

        private static bool IsTypedDataSetDeclaration(TypeDeclarationSyntax type) =>
            type.BaseList?.Types.Any(baseType =>
                string.Equals(ShortTypeName(baseType.Type.ToString()), "DataSet", StringComparison.Ordinal)) == true;

        private static IEnumerable<ProjectDataSchema> DiscoverTypedDataSetTables(
            TypeDeclarationSyntax dataSet,
            string dataSetTypeName)
        {
            var nested = dataSet.Members.OfType<ClassDeclarationSyntax>().ToList();
            var rows = nested
                .Where(row => row.BaseList?.Types.Any(baseType =>
                    string.Equals(ShortTypeName(baseType.Type.ToString()), "DataRow", StringComparison.Ordinal)) == true)
                .ToDictionary(row => row.Identifier.ValueText, StringComparer.Ordinal);
            var tableRows = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var table in nested)
            {
                foreach (var baseType in table.BaseList?.Types ?? default(SeparatedSyntaxList<BaseTypeSyntax>))
                {
                    string text = baseType.Type.ToString().Replace("global::", "", StringComparison.Ordinal);
                    var match = Regex.Match(text, @"(?:TypedTableBase|DataTable)\s*<\s*(?:[\w.]+\.)?(?<row>[\p{L}_][\p{L}\p{N}_]*)\s*>");
                    if (match.Success && rows.ContainsKey(match.Groups["row"].Value))
                        tableRows[table.Identifier.ValueText] = match.Groups["row"].Value;
                }
                // Older xsd.exe output derives the table directly from DataTable. Its conventional generated pair
                // `<Name>DataTable` / `<Name>Row` is still an exact, syntax-local association.
                if (!tableRows.ContainsKey(table.Identifier.ValueText)
                    && table.BaseList?.Types.Any(baseType =>
                        string.Equals(ShortTypeName(baseType.Type.ToString()), "DataTable", StringComparison.Ordinal)) == true)
                {
                    string stem = table.Identifier.ValueText.EndsWith("DataTable", StringComparison.Ordinal)
                        ? table.Identifier.ValueText.Substring(0, table.Identifier.ValueText.Length - "DataTable".Length)
                        : table.Identifier.ValueText;
                    if (rows.ContainsKey(stem + "Row")) tableRows[table.Identifier.ValueText] = stem + "Row";
                }
            }

            foreach (var tableProperty in dataSet.Members.OfType<PropertyDeclarationSyntax>())
            {
                string tableType = ShortTypeName(tableProperty.Type.ToString());
                if (!tableRows.TryGetValue(tableType, out string? rowName)
                    || !rows.TryGetValue(rowName, out ClassDeclarationSyntax? row))
                    continue;
                var properties = row.Members.OfType<PropertyDeclarationSyntax>()
                    .Select(TryDataProperty)
                    .Where(property => property != null)
                    .Select(property => property!)
                    .Take(MaxSchemaProperties + 1)
                    .ToList();
                if (properties.Count == 0 || properties.Count > MaxSchemaProperties)
                    continue;
                string member = tableProperty.Identifier.ValueText;
                yield return new ProjectDataSchema
                {
                    Key = "typed-dataset:" + dataSetTypeName + ":" + member,
                    Name = member,
                    TypeName = dataSetTypeName,
                    SourceKind = "typedDataSetTable",
                    DataMember = member,
                    Properties = properties,
                };
            }
        }

        private static bool IsUnsupportedDataProviderCandidate(TypeDeclarationSyntax type)
        {
            string typeName = type.Identifier.ValueText;
            bool providerNamed = typeName.EndsWith("Context", StringComparison.Ordinal)
                || typeName.EndsWith("Repository", StringComparison.Ordinal)
                || typeName.EndsWith("Provider", StringComparison.Ordinal)
                || typeName.EndsWith("DataSource", StringComparison.Ordinal);
            bool providerBase = type.BaseList?.Types.Any(b => IsProviderTypeName(b.Type.ToString())) == true;
            bool providerMember = type.Members.OfType<PropertyDeclarationSyntax>().Any(p => IsProviderTypeName(p.Type.ToString()))
                || type.Members.OfType<FieldDeclarationSyntax>().Any(f => IsProviderTypeName(f.Declaration.Type.ToString()));
            return providerBase || providerMember || (providerNamed && type.Members.Any(m =>
                m is MethodDeclarationSyntax
                || m is PropertyDeclarationSyntax p && IsProviderTypeName(p.Type.ToString())
                || m is FieldDeclarationSyntax f && IsProviderTypeName(f.Declaration.Type.ToString())));
        }

        private static bool IsProviderTypeName(string value)
        {
            string s = value.Replace("global::", "", StringComparison.Ordinal).Trim();
            string shortName = ShortTypeName(s);
            if (shortName.EndsWith(">", StringComparison.Ordinal))
            {
                int generic = shortName.IndexOf('<');
                if (generic > 0)
                    shortName = shortName.Substring(0, generic);
            }
            return shortName is "DbContext" or "ObjectContext" or "DataContext" or "DbSet" or "IQueryable"
                or "DataTable" or "DataView" or "BindingList";
        }

        private static ProjectDataProperty? TryDataProperty(PropertyDeclarationSyntax prop)
        {
            if (!prop.Modifiers.Any(SyntaxKind.PublicKeyword) || prop.Modifiers.Any(SyntaxKind.StaticKeyword))
                return null;
            if (prop.AccessorList == null)
                return null;
            var get = prop.AccessorList.Accessors.FirstOrDefault(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            if (get == null || get.Modifiers.Any(SyntaxKind.PrivateKeyword))
                return null;
            bool readOnly = prop.AccessorList.Accessors.All(a => !a.IsKind(SyntaxKind.SetAccessorDeclaration) && !a.IsKind(SyntaxKind.InitAccessorDeclaration));
            string type = NormalizeType(prop.Type.ToString());
            if (!ScalarTypes.Contains(NullableInner(type)))
                return null;
            return new ProjectDataProperty
            {
                Name = prop.Identifier.ValueText,
                TypeName = type,
                Kind = KindOf(type),
                ReadOnly = readOnly,
            };
        }

        private static List<string> ExistingBindingSourcesForSchema(string source, ProjectDataSchema schema)
        {
            var model = DesignerModel.TryCreate(source, out _);
            if (model == null)
                return new List<string>();
            return model.Fields
                .Where(kv => ShortTypeName(kv.Value) == "BindingSource"
                    && BindingSourceMatchesSchema(source, model, kv.Key, schema))
                .Select(kv => kv.Key)
                .OrderBy(id => id, StringComparer.Ordinal)
                .ToList();
        }

        private static bool BindingSourceMatchesSchema(
            string source,
            DesignerModel model,
            string bindingSourceId,
            ProjectDataSchema schema)
        {
            var info = DesignerBindingEditor.GetDataSource(source, bindingSourceId);
            if (!info.Ok) return false;
            if (schema.SourceKind != "typedDataSetTable")
                return info.Kind == "type" && SameType(info.Value, schema.TypeName);
            if (info.Kind != "component"
                || !model.Fields.TryGetValue(info.Value, out string? dataSetType)
                || !SameType(dataSetType, schema.TypeName))
                return false;
            return TryStringPropertyAssignment(source, bindingSourceId, "DataMember", out string member)
                && string.Equals(member, schema.DataMember, StringComparison.Ordinal);
        }

        private static bool TryStringPropertyAssignment(
            string source,
            string ownerId,
            string propertyName,
            out string value)
        {
            value = "";
            var root = CSharpSyntaxTree.ParseText(source).GetRoot();
            var matches = root.DescendantNodes().OfType<AssignmentExpressionSyntax>()
                .Where(assignment => assignment.Left is MemberAccessExpressionSyntax property
                    && property.Name.Identifier.ValueText == propertyName
                    && property.Expression is MemberAccessExpressionSyntax owner
                    && owner.Name.Identifier.ValueText == ownerId
                    && owner.Expression is ThisExpressionSyntax)
                .Select(assignment => assignment.Right)
                .OfType<LiteralExpressionSyntax>()
                .Where(literal => literal.IsKind(SyntaxKind.StringLiteralExpression))
                .ToList();
            if (matches.Count != 1) return false;
            value = matches[0].Token.ValueText;
            return true;
        }

        private static List<ProjectApplicationSetting> DiscoverSettings(ProjectInfo project)
        {
            string settingsPath = Path.Combine(project.Directory, "Properties", "Settings.settings");
            if (!File.Exists(settingsPath))
                return new List<ProjectApplicationSetting>();
            try
            {
                var doc = XDocument.Load(settingsPath, LoadOptions.None);
                return doc.Descendants()
                    .Where(e => e.Name.LocalName == "Setting")
                    .Select(e =>
                    {
                        string name = e.Attribute("Name")?.Value?.Trim() ?? "";
                        string type = NormalizeType(e.Attribute("Type")?.Value?.Trim() ?? "");
                        string scope = e.Attribute("Scope")?.Value?.Trim() ?? "";
                        if (!DesignerControlEditor.IsValidIdentifier(name) || !ScalarTypes.Contains(NullableInner(type)))
                            return null;
                        return new ProjectApplicationSetting
                        {
                            Key = "setting:" + name + ":" + type,
                            Name = name,
                            TypeName = type,
                            Scope = scope,
                        };
                    })
                    .Where(s => s != null)
                    .Select(s => s!)
                    .GroupBy(s => s.Key, StringComparer.Ordinal)
                    .Where(g => g.Count() == 1)
                    .Select(g => g.Single())
                    .OrderBy(s => s.Name, StringComparer.Ordinal)
                    .ToList();
            }
            catch
            {
                return new List<ProjectApplicationSetting>();
            }
        }

        private static IEnumerable<string> EnumerateProjectSourceFiles(ProjectInfo project)
        {
            int count = 0;
            foreach (var file in project.SourceFiles)
            {
                if (count >= MaxProjectFiles)
                    yield break;
                string full;
                try { full = Path.GetFullPath(file); }
                catch { continue; }
                if (!File.Exists(full) || IsExcludedPath(full, project.Directory) || IsConventionalSettingsDesigner(full, project.Directory))
                    continue;
                count++;
                yield return full;
            }
        }

        private static bool TrySettingBindingProperty(string targetType, string settingType, out string property)
        {
            string simple = ShortTypeName(targetType);
            string type = NullableInner(settingType);
            if (type == "System.Boolean")
            {
                if (simple is "CheckBox" or "RadioButton") { property = "Checked"; return true; }
                if (simple.EndsWith("Control", StringComparison.Ordinal) || simple is "Button" or "Label" or "TextBox" or "Panel" or "GroupBox" or "DataGridView")
                { property = "Enabled"; return true; }
            }
            if (type == "System.String" && simple is "TextBox" or "Label" or "Button" or "GroupBox" or "CheckBox" or "RadioButton")
            {
                property = "Text";
                return true;
            }
            if (type == "System.Decimal" && simple == "NumericUpDown")
            {
                property = "Value";
                return true;
            }
            if (type == "System.DateTime" && simple == "DateTimePicker")
            {
                property = "Value";
                return true;
            }
            property = "";
            return false;
        }

        private static bool HasBindingForProperty(MethodDeclarationSyntax init, string targetId, string property)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv })
                    continue;
                if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.ValueText != "Add")
                    continue;
                var receiver = Flatten(ma.Expression);
                if (receiver.Count != 2 || receiver[0] != targetId || receiver[1] != "DataBindings")
                    continue;
                if (inv.ArgumentList.Arguments.Count == 1
                    && inv.ArgumentList.Arguments[0].Expression is ObjectCreationExpressionSyntax creation
                    && creation.ArgumentList?.Arguments.Count >= 1
                    && creation.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax literal
                    && literal.IsKind(SyntaxKind.StringLiteralExpression)
                    && literal.Token.ValueText == property)
                    return true;
            }
            return false;
        }

        private static bool HasUnsafeTriviaOnTargetBindings(MethodDeclarationSyntax init, string targetId)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv })
                    continue;
                if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.ValueText != "Add")
                    continue;
                var receiver = Flatten(ma.Expression);
                if (receiver.Count == 2 && receiver[0] == targetId && receiver[1] == "DataBindings")
                {
                    if (st.DescendantTrivia(descendIntoTrivia: true).Any(t =>
                        !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia)))
                        return true;
                }
            }
            return false;
        }

        private static List<string> NewColumnIds(IReadOnlyList<GridColumnItem> oldColumns, string edited, string gridId)
        {
            var old = new HashSet<string>(oldColumns.Select(c => c.Id), StringComparer.Ordinal);
            var listed = DesignerGridColumnEditor.ListColumns(edited, gridId);
            return listed.Ok
                ? listed.Columns.Select(c => c.Id).Where(id => !old.Contains(id)).ToList()
                : new List<string>();
        }

        private static bool IsExcludedPath(string fullPath, string root)
        {
            string rel = RelativePath(root, fullPath);
            return rel.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .Any(p => p is "bin" or "obj" or ".git" or ".vs");
        }

        private static bool IsConventionalSettingsDesigner(string fullPath, string root)
        {
            string rel = NormalizeRelativePath(RelativePath(root, fullPath));
            return string.Equals(rel, "Properties/Settings.Designer.cs", StringComparison.OrdinalIgnoreCase);
        }

        private static string RelativePath(string root, string fullPath)
        {
            try
            {
                return Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(fullPath));
            }
            catch
            {
                return fullPath;
            }
        }

        private static string NormalizeRelativePath(string path) =>
            path.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');

        private static string NormalizePathForGlob(string path) =>
            path.Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');

        private static string QualifiedTypeName(TypeDeclarationSyntax type)
        {
            string name = type.Identifier.ValueText;
            for (SyntaxNode? p = type.Parent; p != null; p = p.Parent)
            {
                switch (p)
                {
                    case TypeDeclarationSyntax outer:
                        name = outer.Identifier.ValueText + "." + name;
                        break;
                    case BaseNamespaceDeclarationSyntax ns:
                        name = ns.Name.ToString() + "." + name;
                        break;
                }
            }
            return NormalizeType(name);
        }

        private static bool IsVisibleTopLevel(TypeDeclarationSyntax type) =>
            type.Modifiers.Any(SyntaxKind.PublicKeyword) || type.Modifiers.Any(SyntaxKind.InternalKeyword);

        private static bool IsDesignerBaseType(string value)
        {
            string s = ShortTypeName(value);
            return s is "Form" or "UserControl" or "Control" or "Component" or "ContainerControl";
        }

        private static string NormalizeType(string value)
        {
            value = value.Trim();
            if (value.StartsWith("global::", StringComparison.Ordinal))
                value = value.Substring("global::".Length);
            if (value.EndsWith("?", StringComparison.Ordinal))
                value = NormalizeType(value.Substring(0, value.Length - 1)) + "?";
            return ScalarAliases.TryGetValue(value, out var mapped) ? mapped : value;
        }

        private static string NullableInner(string value) =>
            value.EndsWith("?", StringComparison.Ordinal) ? value.Substring(0, value.Length - 1) : value;

        private static string KindOf(string type)
        {
            type = NullableInner(type);
            if (type == "System.Boolean") return "boolean";
            if (type == "System.DateTime" || type == "System.DateTimeOffset") return "date";
            if (IsNumeric(type)) return "number";
            return "text";
        }

        private static bool IsNumeric(string type)
        {
            type = NullableInner(type);
            return type is "System.Byte" or "System.SByte" or "System.Int16" or "System.UInt16"
                or "System.Int32" or "System.UInt32" or "System.Int64" or "System.UInt64"
                or "System.Single" or "System.Double" or "System.Decimal";
        }

        private static string EditorType(string type) =>
            NullableInner(type) switch
            {
                "System.Boolean" => "System.Windows.Forms.CheckBox",
                "System.DateTime" => "System.Windows.Forms.DateTimePicker",
                "System.Decimal" => "System.Windows.Forms.NumericUpDown",
                "System.Byte" or "System.SByte" or "System.Int16" or "System.UInt16" or "System.Int32"
                    or "System.UInt32" or "System.Int64" or "System.UInt64" or "System.Single"
                    or "System.Double" => "System.Windows.Forms.TextBox",
                _ => "System.Windows.Forms.TextBox",
            };

        private static IEnumerable<string> ReadOnlyEditorStatements(string editorId, string type)
        {
            string simple = ShortTypeName(EditorType(type));
            if (simple == "TextBox")
                return new[] { "this." + editorId + ".ReadOnly = true;" };
            return new[] { "this." + editorId + ".Enabled = false;" };
        }

        private static string EditorSuffix(string type) =>
            ShortTypeName(EditorType(type)) switch
            {
                "CheckBox" => "CheckBox",
                "DateTimePicker" => "DateTimePicker",
                "NumericUpDown" => "NumericUpDown",
                _ => "TextBox",
            };

        private static string BoundPropertyForType(string type) =>
            ShortTypeName(EditorType(type)) switch
            {
                "CheckBox" => "Checked",
                "DateTimePicker" => "Value",
                "NumericUpDown" => "Value",
                _ => "Text",
            };

        private static int EditorWidth(string type) =>
            NullableInner(type) switch
            {
                "System.Boolean" => 104,
                "System.DateTime" => 200,
                _ => 180,
            };

        private static int DefaultColumnWidth(string type) =>
            NullableInner(type) switch
            {
                "System.String" => 160,
                "System.DateTime" => 120,
                "System.Boolean" => 70,
                _ when IsNumeric(type) => 90,
                _ => 120,
            };

        private static string ParentControlsAdd(string parentId, string childId) =>
            (parentId is "" or "this" ? "this" : "this." + parentId) + ".Controls.Add(this." + childId + ");";

        private static string BindingSourceCtorArgs(DesignerModel model) =>
            model.Fields.ContainsKey("components") ? "(this.components)" : "()";

        private static string FieldDecl(string type, string id) => "private " + type + " " + id + ";";

        private static string ToCamel(string value)
        {
            string cleaned = new(value.Where(char.IsLetterOrDigit).ToArray());
            if (string.IsNullOrEmpty(cleaned))
                cleaned = "data";
            cleaned = char.ToLowerInvariant(cleaned[0]) + cleaned.Substring(1);
            return DesignerControlEditor.IsValidIdentifier(cleaned) ? cleaned : "data";
        }

        private static string ShortTypeName(string value)
        {
            string s = value.Replace("global::", "", StringComparison.Ordinal);
            if (s.EndsWith("?", StringComparison.Ordinal))
                s = s.Substring(0, s.Length - 1);
            int dot = s.LastIndexOf('.');
            return dot >= 0 ? s.Substring(dot + 1) : s;
        }

        private static bool SameType(string a, string b) =>
            string.Equals(NormalizeType(a), NormalizeType(b), StringComparison.Ordinal)
            || string.Equals(ShortTypeName(a), ShortTypeName(b), StringComparison.Ordinal);

        private static string? NormalizeOptional(string? value) =>
            string.IsNullOrWhiteSpace(value) ? null : value.Trim();

        private static string NewLine(string s) => s.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

        private static string SafeRead(string path)
        {
            try { return File.ReadAllText(path); }
            catch { return ""; }
        }

        private static bool MultisetContains(List<string> superset, List<string> subset)
        {
            var counts = Counter(superset);
            foreach (var item in subset)
            {
                if (!counts.TryGetValue(item, out int count) || count == 0)
                    return false;
                counts[item] = count - 1;
            }
            return true;
        }

        private static Dictionary<string, int> Counter(IEnumerable<string> values)
        {
            var result = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var value in values)
                result[value] = result.TryGetValue(value, out int n) ? n + 1 : 1;
            return result;
        }

        private static string Normalize(string value) => new(value.Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static HashSet<string> FieldNames(ClassDeclarationSyntax cls)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fd in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in fd.Declaration.Variables)
                    set.Add(v.Identifier.ValueText);
            return set;
        }

        private static List<string> Flatten(ExpressionSyntax expression)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax node)
            {
                switch (node)
                {
                    case MemberAccessExpressionSyntax member:
                        Walk(member.Expression);
                        names.Add(member.Name.Identifier.ValueText);
                        break;
                    case ThisExpressionSyntax:
                        break;
                    case IdentifierNameSyntax identifier:
                        names.Add(identifier.Identifier.ValueText);
                        break;
                    case ParenthesizedExpressionSyntax parenthesized:
                        Walk(parenthesized.Expression);
                        break;
                    default:
                        names.Add("?" + node.Kind());
                        break;
                }
            }
            Walk(expression);
            return names;
        }

        private sealed class EditPlan
        {
            public bool Safe => true;
            public List<string> CreatedIds { get; } = new();
            public List<string> Fields { get; } = new();
            public List<(int Pos, IEnumerable<string> Statements)> StatementBlocks { get; } = new();
        }

        private sealed class DesignerModel
        {
            public required ClassDeclarationSyntax Class { get; init; }
            public required MethodDeclarationSyntax Init { get; init; }
            public required string Source { get; init; }
            public required Dictionary<string, string> Fields { get; init; }
            public required string Indent { get; init; }
            public required string FieldIndent { get; init; }
            public required int CtorAnchor { get; init; }
            public required int FieldAnchor { get; init; }

            private static readonly HashSet<string> DirectAddContainers = new(StringComparer.Ordinal)
            {
                "Panel", "GroupBox", "FlowLayoutPanel", "TabPage", "UserControl",
                "ContainerControl", "ScrollableControl", "SplitterPanel", "ToolStripContentPanel", "ToolStripPanel",
            };

            public static DesignerModel? TryCreate(string source, out string reason)
            {
                reason = "";
                var root = CSharpSyntaxTree.ParseText(source).GetRoot();
                var cls = FormClassResolver.FormClass(root);
                var init = FormClassResolver.InitMethodOf(cls);
                if (cls == null || init?.Body == null)
                {
                    reason = "InitializeComponent not found or ambiguous";
                    return null;
                }
                if (root.ContainsDiagnostics)
                {
                    reason = "designer source has syntax errors";
                    return null;
                }
                var fields = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var part in FormClassResolver.PartialsOf(cls))
                    foreach (var fd in part.Members.OfType<FieldDeclarationSyntax>())
                        foreach (var v in fd.Declaration.Variables)
                            fields[v.Identifier.ValueText] = fd.Declaration.Type.ToString();

                return new DesignerModel
                {
                    Class = cls,
                    Init = init,
                    Source = source,
                    Fields = fields,
                    Indent = StatementIndent(source, init),
                    FieldIndent = FieldIndentOf(source, cls),
                    CtorAnchor = CtorAnchorOf(source, init, fields.Keys.ToHashSet(StringComparer.Ordinal)),
                    FieldAnchor = FieldAnchorOf(source, cls),
                };
            }

            public bool IsRootOrField(string id) => id is "" or "this" || Fields.ContainsKey(id);

            public bool IsSupportedContainer(string id)
            {
                if (id is "" or "this")
                    return true;
                return Fields.TryGetValue(id, out var typeName) && DirectAddContainers.Contains(ShortTypeName(typeName));
            }

            public string UniqueName(string baseName, IEnumerable<string>? extra = null)
            {
                var used = new HashSet<string>(Fields.Keys, StringComparer.OrdinalIgnoreCase);
                if (extra != null)
                    used.UnionWith(extra);
                for (int i = 1; i < 100000; i++)
                {
                    string candidate = baseName + i.ToString(CultureInfo.InvariantCulture);
                    if (!used.Contains(candidate) && DesignerControlEditor.IsValidIdentifier(candidate))
                        return candidate;
                }
                return baseName + "_x";
            }

            public int PropertyAnchor(string parentId)
            {
                var last = Init.Body!.Statements.LastOrDefault(s => !IsLayoutCall(s));
                return last == null ? FirstBodyLinePos(Source, Init) : LineEndOf(Source, last);
            }

            public int AddAnchor(string parentId) => PropertyAnchor(parentId);

            public int AnchorAfterOwner(string ownerId)
            {
                var statements = Init.Body!.Statements.ToList();
                for (int i = statements.Count - 1; i >= 0; i--)
                {
                    if (StatementTargetsOwner(statements[i], ownerId))
                        return LineEndOf(Source, statements[i]);
                }
                var last = statements.LastOrDefault(s => !IsLayoutCall(s));
                return last == null ? FirstBodyLinePos(Source, Init) : LineEndOf(Source, last);
            }
        }

        private sealed class ProjectInfo
        {
            public required string CsprojPath { get; init; }
            public required string Directory { get; init; }
            public required List<string> SourceFiles { get; init; }
            public required string SettingsNamespace { get; init; }

            public static ProjectInfo? FromDesigner(string designerFilePath)
            {
                string? csproj = ProjectResolver.FindCsproj(designerFilePath);
                if (csproj == null)
                    return null;
                string projectDir = System.IO.Path.GetDirectoryName(csproj)!;
                var sourceFiles = new List<string>();
                string rootNamespace = "";
                try
                {
                    var doc = XDocument.Load(csproj);
                    rootNamespace = doc.Descendants()
                        .FirstOrDefault(e => e.Name.LocalName == "RootNamespace")?.Value?.Trim() ?? "";
                    sourceFiles = BuildCompileSourceFiles(projectDir, doc).ToList();
                }
                catch { }
                return new ProjectInfo
                {
                    CsprojPath = csproj,
                    Directory = projectDir,
                    SourceFiles = sourceFiles,
                    SettingsNamespace = SettingsNamespaceFromDesigner(csproj) ?? rootNamespace,
                };
            }

            private static IEnumerable<string> BuildCompileSourceFiles(string projectDir, XDocument doc)
            {
                bool defaultCompileItems = IsSdkStyleProject(doc);
                var unconditionalIncludes = new List<string>();
                var unconditionalRemoves = new List<string>();
                var conditionalRemoves = new List<string>();
                bool projectConditional = HasCondition(doc.Root);

                foreach (var propertyGroup in doc.Descendants().Where(e => e.Name.LocalName == "PropertyGroup"))
                {
                    var setting = propertyGroup.Elements()
                        .LastOrDefault(e => e.Name.LocalName == "EnableDefaultCompileItems");
                    if (setting == null)
                        continue;
                    if (projectConditional || HasCondition(propertyGroup) || HasCondition(setting))
                    {
                        defaultCompileItems = false;
                        continue;
                    }
                    string value = setting.Value.Trim();
                    if (bool.TryParse(value, out var parsed))
                        defaultCompileItems = parsed;
                    else
                        defaultCompileItems = false;
                }

                foreach (var itemGroup in doc.Descendants().Where(e => e.Name.LocalName == "ItemGroup"))
                {
                    bool groupConditional = projectConditional || HasCondition(itemGroup);
                    foreach (var item in itemGroup.Elements().Where(e => e.Name.LocalName == "Compile"))
                    {
                        bool itemConditional = groupConditional || HasCondition(item);
                        string? include = item.Attribute("Include")?.Value;
                        if (!string.IsNullOrWhiteSpace(include) && !itemConditional)
                            unconditionalIncludes.AddRange(SplitItemPatterns(include));

                        string? remove = item.Attribute("Remove")?.Value;
                        if (!string.IsNullOrWhiteSpace(remove))
                        {
                            var target = itemConditional ? conditionalRemoves : unconditionalRemoves;
                            target.AddRange(SplitItemPatterns(remove));
                        }
                    }
                }

                var files = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
                if (defaultCompileItems)
                {
                    foreach (var file in EnumerateDefaultCompileFiles(projectDir))
                    {
                        if (MatchesAnyProjectPattern(projectDir, file, unconditionalRemoves)
                            || MatchesAnyProjectPattern(projectDir, file, conditionalRemoves))
                            continue;
                        files.Add(file);
                    }
                }

                foreach (var pattern in unconditionalIncludes)
                {
                    foreach (var file in ExpandCompilePattern(projectDir, pattern))
                    {
                        if (MatchesAnyProjectPattern(projectDir, file, unconditionalRemoves)
                            || MatchesAnyProjectPattern(projectDir, file, conditionalRemoves))
                            continue;
                        files.Add(file);
                    }
                }

                return files.Take(MaxProjectFiles);
            }

            private static bool IsSdkStyleProject(XDocument doc)
            {
                if (!string.IsNullOrWhiteSpace(doc.Root?.Attribute("Sdk")?.Value))
                    return true;
                return doc.Descendants().Any(e =>
                    string.Equals(e.Name.LocalName, "Import", StringComparison.Ordinal)
                    && !string.IsNullOrWhiteSpace(e.Attribute("Sdk")?.Value));
            }

            private static bool HasCondition(XElement? element) =>
                !string.IsNullOrWhiteSpace(element?.Attribute("Condition")?.Value);

            private static IEnumerable<string> SplitItemPatterns(string value) =>
                value.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(p => p.Trim())
                    .Where(p => p.Length > 0);

            private static IEnumerable<string> EnumerateDefaultCompileFiles(string projectDir)
            {
                IEnumerable<string> files;
                try { files = System.IO.Directory.EnumerateFiles(projectDir, "*.cs", SearchOption.AllDirectories); }
                catch { yield break; }
                foreach (var file in files)
                {
                    string full;
                    try { full = System.IO.Path.GetFullPath(file); }
                    catch { continue; }
                    if (IsExcludedPath(full, projectDir) || IsConventionalSettingsDesigner(full, projectDir))
                        continue;
                    yield return full;
                }
            }

            private static IEnumerable<string> ExpandCompilePattern(string projectDir, string pattern)
            {
                if (string.IsNullOrWhiteSpace(pattern))
                    yield break;
                string normalized = pattern.Replace('/', System.IO.Path.DirectorySeparatorChar);
                if (!HasWildcard(normalized))
                {
                    string full;
                    try
                    {
                        full = System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(normalized)
                            ? normalized
                            : System.IO.Path.Combine(projectDir, normalized));
                    }
                    catch { yield break; }
                    if (IsCandidateCompileFile(full, projectDir))
                        yield return full;
                    yield break;
                }

                string? baseDir = CompilePatternBaseDirectory(projectDir, normalized);
                if (baseDir == null || !System.IO.Directory.Exists(baseDir))
                    yield break;

                IEnumerable<string> files;
                try { files = System.IO.Directory.EnumerateFiles(baseDir, "*.cs", SearchOption.AllDirectories); }
                catch { yield break; }
                int count = 0;
                foreach (var file in files)
                {
                    if (count >= MaxProjectFiles)
                        yield break;
                    string full;
                    try { full = System.IO.Path.GetFullPath(file); }
                    catch { continue; }
                    if (!IsCandidateCompileFile(full, projectDir) || !MatchesProjectPattern(projectDir, full, pattern))
                        continue;
                    count++;
                    yield return full;
                }
            }

            private static bool IsCandidateCompileFile(string full, string projectDir)
            {
                return string.Equals(System.IO.Path.GetExtension(full), ".cs", StringComparison.OrdinalIgnoreCase)
                    && File.Exists(full)
                    && !IsExcludedPath(full, projectDir)
                    && !IsConventionalSettingsDesigner(full, projectDir);
            }

            private static string? CompilePatternBaseDirectory(string projectDir, string pattern)
            {
                int firstWildcard = pattern.IndexOfAny(new[] { '*', '?' });
                if (firstWildcard < 0)
                    return projectDir;
                int sep = pattern.LastIndexOfAny(new[] { System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar }, firstWildcard);
                string basePart = sep >= 0 ? pattern.Substring(0, sep) : "";
                try
                {
                    return System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(basePart)
                        ? basePart
                        : System.IO.Path.Combine(projectDir, basePart));
                }
                catch
                {
                    return null;
                }
            }

            private static bool HasWildcard(string pattern) =>
                pattern.IndexOfAny(new[] { '*', '?' }) >= 0;

            private static bool MatchesAnyProjectPattern(string projectDir, string fullPath, IEnumerable<string> patterns) =>
                patterns.Any(pattern => MatchesProjectPattern(projectDir, fullPath, pattern));

            private static bool MatchesProjectPattern(string projectDir, string fullPath, string pattern)
            {
                string absolutePattern;
                try
                {
                    string normalizedPattern = pattern.Replace('/', System.IO.Path.DirectorySeparatorChar);
                    absolutePattern = System.IO.Path.GetFullPath(System.IO.Path.IsPathRooted(normalizedPattern)
                        ? normalizedPattern
                        : System.IO.Path.Combine(projectDir, normalizedPattern));
                }
                catch
                {
                    return true;
                }
                string candidate;
                try { candidate = System.IO.Path.GetFullPath(fullPath); }
                catch { return true; }
                return Regex.IsMatch(NormalizePathForGlob(candidate), GlobRegex(NormalizePathForGlob(absolutePattern)), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            }

            private static string GlobRegex(string pattern)
            {
                var sb = new StringBuilder("^");
                for (int i = 0; i < pattern.Length; i++)
                {
                    char c = pattern[i];
                    if (c == '*')
                    {
                        if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                        {
                            i++;
                            if (i + 1 < pattern.Length && pattern[i + 1] == '/')
                            {
                                sb.Append("(?:.*/)?");
                                i++;
                            }
                            else
                            {
                                sb.Append(".*");
                            }
                        }
                        else
                        {
                            sb.Append("[^/]*");
                        }
                    }
                    else if (c == '?')
                    {
                        sb.Append("[^/]");
                    }
                    else
                    {
                        sb.Append(Regex.Escape(c.ToString()));
                    }
                }
                sb.Append("$");
                return sb.ToString();
            }

            private static string? SettingsNamespaceFromDesigner(string csproj)
            {
                string path = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(csproj)!, "Properties", "Settings.Designer.cs");
                if (!File.Exists(path))
                    return null;
                string text = SafeRead(path);
                if (text.Length == 0 || text.Length > MaxSourceBytes)
                    return null;
                var root = CSharpSyntaxTree.ParseText(text).GetRoot();
                if (root.ContainsDiagnostics)
                    return null;
                var cls = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
                    .FirstOrDefault(c => c.Identifier.ValueText == "Settings");
                if (cls == null)
                    return null;
                for (SyntaxNode? p = cls.Parent; p != null; p = p.Parent)
                    if (p is BaseNamespaceDeclarationSyntax ns)
                    {
                        string full = ns.Name.ToString();
                        return full.EndsWith(".Properties", StringComparison.Ordinal)
                            ? full.Substring(0, full.Length - ".Properties".Length)
                            : null;
                    }
                return null;
            }
        }

        private static string StatementIndent(string src, MethodDeclarationSyntax init)
        {
            var first = init.Body!.Statements.FirstOrDefault();
            if (first != null)
                return LeadingIndent(src, first.SpanStart);
            return LeadingIndent(src, init.SpanStart) + "    ";
        }

        private static string FieldIndentOf(string src, ClassDeclarationSyntax cls)
        {
            var field = cls.Members.OfType<FieldDeclarationSyntax>().LastOrDefault();
            if (field != null)
                return LeadingIndent(src, field.SpanStart);
            var member = cls.Members.FirstOrDefault();
            return member == null ? LeadingIndent(src, cls.SpanStart) + "    " : LeadingIndent(src, member.SpanStart);
        }

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t'))
                i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static int CtorAnchorOf(string src, MethodDeclarationSyntax init, HashSet<string> fields)
        {
            StatementSyntax? lastCtor = null;
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment }
                    || assignment.Right is not ObjectCreationExpressionSyntax)
                    break;
                var left = Flatten(assignment.Left);
                if (left.Count != 1 || !fields.Contains(left[0]))
                    break;
                lastCtor = st;
            }
            return lastCtor == null ? FirstBodyLinePos(src, init) : LineEndOf(src, lastCtor);
        }

        private static int FieldAnchorOf(string src, ClassDeclarationSyntax cls)
        {
            var fields = cls.Members.OfType<FieldDeclarationSyntax>().ToList();
            if (fields.Count == 0)
                return src.LastIndexOf('\n', Math.Max(0, cls.CloseBraceToken.SpanStart - 1)) + 1;
            var last = fields[fields.Count - 1];
            int nl = src.IndexOf('\n', last.Span.End);
            return nl < 0 ? src.Length : nl + 1;
        }

        private static int FirstBodyLinePos(string src, MethodDeclarationSyntax init)
        {
            int open = init.Body!.OpenBraceToken.Span.End;
            int nl = src.IndexOf('\n', open);
            return nl < 0 ? open : nl + 1;
        }

        private static int LineEndOf(string src, SyntaxNode node)
        {
            int nl = src.IndexOf('\n', node.Span.End);
            return nl < 0 ? src.Length : nl + 1;
        }

        private static bool IsLayoutCall(StatementSyntax st)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv })
                return false;
            string? name = inv.Expression switch
            {
                MemberAccessExpressionSyntax ma => ma.Name.Identifier.ValueText,
                IdentifierNameSyntax id => id.Identifier.ValueText,
                _ => null,
            };
            return name is "SuspendLayout" or "ResumeLayout" or "PerformLayout";
        }

        private static bool StatementTargetsOwner(StatementSyntax st, string ownerId)
        {
            if (st is not ExpressionStatementSyntax es)
                return false;
            ExpressionSyntax? target = es.Expression switch
            {
                AssignmentExpressionSyntax a => a.Left,
                InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } => ma.Expression,
                _ => null,
            };
            if (target == null)
                return false;
            var chain = Flatten(target);
            return chain.Count > 0 && chain[0] == ownerId;
        }

        private static DataSourcesResult FailList(string reason, string? refusalCode = null) =>
            new() { Ok = false, Reason = reason, RefusalCode = refusalCode };

        private static DataSourceGenerationResult FailEdit(
            string reason,
            IEnumerable<string>? createdIds = null,
            string? refusalCode = null) =>
            new()
            {
                Safe = false,
                Reason = reason,
                CreatedIds = (createdIds ?? Array.Empty<string>()).ToList(),
                RefusalCode = refusalCode,
            };

        private static DataSourceGenerationResult Succeed(string text, IEnumerable<string> createdIds) =>
            new() { Safe = true, NewText = text, Text = text, CreatedIds = createdIds.ToList() };
    }
}
