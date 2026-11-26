/**
 * A diff shows the changes, not the whole file: unchanged stretches between two
 * changes are folded into one row, with arrows that reveal the gap from either
 * end — the reading a git diff gives, applied to the editor's own diff view.
 *
 * The extension is per editor side: a merge view holds the revision in one state
 * and the working copy in another, and each folds the gaps of its own document.
 * Clicking an arrow reveals the same gap in both halves, or the two columns
 * would drift apart line by line.
 */
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { getChunks, mergeViewSiblings } from "@codemirror/merge";

/** Lines of unchanged code kept beside every change, as a diff editor does. */
const MARGIN = 3;
/** A shorter gap is not worth a row of its own. */
const MIN_GAP = 5;

/** The words a gap row shows; the caller translates them. */
export type GapLabels = {
  hidden: (lines: number) => string;
};

/** The effect a click on a band sends: open gap `index` whole. */
const openGap = StateEffect.define<number>();

/** The effect that puts the rows in once the view exists (see `seedFoldRows`). */
const seedRows = StateEffect.define<null>();

/** The gaps the reader has opened; a gap is shown whole from then on. */
const opened = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next: Set<number> | null = null;
    for (const effect of tr.effects) {
      if (!effect.is(openGap)) continue;
      next ??= new Set(value);
      next.add(effect.value);
    }
    return next ?? value;
  },
});

/** One click opens the whole gap in both halves of the diff. */
function open(view: EditorView, index: number) {
  view.dispatch({ effects: openGap.of(index) });
  const siblings = mergeViewSiblings(view);
  const other = siblings === null ? null : siblings.a === view ? siblings.b : siblings.a;
  other?.dispatch({ effects: openGap.of(index) });
}

/** Which way a band can be opened: a file edge has only one side. */
type Arrows = "both" | "up" | "down";

const CHEVRON: Record<Arrows, string> = {
  // Two chevrons: the band has lines to open on both sides.
  both: "M3 4.5 6 1.7l3 2.8M3 7.5 6 10.3l3-2.8",
  up: "M3 8 6 5l3 3",
  down: "M3 4 6 7l3-3",
};

class GapRow extends WidgetType {
  constructor(
    private readonly index: number,
    private readonly hidden: number,
    private readonly arrows: Arrows,
    private readonly labels: GapLabels,
  ) {
    super();
  }

  eq(other: GapRow) {
    return other.index === this.index && other.hidden === this.hidden && other.arrows === this.arrows;
  }

  toDOM(view: EditorView) {
    const label = this.labels.hidden(this.hidden);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cm-diffGap";
    row.dataset.gap = String(this.index);
    row.dataset.arrows = this.arrows;
    row.title = label;
    row.setAttribute("aria-label", label);
    row.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true">' +
      `<path d="${CHEVRON[this.arrows]}" fill="none" stroke="currentColor" ` +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open(view, this.index);
    });
    return row;
  }

  get estimatedHeight() {
    return 22;
  }
}

/** The chunks of this state, or nothing when the state is no diff at all. */
function chunksOf(state: EditorState) {
  try {
    return getChunks(state);
  } catch {
    return null;
  }
}

function build(state: EditorState, labels: GapLabels): DecorationSet {
  const diff = chunksOf(state);
  // `side` says which document this state holds: the revision of a merge view,
  // its working copy, or the single document of the inline one.
  if (!diff || diff.side === null || diff.chunks.length === 0) return Decoration.none;
  const { chunks } = diff;
  const side = diff.side;
  const openedGaps = state.field(opened);
  const lines = state.doc.lines;
  const clampLine = (line: number) => Math.max(1, Math.min(lines, line));
  const builder = new RangeSetBuilder<Decoration>();
  /** First line after the change this side has and the other does not, if any. */
  let afterChange = 1;
  for (let index = 0; index <= chunks.length; index += 1) {
    const chunk = chunks[index] ?? null;
    // The unchanged stretch either before the first change, between two, or
    // after the last one — with MARGIN lines of it left beside each change.
    const fromLine = index === 0 ? 1 : afterChange + MARGIN;
    const toLine = chunk
      ? state.doc.lineAt(side === "a" ? chunk.fromA : chunk.fromB).number - 1 - MARGIN
      : lines;
    const length = toLine - fromLine + 1;
    // The first gap is the top of the file and the last one its end: each
    // points at the side its hidden lines live on.
    const arrows: Arrows = index === 0 ? "up" : chunk === null ? "down" : "both";
    // A band hiding two or three lines is longer than the lines themselves.
    if (length >= MIN_GAP && !openedGaps.has(index)) {
      builder.add(
        state.doc.line(clampLine(fromLine)).from,
        state.doc.line(clampLine(toLine)).to,
        Decoration.replace({ block: true, widget: new GapRow(index, length, arrows, labels) }),
      );
    }
    if (!chunk) break;
    afterChange = state.doc.lineAt(Math.min(state.doc.length, side === "a" ? chunk.toA : chunk.toB)).number;
  }
  return builder.finish();
}

/**
 * Fold the unchanged stretches of this editor's document, leaving `MARGIN`
 * lines of context beside each change. `labels` are the row's words.
 *
 * The rows are built only once the view is up: the diff between the two
 * documents is computed by the merge view itself, and it is not there yet while
 * `EditorState.create` runs — hence `seedFoldRows` right after construction.
 */
export function collapseUnchangedGaps(labels: GapLabels): Extension {
  const fold: StateField<DecorationSet> = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (value, tr) =>
      tr.effects.some((effect) => effect.is(seedRows) || effect.is(openGap))
        ? build(tr.state, labels)
        : value.map(tr.changes),
    provide: (field) => EditorView.decorations.from(field),
  });
  return [opened, fold];
}

/** Ask the editors of a diff to draw their folded stretches. */
export function seedFoldRows(...views: EditorView[]): void {
  for (const view of views) view.dispatch({ effects: seedRows.of(null) });
}
