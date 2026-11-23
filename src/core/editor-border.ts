/**
 * The upper border of the input box in a renamed session (/rename) carries the name,
 * right-aligned: "──── discuss umi ─". The rule before the name fills what the name
 * leaves of the row, so a name nearly as wide as the row keeps one to four rule
 * characters ("─── name ─") or none (" name ─"), and a wider one is cut with an ellipsis
 * (" name… ─", or "─ 名称… ─" where a double-width character does not fit the cut).
 * Claude Code 2.1.330 at 119–121 columns, ASCII and CJK names. The border always starts
 * at the first column; without a rule character it starts with exactly one space, which
 * no draft row (indented by two) or reply row has.
 *
 * Each parser keeps its own pattern for bare rules and for names with five or more rule
 * characters before them; this one adds every other named form.
 */
export const namedEditorBorder = /^(?:\s*─+ | )\S(?:.*\S)? ─+\s*$/u;
