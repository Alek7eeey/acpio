import { useState } from "react";
import {
  boardColumnsInOrder,
  type BoardColumn,
  type BoardColumnDto,
  type BoardDto,
} from "@acpio/shared";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { AppDialog } from "./AppDialog";
import styles from "./BoardColumnsDialog.module.css";

const STAGE_TITLE: Record<BoardColumn, string> = {
  todo: "chat.colTodo",
  progress: "chat.colProgress",
  wait: "chat.colWait",
  done: "chat.colDone",
};

const SORT_MODES: BoardColumnDto["sortMode"][] = ["manual", "updated", "done", "created"];

const SORT_TITLE: Record<BoardColumnDto["sortMode"], string> = {
  manual: "chat.boardSortManual",
  updated: "chat.boardSortUpdated",
  done: "chat.boardSortDone",
  created: "chat.boardSortCreated",
};

/**
 * The board's columns, edited in one place: the four stage homes (rename,
 * reorder, behavior — never delete) and the lanes the reader adds.
 *
 * The whole strip stays on the left, in its own order, one line a column; the
 * pane beside it answers only for the column the reader picked — the one place
 * a title, an order of cards and a switch live, so a long strip never piles a
 * form under every column. The rail between the panes is what the strip itself
 * can do to that column: up, down, and away.
 *
 * A lane is a place, not a condition. «Отложенные», «Бэклог», «Блок» hold the
 * cards a hand drops in them, and every other card stands where its lifecycle
 * puts it — which is why the editor never asks a lane about a stage or a rule.
 * A column that claimed part of a stage would compete with that stage's home
 * («Wait» takes the finished turns, so what is left in it?), and the reader
 * would have two controls saying which cards arrive while only one can win.
 */
export function BoardColumnsDialog({
  open,
  board,
  onClose,
}: {
  open: boolean;
  board: BoardDto | null;
  onClose: () => void;
}) {
  const t = useT();
  const addBoardColumn = useAppStore((s) => s.addBoardColumn);
  const updateBoardColumn = useAppStore((s) => s.updateBoardColumn);
  const deleteBoardColumn = useAppStore((s) => s.deleteBoardColumn);
  const reorderBoardColumns = useAppStore((s) => s.reorderBoardColumns);

  const [newTitle, setNewTitle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!open || !board) return null;

  const rows = boardColumnsInOrder(board.columns);
  // The first column answers until the reader picks another — and stays answered
  // only while it is still there (it may have just been deleted).
  const selected = rows.find((column) => column.id === selectedId) ?? rows[0]!;
  const at = rows.indexOf(selected);

  /** What the strip prints on the column: the reader's name, or the stage's own. */
  const nameOf = (column: BoardColumnDto) =>
    column.title || (column.anchor ? t(STAGE_TITLE[column.anchor]) : "");

  const move = (id: string, dir: -1 | 1) => {
    const ids = rows.map((column) => column.id);
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void reorderBoardColumns(board.id, ids);
  };

  const commitTitle = (column: BoardColumnDto, raw: string) => {
    const title = raw.trim().slice(0, 60);
    if (title === column.title) return;
    // A lane needs a name; a home may fall back to its built-in one.
    if (!title && !column.home) return;
    void updateBoardColumn(board.id, column.id, { title });
  };

  const submitNew = () => {
    const title = newTitle.trim();
    if (!title) return;
    void addBoardColumn(board.id, { title });
    setNewTitle("");
  };

  return (
    <AppDialog
      wide
      title={t("chat.boardColumns")}
      onClose={onClose}
      actions={
        <button type="button" className={styles.done} onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className={styles.body}>
        <div className={styles.pane}>
          <div className={styles.paneHead}>
            <span>{t("chat.boardColumnAll")}</span>
            <span className={styles.count}>{rows.length}</span>
          </div>

          <div className={styles.list}>
            {rows.map((column, index) => (
              <button
                key={column.id}
                type="button"
                className={column.id === selected.id ? styles.rowActive : styles.row}
                data-column-id={column.id}
                aria-pressed={column.id === selected.id}
                onClick={() => setSelectedId(column.id)}
              >
                <span className={styles.rowIndex}>{index + 1}</span>
                <span className={styles.rowTitle}>{nameOf(column)}</span>
                {column.home ? (
                  <span
                    className={styles.homeMark}
                    data-column-home=""
                    title={t("chat.boardColumnHomeHint")}
                  >
                    {t("chat.boardColumnKindStage")}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className={styles.addBox}>
            <input
              className={styles.titleInput}
              data-new-column-title=""
              value={newTitle}
              placeholder={t("chat.boardColumnTitle")}
              aria-label={t("chat.boardColumnTitle")}
              maxLength={60}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
              }}
            />
            <button
              type="button"
              className={styles.addBtn}
              data-add-column=""
              title={t("chat.boardColumnAdd")}
              aria-label={t("chat.boardColumnAdd")}
              disabled={!newTitle.trim()}
              onClick={submitNew}
            >
              +
            </button>
          </div>
        </div>

        <div className={styles.rail}>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={at <= 0}
            title={t("chat.moveFolderUp")}
            aria-label={t("chat.moveFolderUp")}
            onClick={() => move(selected.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            disabled={at >= rows.length - 1}
            title={t("chat.moveFolderDown")}
            aria-label={t("chat.moveFolderDown")}
            onClick={() => move(selected.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.deleteBtn}`}
            data-column-delete=""
            disabled={selected.home}
            title={selected.home ? t("chat.boardColumnHomeHint") : t("chat.boardColumnDelete")}
            aria-label={t("chat.boardColumnDelete")}
            onClick={() => void deleteBoardColumn(board.id, selected.id)}
          >
            ×
          </button>
        </div>

        <div className={styles.detail}>
          <div className={styles.paneHead}>
            <span>{t("chat.boardColumnSettings")}</span>
            <span className={styles.detailName}>{nameOf(selected)}</span>
          </div>

          <div className={styles.detailBody} data-column-settings="">
            <label className={styles.field}>
              <span>{t("chat.boardColumnTitle")}</span>
              <input
                key={selected.id}
                className={styles.titleInput}
                defaultValue={selected.title}
                placeholder={nameOf(selected)}
                maxLength={60}
                onBlur={(e) => commitTitle(selected, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>

            <label className={styles.field}>
              <span>{t("chat.boardColumnSort")}</span>
              <select
                value={selected.sortMode}
                onChange={(e) =>
                  void updateBoardColumn(board.id, selected.id, {
                    sortMode: e.target.value as BoardColumnDto["sortMode"],
                  })
                }
              >
                {SORT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(SORT_TITLE[mode])}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.rowToggles}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={selected.acceptsPrompt}
                  onChange={(e) =>
                    void updateBoardColumn(board.id, selected.id, {
                      acceptsPrompt: e.target.checked,
                    })
                  }
                />
                <span>{t("chat.boardColumnPrompt")}</span>
              </label>
              {selected.home ? null : (
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={selected.keepOnRun}
                    onChange={(e) =>
                      void updateBoardColumn(board.id, selected.id, {
                        keepOnRun: e.target.checked,
                      })
                    }
                  />
                  <span>{t("chat.boardColumnKeepOnRun")}</span>
                </label>
              )}
            </div>

            {selected.home ? <p className={styles.hint}>{t("chat.boardColumnHomeHint")}</p> : null}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
