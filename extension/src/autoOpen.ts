export interface AutoOpenContext {
  /** Scheme of the document that just became active ("file", "git", "untitled", …). */
  scheme: string;
  /** That document's URI, stringified. */
  uri: string;
  /**
   * Every URI shown by an ACTIVE comparison tab: a diff's two sides, or a merge editor's base / both inputs /
   * result. Only active tabs count — a comparison sitting in a background tab says nothing about what the user is
   * looking at now.
   */
  comparisonUris: readonly string[];
}

/**
 * True when the designer must NOT take this editor over on its own.
 *
 * The designer auto-opens when the user lands on a form's `.cs`, which is right for an ordinary editor and wrong
 * everywhere else. Opening a DIFF (Source Control, "Compare With…", file history) or a 3-way MERGE makes VS Code
 * activate a text editor for one side of the comparison; auto-open then replaced the comparison the user had just
 * asked for with a form preview. Reviewing or resolving a change is not a request to edit it.
 *
 * Two independent signals, because either alone leaves a hole:
 *  - a non-`file` scheme covers the left-hand side of a diff (`git:`, `gitlens:`, `svn:`, `conflictResolution:` …)
 *    and every other virtual document (`untitled:`, `output:`, `vscode-userdata:`);
 *  - the modified side of a diff, and a merge editor's result pane, are perfectly normal `file:` URIs and are only
 *    recognizable from the TAB — a comparison tab rather than a plain text tab.
 *
 * Ambiguity resolves toward NOT auto-opening: the cost is one click on "Open Designer", while the opposite mistake
 * throws away the comparison the user was reading.
 */
export function shouldSuppressAutoOpen(context: AutoOpenContext): boolean {
  if (context.scheme !== 'file') return true;
  return context.comparisonUris.includes(context.uri);
}
