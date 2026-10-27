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

  if (!open || !board) return null;

  const rows = boardColumnsInOrder(board.columns);

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
      title={t("chat.boardColumns")}
      onClose={onClose}
      actions={
        <button type="button" className={styles.done} onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className={styles.list}>
        {rows.map((column, index) => (
          <div key={column.id} className={styles.row} data-column-id={column.id}>
            <div className={styles.rowTop}>
              <input
                className={styles.titleInput}
                defaultValue={column.title}
                placeholder={
                  column.home && column.anchor ? t(STAGE_TITLE[column.anchor]) : t("chat.boardColumnTitle")
                }
                aria-label={t("chat.boardColumnTitle")}
                maxLength={60}
                onBlur={(e) => commitTitle(column, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <span className={styles.rowOrder}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  disabled={index === 0}
                  title={t("chat.moveFolderUp")}
                  aria-label={t("chat.moveFolderUp")}
                  onClick={() => move(column.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  disabled={index === rows.length - 1}
                  title={t("chat.moveFolderDown")}
                  aria-label={t("chat.moveFolderDown")}
                  onClick={() => move(column.id, 1)}
                >
                  ↓
                </button>
                {column.home ? (
                  <span
                    className={styles.homeMark}
                    data-column-home=""
                    title={t("chat.boardColumnHomeHint")}
                  >
                    {t("chat.boardColumnKindStage")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    data-column-delete=""
                    title={t("chat.boardColumnDelete")}
                    aria-label={t("chat.boardColumnDelete")}
                    onClick={() => void deleteBoardColumn(board.id, column.id)}
                  >
                    ×
                  </button>
                )}
              </span>
            </div>

            <div className={styles.rowFields}>
              <label className={styles.field}>
                <span>{t("chat.boardColumnSort")}</span>
                <select
                  value={column.sortMode}
                  onChange={(e) =>
                    void updateBoardColumn(board.id, column.id, {
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
            </div>

            <div className={styles.rowToggles}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={column.acceptsPrompt}
                  onChange={(e) =>
                    void updateBoardColumn(board.id, column.id, {
                      acceptsPrompt: e.target.checked,
                    })
                  }
                />
                <span>{t("chat.boardColumnPrompt")}</span>
              </label>
              {column.home ? null : (
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={column.keepOnRun}
                    onChange={(e) =>
                      void updateBoardColumn(board.id, column.id, {
                        keepOnRun: e.target.checked,
                      })
                    }
                  />
                  <span>{t("chat.boardColumnKeepOnRun")}</span>
                </label>
              )}
            </div>
          </div>
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
          disabled={!newTitle.trim()}
          onClick={submitNew}
        >
          {t("chat.boardColumnAdd")}
        </button>
      </div>
    </AppDialog>
  );
}
