import type { Catalog } from './index';

/**
 * English is the SOURCE-OF-TRUTH runtime catalog (Layer B). Values here MUST equal the strings currently
 * hardcoded in the UI so that with the default `en` locale behaviour is byte-identical to before i18n.
 * Other languages (ru/zh-cn/fr/de/es) are JSON files with the SAME keys; a missing key falls back to en,
 * then to the key itself. Keys are dot-namespaced by surface.
 *
 * DO-NOT-TRANSLATE tokens that may appear in values (translators keep them verbatim): VS Code codicons
 * ($(project), $(file-binary), $(clear-all), $(package), $(lock)), keyboard accelerators in parentheses
 * (Ctrl+-, Ctrl+0, Ctrl+=), C# API names (TabIndex, OnPaint, Controls.Add), product/framework names
 * (.NET, .NET Framework, COM, WPF, WinForms, DevExpress), enum values that double as syntax (Bold, Italic),
 * glyphs (Δ, ×, ●, →), file extensions (.cs, .Designer.cs, .csproj, .dll, .resx), and {placeholder} slots.
 * Pluralized entries are objects keyed by CLDR category; `{n}` is the count.
 */
export const en: Catalog = {
  // ---------- shared ----------
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.reset': 'Reset',
  'common.clear': 'Clear',
  'common.none': '(none)',

  // count units (reused where two independent plurals share one sentence)
  'unit.items': { one: '{n} item', other: '{n} items' },
  'unit.assemblies': { one: '{n} assembly', other: '{n} assemblies' },

  // ---------- language-change prompt (host) ----------
  'config.language.reloadPrompt': 'WinForms Designer language changed. Reload the window to apply it everywhere.',
  'config.language.reloadButton': 'Reload Window',

  // ---------- placeholder view (no .Designer.cs partner) — static HTML, no webview script ----------
  'placeholder.noDesigner': 'No WinForms designer for {name}',
  'placeholder.needsDesignerCs': 'The designer view needs a generated <code>{base}.Designer.cs</code> next to this file.',
  'placeholder.openAsCode': "Open a form's <code>.cs</code> that has a <code>.Designer.cs</code> partner, or reopen this file as code.",

  // ---------- "Choose Toolbox Items" dialog chrome (host-built HTML) ----------
  'chooseItems.tab.net': '.NET Framework Components',
  'chooseItems.tab.com': 'COM Components',
  'chooseItems.tab.wpf': 'WPF Components',
  'chooseItems.loading': 'Loading items…',
  'chooseItems.scanning': 'scanning assemblies…',
  'chooseItems.filter': 'Filter:',
  'chooseItems.browse': 'Browse…',
  'chooseItems.selectHint': 'Select an item to see details.',

  // ---------- "Choose Toolbox Items" dialog body (chooseItems.js) ----------
  'chooseItems.status.tabTarget': 'Adding to tab: {tab}',
  'chooseItems.status.noTab': 'Tip: open Choose Items from a custom toolbox tab to add there',
  'chooseItems.notImpl': '{kind} — not yet implemented. Scanning of registered components is a later increment.',
  'chooseItems.noMatching': 'No matching components.',
  'chooseItems.col.name': 'Name',
  'chooseItems.col.namespace': 'Namespace',
  'chooseItems.col.assembly': 'Assembly Name',
  'chooseItems.col.version': 'Version',
  'chooseItems.col.directory': 'Directory',
  'chooseItems.project': '(project)',
  'chooseItems.details.language': 'Language: Invariant Language (Invariant Country)',
  'chooseItems.details.version': 'Version: {version}',
  'chooseItems.scanningSelected': 'scanning selected assembly…',
  'chooseItems.assembliesFallback': 'assemblies…',

  // ---------- designer canvas toolbar — tooltips (title=) + JS-untouched button faces (host-built HTML) ----------
  'designer.zoom.out': 'Zoom out (Ctrl+-)',
  'designer.zoom.reset': 'Reset to 100% (Ctrl+0)',
  'designer.zoom.in': 'Zoom in (Ctrl+=)',
  'designer.zoom.fit': 'Fit the form to the view',
  'designer.zoom.fitBtn': 'Fit',
  'designer.align.group': 'Arrange the selected controls relative to the primary selection',
  'designer.align.left': 'Align lefts',
  'designer.align.right': 'Align rights',
  'designer.align.top': 'Align tops',
  'designer.align.bottom': 'Align bottoms',
  'designer.align.centerH': 'Align horizontal centers',
  'designer.align.centerV': 'Align vertical centers',
  'designer.distribute.h': 'Distribute horizontally — equalize the gaps (needs 3+)',
  'designer.distribute.v': 'Distribute vertically — equalize the gaps (needs 3+)',
  'designer.same.width': 'Make same width as the primary selection',
  'designer.same.height': 'Make same height as the primary selection',
  'designer.same.size': 'Make same size as the primary selection',
  'designer.center.group': 'Center the selection within its container',
  'designer.center.h': 'Center horizontally in the container',
  'designer.center.v': 'Center vertically in the container',
  'designer.tabOrder.tip': 'Toggle tab-order editing: click controls in order to renumber TabIndex',
  'designer.tabOrder.btn': 'Tab Order',
  'designer.ruler.tip': 'Show/hide the pixel ruler',
  'designer.dirty.tip': 'Unsaved designer changes',

  // ---------- designer canvas webview (designer.js) — overlay / status / selection / context menu ----------
  'designer.overlay.loading': 'Loading designer…',
  'designer.overlay.noscript': ' — (JavaScript is DISABLED in this webview)',
  'designer.overlay.initializing': 'Initializing…',
  'designer.overlay.error': 'Webview error: {message}',
  'designer.overlay.designerError': 'Designer error:\n{message}',
  // T2.2 partial-render / failure diagnostics banner
  'designer.diag.skipped': { one: '{n} construct skipped from this designer', other: '{n} constructs skipped from this designer' },
  'designer.diag.details': 'Show details',
  'designer.diag.hide': 'Hide details',
  'designer.diag.dismiss': 'Dismiss',
  'designer.diag.more': '+{n} more',
  'designer.diag.stalePreview': 'Render failed — still showing the last form that rendered. {message}',
  'designer.diag.cat.missingType': 'Missing type:',
  'designer.diag.cat.initError': 'Init error:',
  'designer.diag.cat.unsupported': 'Unsupported:',
  // 0.10.0 trust-floor — persistent read-only notice for a [Localizable(true)] form.
  'designer.notice.localizable': 'Localizable form — read-only. Edits would diverge from the .resx, so the designer won’t change this form. Inherited resource values aren’t drawn by the built-in modern .NET renderer.',
  // 0.10.0 trust-floor — persistent notice when the form's real base is an inherited/vendor type the .NET preview
  // can't reproduce (modern-engine-only; {base} is the base type name). Best-effort preview drops the base's controls.
  'designer.notice.inheritedBase': 'This rendering is incomplete — the form inherits from {base}, which the built-in modern .NET renderer can’t load, so controls the base defines aren’t drawn. Point the designer at your built .NET Framework assembly to render the real type.',
  // 0.10.0 trust-floor — persistent notice when the sibling .resx holds binary/ImageStream resources the .NET
  // preview can't render (modern-engine-only; {n} is the count). They're preserved on disk; the designer won't regenerate it.
  'designer.notice.binaryResx': 'This rendering is incomplete — the form has {n} binary/ImageStream resource(s) the built-in modern .NET renderer can’t draw. They are preserved in the .resx; the designer won’t regenerate it.',
  // 1.0.0 — UNCONDITIONAL, always-visible disclosure on every .NET Framework (net48) render. The
  // net48 engine renders a compiled INSTANCE of the last build, never the live source text, and cannot prove the two
  // match. This is NOT a lock: net48 forms stay editable, and source safety comes from the byte-local firewall. It is
  // an honest statement of what the canvas is. Independent of dirty/save/build identity/route — purely engine-derived.
  'designer.notice.compiledPreview': '.NET Framework compiled preview — this canvas is based on your last build and may not match .Designer.cs. Live updates are best-effort; rebuild for the authoritative picture. Editing stays enabled and your source edits stay byte-local.',
  // Same disclosure, strengthened when the buffer has unsaved source changes.
  'designer.notice.compiledPreviewDirty': '.NET Framework compiled preview — this canvas is based on your last build and may not yet reflect all your unsaved changes. Some edits appear only after you rebuild. Editing stays enabled and your source edits stay byte-local.',
  // 1.0.0 — {diag} fallback for a net48 live op whose source committed but the compiled instance didn't reflect it
  // (an unconvertible value, a component the preview won't mutate, or a reconcile miss). Substituted into
  // status.previewPartial. Honest, not restrictive: the edit is in the source and appears after a rebuild.
  'designer.notice.liveNotReflected': 'the preview couldn’t apply it live',
  // 1.0.0 — {diag} fallback for a ToolStrip/MenuStrip reconcile the host couldn't resolve. Was a hardcoded English
  // literal sitting inside the (now fully translated) status.previewPartial frame, so a non-English user got an
  // English clause in their own sentence.
  'designer.notice.stripItemsAwaitingRebuild': 'menu items were edited in the source',
  'designer.ruler.show': 'Show ruler',
  'designer.ruler.hide': 'Hide ruler',
  'designer.formSuffix': ' (form)',
  'designer.typeHere': 'Type Here',
  'designer.smartTag.title': '{type} Tasks',
  'designer.smartTag.noTasks': 'No common tasks',
  // vendor-declared verbs (DevExpress). The menu is read from the control's own metadata; the actions are this
  // designer's, so a verb with no source-first equivalent is shown inert with the reason rather than silently omitted.
  'designer.smartTag.vendorUnsupported': 'This designer has no equivalent for this command yet — running the control vendor’s own version would change only the preview, never your code.',
  'designer.smartTag.vendorNoTarget': 'Nothing to apply this to right now — switch to the tab page you want to remove.',
  'designer.dirtyBadge': '● unsaved',
  'designer.sel.multi': { one: '{n} control selected', other: '{n} controls selected' },
  'designer.status.distSelectMore': 'select 3+ controls to distribute',
  'designer.status.distOverlap': 'controls overlap — cannot distribute',
  'designer.status.moveGroup': 'move {count} → Δ({dx}, {dy})',
  'designer.status.moveSingle': 'move → ({x}, {y})',
  'designer.status.resize': 'resize → {w} × {h}',
  'designer.status.committing': 'committing…',
  'designer.status.error': 'error: {message}',
  'designer.menu.viewCode': 'View Code',
  'designer.menu.bringToFront': 'Bring to Front',
  'designer.menu.sendToBack': 'Send to Back',
  'designer.menu.alignToGrid': 'Align to Grid',
  'designer.menu.lockControls': 'Lock Controls',
  'designer.menu.allProperties': 'All Properties…',
  'designer.menu.learnMore': 'Learn More Online',
  'designer.menu.selectAncestor': "Select '{name}'",
  'designer.menu.cut': 'Cut',
  'designer.menu.copy': 'Copy',
  'designer.menu.paste': 'Paste',
  'designer.menu.duplicate': 'Duplicate',
  'designer.menu.delete': 'Delete',
  'designer.menu.renameItem': 'Rename',
  'designer.menu.deleteItem': 'Delete Item',
  'designer.menu.addTab': 'Add Tab',
  'designer.menu.deleteTab': 'Delete Tab',
  'designer.menu.deleteTabNamed': 'Delete Tab "{name}"',
  'designer.menu.properties': 'Properties',

  // ---------- side panel (Properties / Outline / Toolbox) — HTML-owned labels (host-built HTML) ----------
  'panel.props.empty': 'Select a control in the WinForms designer to edit its properties.',
  'panel.itemProps.unavailable': 'Item properties are unavailable when rendering from the compiled assembly.',
  'panel.sort.categorized': 'Categorized',
  'panel.sort.alphabetical': 'Alphabetical',
  'panel.tab.props': 'Properties',
  'panel.tab.events': 'Events',
  'panel.search': 'Search…',
  'panel.toolbox.empty': 'Open a WinForms designer to use the toolbox.',
  'panel.toolbox.search': 'Search toolbox…',
  'panel.mainTab.props': 'Properties',
  'panel.mainTab.outline': 'Outline',
  'panel.mainTab.toolbox': 'Toolbox',
  'panel.tbPrompt.title': 'Add Tab',
  'panel.tbPrompt.renameTitle': 'Rename Tab',
  'panel.tbPrompt.input': 'Tab name',

  // ---------- side panel dynamic (panel.js) — toolbox categories (display only; keys stay canonical) ----------
  'panel.cat.allWinforms': 'All Windows Forms',
  'panel.cat.commonControls': 'Common Controls',
  'panel.cat.containers': 'Containers',
  'panel.cat.menusToolbars': 'Menus & Toolbars',
  'panel.cat.components': 'Components',
  'panel.cat.printing': 'Printing',
  'panel.cat.dialogs': 'Dialogs',
  'panel.cat.wpfInterop': 'WPF Interoperability',
  'panel.cat.data': 'Data',
  'panel.cat.projectControls': 'Project Controls',

  // property-grid + toolbox right-click menus
  'panel.menu.reset': 'Reset',
  'panel.menu.paste': 'Paste',
  'panel.menu.listView': 'List View',
  'panel.menu.showAll': 'Show All',
  'panel.menu.chooseItems': 'Choose Items…',
  'panel.menu.sortAlpha': 'Sort Items Alphabetically',
  'panel.menu.resetToolbox': 'Reset Toolbox',
  'panel.menu.addTab': 'Add Tab',
  'panel.menu.deleteTab': 'Delete Tab',
  'panel.menu.renameTab': 'Rename Tab',
  'panel.menu.moveUp': 'Move Up',
  'panel.menu.moveDown': 'Move Down',

  // toolbox empty-states + item tooltips
  'panel.tb.comingSoon': 'coming soon',
  'panel.tb.noItems': 'no items',
  'panel.tb.noMatching': 'no matching controls',
  'panel.tb.item.componentTip': ' — click to add to the component tray',
  'panel.tb.item.controlTip': ' — click to add, or drag onto the form',

  // outline pane
  'panel.outline.aria': 'Designer control hierarchy',
  'panel.outline.empty': 'Render a WinForms designer to see its outline.',
  'panel.tree.formSuffix': ' (form)',

  // property/event grid empty-states + markers
  'panel.grid.notFound': 'component not found',
  'panel.grid.noMatchingProps': 'no matching properties',
  'panel.grid.noProps': 'no properties',
  'panel.grid.noMatchingEvents': 'no matching events',
  'panel.grid.noEvents': 'no events',
  'panel.grid.unset': '(unset)',
  'panel.grid.readOnly': '  (read-only)',

  // property edit hints
  'panel.hint.chooseValue': ' (choose a value)',
  'panel.hint.chooseOrType': ' (choose or type a value)',
  'panel.hint.enum': ' (enum: type the member name)',
  'panel.hint.point': ' (x, y)',
  'panel.hint.size': ' (width, height)',
  'panel.hint.color': ' (name, or R, G, B / A, R, G, B)',
  'panel.hint.rectangle': ' (x, y, width, height)',
  'panel.hint.padding': ' (left, top, right, bottom)',
  'panel.hint.font': ' (name, sizept[, style=Bold, Italic])',

  // property/event search placeholders
  'panel.search.props': 'Search properties…',
  'panel.search.events': 'Search events…',

  // event combo
  'panel.event.handlerTip': 'Type a handler name (new or existing), or clear to unwire',
  'panel.event.wiredTip': '  —  double-click to go to the handler',
  'panel.event.unwiredTip': '  —  double-click to create a handler',

  // visual editors (anchor / dock / color / flags / font / image) + composite sub-row labels
  'panel.anchor.boxTip': 'Anchor — click a bar to tether/untether that edge',
  'panel.dock.zoneTip': 'Dock {side}',
  'panel.dock.noneTip': 'Dock None',
  'panel.color.inputTip': 'Color — a name, "R, G, B" / "A, R, G, B", or pick from the dropdown',
  'panel.color.pickTip': 'Pick a color',
  'panel.color.tab.custom': 'Custom',
  'panel.color.tab.web': 'Web',
  'panel.color.tab.system': 'System',
  'panel.flags.inputTip': 'Flags — click the arrow to toggle members',
  'panel.flags.toggleTip': 'Toggle members',
  'panel.image.import': 'Import…',
  'panel.image.importTip': 'Import an image file into the form’s resources',
  'panel.image.clearTip': 'Clear the image (reset to none)',
  'panel.font.name': 'Name',
  'panel.font.size': 'Size',
  'panel.font.unit': 'Unit',
  'panel.field.all': 'All',
  'panel.field.x': 'X',
  'panel.field.y': 'Y',
  'panel.field.width': 'Width',
  'panel.field.height': 'Height',
  'panel.field.left': 'Left',
  'panel.field.top': 'Top',
  'panel.field.right': 'Right',
  'panel.field.bottom': 'Bottom',
  'panel.field.dock': 'Dock',

  // component "Tasks" flyout (smart-tag-style common-property shortcut)
  'panel.tasks.title': '{type} Tasks',
  'panel.tasks.none': 'No common properties — use All Properties.',
  'panel.tasks.all': 'All Properties…',
  'panel.tasks.tooltip': 'Common tasks for {name}',

  // ---------- host: "Select Control Assembly" quickpick + dialogs + notifications (extension.ts) ----------
  'host.controlSource.title': 'WinForms — control source for this form',
  'host.controlSource.current': 'Current: {name}',
  'host.controlSource.currentAuto': 'Current: auto-detect',
  'host.controlSource.project': '$(project) Use a project (.csproj)…',
  'host.controlSource.browse': '$(file-binary) Browse for a control assembly (.dll)…',
  'host.controlSource.clear': '$(clear-all) Auto-detect (clear the override)',
  'host.dialog.selectAssembly.openLabel': 'Use as control source',
  'host.dialog.selectAssembly.title': "Select the assembly that builds this form's controls",
  'host.dialog.selectProject.title': 'Select the project that provides the controls',
  'host.dialog.selectProject.placeholder': 'Its build output becomes the control source',
  'host.notify.openDesigner.noForm': 'Open a form .cs (with a .Designer.cs partner) to open its designer.',
  'host.notify.selectAssembly.noSession': 'Open a WinForms designer first, then choose its control source.',
  'host.notify.selectProject.notFound': 'No .csproj found in the workspace — use "Browse" to pick a .dll instead.',
  'host.notify.resolveProject.error': 'Could not resolve {name}\'s build output — build the project, or use "Browse" to pick its .dll directly.',
  'host.notify.resolveEngine.error': 'Failed to resolve the project output: {error}',
  'host.notify.controlSource.set': 'Control source: {name}',
  'host.notify.controlSource.cleared': 'Control source cleared — using auto-detection.',
  'host.notify.assemblyPath.missing': 'WinForms: configured assemblyPath was not found — using auto-discovery instead: {path}',
  // 1.0.0 release-for-rebuild — the .NET Framework preview runs the user's compiled form, so it holds that project's
  // build output open (MSB3027) until the last designer using it closes, or this command hands it back.
  'host.notify.releaseAssembly.done': '.NET Framework build output released — you can rebuild the project now. The designer reloads it on its next render.',
  'host.notify.releaseAssembly.none': 'Nothing to release — no .NET Framework designer is holding a build output open.',
  // 1.0.0 — shown when a domain wouldn't unload (or the engine didn't answer), so the whole preview engine was
  // recycled to free the handles the OS way. Still safe to rebuild; the engine restarts on the next render.
  'host.notify.releaseAssembly.recycled': '.NET Framework build output released — the preview engine was restarted to free it. You can rebuild the project now.',
  // 1.0.0 — the preview process would not exit within the deadline, so its file handles may still be held.
  // Do NOT promise a clean rebuild; tell the user the honest fallback.
  'host.notify.releaseAssembly.stuck': 'Couldn’t fully release the .NET Framework build output — the preview engine didn’t stop in time. Close all WinForms designer tabs, or reload the window, before rebuilding.',
  // 1.0.0 — thrown when a net48 render is requested while a prior preview process is still being torn
  // down and hasn't confirmed exit; starting a replacement beside it would re-pin the dll. Reload the window to clear.
  'host.net48.recycleBlocked': 'The .NET Framework preview engine is still shutting down. Reload the window if the designer doesn’t recover on its own.',
  // 1.0.1 — the "Stop the Designer Preview Engine" command: the modern / .NET Framework engine processes stay resident
  // for the whole window session (a closed designer tab does not stop them), so this lets the user shut them down when
  // they're done with the extension. net48 also frees any build output it was holding open. They restart automatically
  // on the next open/render.
  'host.notify.stopEngines.done': 'Designer preview engine stopped — it restarts automatically the next time you open or render a designer.',
  'host.notify.stopEngines.none': 'No designer preview engine is running.',
  // 1.0.2 — the "Restart the Designer Preview Engine" command: stop the resident engine and reload the active designer
  // so a fresh one comes straight back. `pending` covers "stopped, but no designer open to reload — starts on next render".
  'host.notify.restartEngines.done': 'Designer preview engine restarted — the active designer has been reloaded.',
  'host.notify.restartEngines.pending': 'Designer preview engine stopped — it starts fresh the next time you open or render a designer.',

  // ---------- host: control-source status bar (extension.ts) ----------
  'host.statusbar.controls': '$(package) Controls: {name}',
  'host.statusbar.auto': 'auto',
  'host.statusbar.autoSuffix': ' (auto)',
  'host.statusbar.previewBadge': ' · $(package) .NET Framework',
  'host.statusbar.tip.explicit': 'WinForms control source (explicit): {path}',
  'host.statusbar.tip.auto': 'WinForms control source: auto-detected from the project.',
  'host.statusbar.tip.autoResolved': 'WinForms control source (auto-detected): {path}',
  'host.statusbar.tip.clickChange': 'Click to change.',
  'host.statusbar.tip.clickOverride': 'Click to override.',
  // Keep this list honest — it names exactly the ops that DON'T reconcile live. Property edits, drag/resize, add and
  // remove all mirror onto the live instance now; images, table cells and tray components still wait for a rebuild.
  'host.statusbar.tip.previewNote': 'Rendered from your built .NET Framework assembly (the last build). Supported edits — property, drag, add/remove — are mirrored onto the preview best-effort; image import/clear, table-cell edits, new tray components and hand edits to the source appear after you rebuild. Rebuild is the authoritative picture.',

  // ---------- host: designer session notifications / loading (designerEditor.ts) ----------
  'host.error': 'WinForms Designer: {msg}',
  'host.initTimeout': 'WinForms Designer: the designer did not initialize (no "ready" from the webview). Its script may be blocked.',
  'host.unresolved': "This form uses controls that couldn't be loaded ({names}). Select the project or assembly that provides them.",
  'host.unresolved.button': 'Select control source…',
  'host.frameworkUnbuilt': "This form's project targets .NET Framework and hasn't been built yet. Build it so its controls can load, or select the project or assembly that provides them.",
  'host.crossRuntime.offer': "This form uses controls that only load on .NET Framework ({names}). Render it from your built .NET Framework assembly?",
  'host.crossRuntime.switch': 'Use the .NET Framework assembly',
  'host.crossRuntime.unbuilt': "This form uses controls that only load on .NET Framework ({names}), but the project's .NET Framework target isn't built yet. Build it so they can be drawn, or select a control source.",
  'host.addReference': "{asm} isn't referenced by {proj}. Add a reference so the added control compiles?",
  'host.addReference.yes': 'Add reference',
  'host.addReference.no': 'Not now',
  'host.loading.starting': 'Starting engine…',
  'host.loading.restarting': 'Designer engine stopped; restarting in {ms} ms…',
  'host.engineCrashLoop': 'Designer engine repeatedly crashed. Automatic restart paused; reload or edit the form to retry.',
  'host.loading.rendering': 'Rendering…',

  // ---------- canvas status-line messages the host posts to the webview (designerEditor.ts) ----------
  'status.diskChanged': '.Designer.cs changed on disk — keeping your unsaved designer edits',
  'status.saved': 'saved',
  'status.localizableReadonly': 'Localizable form — read-only preview (edits would diverge from the .resx).',
  // 0.10.0 S5 — read-only while the last render failed (the canvas is a stale preview of a form that didn't load).
  'status.renderFailedReadonly': 'Read-only — the last render failed; editing is disabled until the form renders successfully.',
  'status.localizableSaveRefused': 'Localizable form is read-only — this recovered unsaved edit can’t be saved (it would diverge from the .resx). Revert the file to discard it.',
  'status.designerDiskConflict': 'The .Designer.cs changed on disk since it was opened — saving would overwrite that change. Revert the file to take the version on disk (discarding your designer edits), or save a copy elsewhere first.',
  'status.docChanged': 'document changed during edit — try again',
  'status.docChangedImport': 'document changed during import — try again',
  'status.docChangedShort': 'document changed — try again',
  'status.toolboxUpdated': 'toolbox updated ({added} added, {hidden} hidden)',
  'status.nothingMoved': 'nothing moved (layout-managed?)',
  'status.moved': { one: 'moved {n} control — unsaved', other: 'moved {n} controls — unsaved' },
  'status.nothingAligned': 'nothing aligned (layout-managed?)',
  'status.aligned': { one: 'aligned {n} control — unsaved', other: 'aligned {n} controls — unsaved' },
  'status.nothingResized': 'nothing resized (layout-managed?)',
  'status.resized': { one: 'resized {n} control — unsaved', other: 'resized {n} controls — unsaved' },
  'status.removeRejectedNothing': 'remove rejected: nothing removable',
  'status.removeRejected': 'remove rejected: {reason}',
  'status.removedComponent': 'removed {id} — unsaved',
  'status.removed': { one: 'removed {n} control — unsaved', other: 'removed {n} controls — unsaved' },
  'status.enterValue': 'enter a {type} value',
  'status.invalidValue': "'{raw}' is not a valid {type} value",
  'status.cannotEditType': 'cannot edit {type} from the panel yet',
  'status.editRejected': 'edit rejected: {reason}',
  // 0.10.0 S4 — the byte-local firewall refused a persisted edit that would rewrite the file beyond the intended change.
  'status.byteLocalRefused': 'edit refused — it would rewrite the file beyond the intended change (byte-local safety)',
  'status.propSet': 'set {id}.{prop} — unsaved',
  'status.previewPartial': 'Your code was updated, but the view can’t show this change yet ({diag}) — it appears after you rebuild the project.',
  'status.imageTooLarge': 'image is too large (max 16 MB)',
  'status.importRejected': 'import rejected: {reason}',
  // 0.10.0 S3 — fail-closed regenerate guard: the write would have dropped binary/ImageStream resx resources.
  'status.binaryResxRegenRefused': 'import blocked — it would drop {n} binary/ImageStream resource(s) from the .resx (data loss); the .resx was not modified',
  'status.imageImported': 'imported image for {id}.{prop} — unsaved (.resx written)',
  'status.importFailed': 'import failed: {error}',
  // 0.11.0 ImageList editor
  'status.selectImageListFirst': 'Select an ImageList first, then edit its images.',
  'status.imageListUnreadable': 'cannot edit {id} — its current images could not be read safely; editing was refused to avoid dropping them',
  'status.imageListSaved': 'updated {id} — {n} image(s), unsaved (.resx written)',
  'imageList.title': 'Edit images — {id}',
  'imageList.add': 'Add images…',
  'imageList.remove': 'Remove images…',
  'imageList.done': 'Done',
  'imageList.count': { one: '{n} image', other: '{n} images' },
  'status.clearRejected': 'clear rejected: {reason}',
  'status.alreadyNone': '{id}.{prop} is already (none)',
  'status.imageCleared': 'cleared {id}.{prop} — unsaved',
  'status.clearFailed': 'clear failed: {error}',
  'status.resetRejected': 'reset rejected: {reason}',
  'status.alreadyDefault': '{id}.{prop} is already default',
  'status.propReset': 'reset {id}.{prop} — unsaved',
  'status.resetFailed': 'reset failed: {error}',
  'status.cellInteger': '{cell} must be a non-negative integer',
  'status.cellEditRejected': 'cell edit rejected: {reason}',
  'status.cellSet': 'set {id}.{cell} — unsaved',
  'status.cannotSet': "cannot set {prop} to '{value}'",
  'status.saveFailed': 'save failed: {error}',
  'status.noCodeBehindHandler': 'no code-behind .cs to add a handler to',
  'status.cannotOpen': 'cannot open {file}',
  'status.createHandlerRejected': 'create handler rejected: {reason}',
  'status.couldNotWriteStub': 'could not write the handler stub — wiring not added',
  'status.noCodeBehindNav': 'no .cs code-behind to navigate to',
  'status.handlerNotFound': "handler '{handler}' not found in {file}",
  'status.navigateHandler': '→ {handler}',
  'status.wiringRejected': 'wiring rejected: {reason}',
  'status.wired': 'wired {event} → {handler} — unsaved',
  'status.unwired': 'unwired {event} — unsaved',
  'status.addRejected': 'add rejected: {reason}',
  'status.added': 'added {name} — unsaved',
  'status.couldNotAddRef': 'could not add the reference to {file} — add it manually',
  'status.couldNotUpdate': 'could not update {file}',
  'status.referenced': 'referenced {name} in {file}',
  'status.referencedReview': ' — review & save it',
  'status.addedTray': 'added {name} to the tray — unsaved',
  'status.nothingCopied': 'nothing copied (root / container with children / referenced elsewhere)',
  'status.copied': { one: 'copied {n} control', other: 'copied {n} controls' },
  'status.copiedSkipped': ' ({n} skipped)',
  'status.clipboardEmpty': 'clipboard is empty',
  'status.pasteRejected': 'paste rejected',
  'status.pasted': { one: 'pasted {n} control — unsaved', other: 'pasted {n} controls — unsaved' },
  'status.pastedStale': {
    one: 'pasted {n} control — unsaved; preview updates after a rebuild',
    other: 'pasted {n} controls — unsaved; preview updates after a rebuild',
  },
  'status.nothingDuplicated': 'nothing to duplicate (root / container with children / referenced elsewhere)',
  'status.duplicateRejected': 'duplicate rejected',
  'status.duplicated': { one: 'duplicated {n} control — unsaved', other: 'duplicated {n} controls — unsaved' },
  'status.duplicatedStale': {
    one: 'duplicated {n} control — unsaved; preview updates after a rebuild',
    other: 'duplicated {n} controls — unsaved; preview updates after a rebuild',
  },
  'status.alreadyFront': 'already at front',
  'status.alreadyBack': 'already at back',
  'status.broughtFront': 'brought to front — unsaved',
  'status.sentBack': 'sent to back — unsaved',
  'status.renderFailed': 'render failed: {error}',
  'status.browseLoaded': 'Loaded {items} from {asm} (pre-checked — click OK to add them)',
  'status.browseNoComponents': 'No components added.',
  'status.browseNoToolbox': 'no toolbox components',
};
