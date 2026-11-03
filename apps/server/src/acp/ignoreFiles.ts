// The ignore files of the chat's own folder — `.gitignore`, `.cursorignore`
// and whatever else Settings → Built-in agent lists — honoured by the workspace
// walk behind `fs/glob` and `fs/search`. A `.NET` `bin/`, a `dist/` pile or a
// log folder then costs a turn nothing to walk past, and a path the model names
// itself stays reachable, exactly like Cursor's own "searchable via @".
//
// A real `.gitignore` runs to thousands of lines (ips_10_4: 2 779 patterns), so
// the rules are indexed by a literal path segment they require: a path is tested
// against the handful that mention its segments, not against the whole file.
// Without that, one walk of that repository spent minutes in the matcher.
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeIgnoreFiles } from "@acpio/shared";
import { Minimatch } from "minimatch";

export interface IgnoreRules {
  /**
   * True when the path is left out of a walk. A directory is ignored when a
   * pattern names it; a file also when a folder above it is ignored, as
   * gitignore has it — unless a later `!` line brings that folder back, which
   * is what projects negating `web/packages/` rely on.
   */
  ignores(rel: string, isDir: boolean): boolean;
}

interface Rule {
  glob: string;
  negated: boolean;
  dirOnly: boolean;
  /** Position in the merged file order: the last matching rule wins. */
  order: number;
  /** Compiled on first use — most rules never look at a given path. */
  matcher?: Minimatch;
}

/** Rules grouped by the segment a path has to carry to be worth testing. */
interface Index {
  // A recursive pattern: the probe may sit at any depth of the path.
  anyDepth: Map<string, Rule[]>;
  // An anchored pattern: only the path's first segment can be the probe.
  first: Map<string, Rule[]>;
  // No usable probe (an extension-only pattern): tested for every path.
  always: Rule[];
}

const MAGIC = /[*?[\]{}()!+@]/;

/** A segment as the names it can stand for, when it is literal or one char class. */
function probesOf(segment: string): string[] | null {
  if (!MAGIC.test(segment)) return [segment];
  const at = segment.indexOf("[");
  const end = at === -1 ? -1 : segment.indexOf("]", at);
  if (at === -1 || end === -1) return null;
  const head = segment.slice(0, at);
  const tail = segment.slice(end + 1);
  if (MAGIC.test(head) || MAGIC.test(tail)) return null;
  const chars = [...segment.slice(at + 1, end)].filter((c) => c !== "^" && c !== "\\");
  if (!chars.length || chars.length > 8) return null;
  return chars.map((c) => `${head}${c}${tail}`);
}

/**
 * `#` comments, `!` negation, a trailing `/` for folders, and the last matching
 * line wins — the gitignore rules these files are written in. A pattern that
 * carries a folder of its own is anchored at the root; a bare name matches at
 * any depth.
 */
function parseRules(text: string, into: Rule[]): void {
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    } else if (line.startsWith("\\")) {
      // `\#` and `\!` are a literal first character, not a comment or a negation.
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    into.push({
      glob: line.includes("/") ? line : `**/${line}`,
      negated,
      dirOnly,
      order: into.length,
    });
  }
}

function indexRules(rules: readonly Rule[]): Index {
  const index: Index = { anyDepth: new Map(), first: new Map(), always: [] };
  for (const rule of rules) {
    const segments = rule.glob.split("/");
    const anyDepth = segments[0] === "**";
    // An any-depth pattern may carry its literal anywhere, so any segment will
    // do; an anchored one is only reached through the path's first segment.
    const probes = (anyDepth ? segments.slice(1).reverse() : segments.slice(0, 1)).flatMap(
      (segment) => probesOf(segment) ?? [],
    );
    if (!probes.length) {
      index.always.push(rule);
      continue;
    }
    for (const segment of probes) {
      const bucket = anyDepth ? index.anyDepth : index.first;
      const list = bucket.get(segment);
      if (list) list.push(rule);
      else bucket.set(segment, [rule]);
    }
  }
  return index;
}

/** The rules that could match this path, in file order. */
function candidates(index: Index, segments: readonly string[]): Rule[] {
  const found: Rule[] = [...index.always];
  const first = index.first.get(segments[0] ?? "");
  if (first) found.push(...first);
  for (const segment of segments) {
    const any = index.anyDepth.get(segment);
    if (any) found.push(...any);
  }
  if (found.length < 2) return found;
  // Order of evaluation is the file's, so the last matching line still wins;
  // one rule can sit in several buckets (a char class picks twice), and after
  // the sort its copies stand next to each other.
  found.sort((a, b) => a.order - b.order);
  for (let i = found.length - 1; i > 0; i--) if (found[i] === found[i - 1]) found.splice(i, 1);
  return found;
}

function matches(rule: Rule, rel: string): boolean {
  rule.matcher ??= new Minimatch(rule.glob, { dot: true });
  return rule.matcher.match(rel);
}

/**
 * One matcher over several ignore files, in the order they are listed: a later
 * file's line decides over an earlier one, so a project's own `.cursorignore`
 * can bring back what `.gitignore` hides.
 */
export function createIgnore(...texts: readonly string[]): IgnoreRules {
  const rules: Rule[] = [];
  for (const text of texts) parseRules(text, rules);
  const index = indexRules(rules);
  const ignoredAt = (rel: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const rule of candidates(index, rel.split("/"))) {
      if (rule.dirOnly && !isDir) continue;
      if (matches(rule, rel)) ignored = !rule.negated;
    }
    return ignored;
  };
  // A walk asks about a folder once per file inside it; the answer cannot
  // change under it, so it is worked out once. One matcher lives for one call.
  const dirs = new Map<string, boolean>();
  const dirIgnored = (rel: string): boolean => {
    const known = dirs.get(rel);
    if (known !== undefined) return known;
    const ignored = ignoredAt(rel, true);
    dirs.set(rel, ignored);
    return ignored;
  };
  return {
    ignores(rel, isDir) {
      if (!rel) return false;
      if (ignoredAt(rel, isDir)) return true;
      if (isDir) return false;
      // An ignored folder takes everything under it with it: the walk prunes the
      // folder, but a `grep` started inside one must not leak its files either.
      const segments = rel.split("/");
      for (let i = 1; i < segments.length; i++) {
        if (dirIgnored(segments.slice(0, i).join("/"))) return true;
      }
      return false;
    },
  };
}

/**
 * The matcher the configured files give, or null when the folder ships none of
 * them — then the walk costs exactly what it did before.
 */
export async function loadIgnoreFiles(root: string, files: unknown): Promise<IgnoreRules | null> {
  const texts: string[] = [];
  for (const rel of normalizeIgnoreFiles(files)) {
    try {
      texts.push(await fsp.readFile(path.resolve(root, rel), "utf8"));
    } catch {
      // A listed file the folder does not have is normal, not an error.
    }
  }
  return texts.length ? createIgnore(...texts) : null;
}
