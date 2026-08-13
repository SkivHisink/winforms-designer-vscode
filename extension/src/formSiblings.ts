import * as path from 'path';

/**
 * The generated files that belong to a form, for the "delete the form, delete its parts" flow.
 *
 * A WinForms form is several files that only VS Code's file nesting makes look like one: `Form1.cs`, the generated
 * `Form1.Designer.cs`, its `Form1.resx`, and one `Form1.<culture>.resx` per translated culture. Nesting is display
 * only, so deleting the form left the rest behind as orphans that no longer compile against anything — which is what
 * issue #3 reported for the `.resx`. Visual Studio deletes the whole set, because in its Solution Explorer the set IS
 * the item.
 *
 * Kept free of `vscode` and `fs` so the rule can be tested directly: the caller supplies the directory listing.
 */

/** A culture qualifier as the localization feature writes it: `ru`, `fr-FR`, `ar-SA`, `zh-Hans-CN`. */
const CULTURE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Files that should be deleted together with `deletedFile`, as full paths — empty for anything that is not a form's
 * own `.cs`.
 *
 * Deliberately narrow. Only these are returned, and only when they really exist in `dirEntries`:
 *   • `<name>.Designer.cs` — the generated half;
 *   • `<name>.resx` and `<name>.<culture>.resx` — its resources, including translations.
 * A file whose middle segment is not culture-shaped (`Form1.Backup.resx`) is left alone: it is not something this
 * designer created, and deleting a file the user did not select is only defensible for files that are unusable
 * without the form.
 *
 * @param deletedFile absolute path of the file the user is deleting
 * @param dirEntries file names (not paths) that exist in its directory
 * @param alreadyDeleting file names the same operation already covers — never returned twice
 */
export function formSiblingsToDelete(
  deletedFile: string,
  dirEntries: readonly string[],
  alreadyDeleting: readonly string[] = [],
): string[] {
  const name = path.basename(deletedFile);
  if (!/\.cs$/i.test(name) || /\.Designer\.cs$/i.test(name)) return []; // not a form's own file
  const stem = name.slice(0, -'.cs'.length);
  const dir = path.dirname(deletedFile);

  const skip = new Set(alreadyDeleting.map((f) => path.basename(f).toLowerCase()));
  skip.add(name.toLowerCase());

  const wanted = (entry: string): boolean => {
    const lower = entry.toLowerCase();
    if (lower === `${stem.toLowerCase()}.designer.cs`) return true;
    if (lower === `${stem.toLowerCase()}.resx`) return true;
    // <stem>.<culture>.resx — the localization feature's per-culture resources
    const prefix = `${stem.toLowerCase()}.`;
    if (!lower.startsWith(prefix) || !lower.endsWith('.resx')) return false;
    const middle = entry.slice(prefix.length, entry.length - '.resx'.length);
    return middle.length > 0 && CULTURE.test(middle);
  };

  const out: string[] = [];
  for (const entry of dirEntries) {
    if (skip.has(entry.toLowerCase())) continue;
    if (!wanted(entry)) continue;
    out.push(path.join(dir, entry));
    skip.add(entry.toLowerCase()); // a listing with duplicate casings must not yield the same file twice
  }
  return out;
}
