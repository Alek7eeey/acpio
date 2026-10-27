import { useState } from "react";
import {
  BOARD_STAGE_COLUMNS,
  boardColumnsInOrder,
  type BoardColumn,
  type BoardColumnDto,
  type BoardColumnRule,
  type BoardDto,
} from "@acpio/shared";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { AppDialog } from "./AppDialog";
import styles from "./BoardColumnsDialog.module.css";

/** The condition a rule column claims cards by, as the editor offers it. */
export type RuleCondition = "all" | "question" | "error" | "finished";

/** Read a stored rule back into the one choice the editor shows. */
export function ruleCondition(rule: BoardColumnRule | null | undefined): RuleCondition {
  if (!rule) return "all";
  if (rule.questionPending === true) return "question";
  if (rule.hasError === true) return "error";
  if (rule.questionPending === false && rule.hasError === false) return "finished";
  return "all";
}

/** The rule a stage + condition pair means. */
export function ruleFor(stage: BoardColumn, condition: RuleCondition): BoardColumnRule {
  if (condition === "question") return { stage, questionPending: true };
  if (condition === "error") return { stage, hasError: true };
  if (condition === "finished") return { stage, questionPending: false, hasError: false };
  return { stage };
}

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

const CONDITIONS: RuleCondition[] = ["all", "question", "error", "finished"];

const CONDITION_TITLE: Record<RuleCondition, string> = {
  all: "chat.boardRuleAll",
  question: "chat.boardRuleQuestion",
  error: "chat.boardRuleError",
  finished: "chat.boardRuleFinished",
};

/**
 * The board's columns, edited in one place: the four stage homes (rename,
 * reorder, behavior — never delete) and the lanes the reader adds. A lane is
 * either a rule over a stage — «На ревью» takes what the agent finished, the
 * home keeps the questions — or a lane of its own that only a drop fills:
 * «Отложенные», «Бэклог», «Блок».
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
  const [newKind, setNewKind] = useState<"manual" | "auto">("manual");
  const [newStage, setNewStage] = useState<BoardColumn | "none">("none");
  const [newCondition, setNewCondition] = useState<RuleCondition>("all");

  if (!open || !board) return null;

  const columns = boardColumnsInOrder(board.columns);
  const rows = columns;
  /** The stage the new lane names; a rule lane needs one, a manual lane may skip it. */
  const stageAnchor = newStage === "none" ? null : newStage;

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

  const setKind = (column: BoardColumnDto, kind: "auto" | "manual") => {
    if (kind === "auto") {
      const anchor = column.anchor ?? "wait";
      const condition = ruleCondition(column.rule);
      void updateBoardColumn(board.id, column.id, {
        kind,
        anchor,
        rule: ruleFor(anchor, condition),
      });
      return;
    }
    void updateBoardColumn(board.id, column.id, { kind });
  };

  const setStage = (column: BoardColumnDto, stage: BoardColumn | "none") => {
    const anchor = stage === "none" ? null : stage;
    if (column.kind === "auto") {
      if (!anchor) return;
      const condition = ruleCondition(column.rule);
      void updateBoardColumn(board.id, column.id, { anchor, rule: ruleFor(anchor, condition) });
      return;
    }
    void updateBoardColumn(board.id, column.id, { anchor });
  };

  const submitNew = () => {
    const title = newTitle.trim();
    if (!title) return;
    const anchor = newKind === "auto" ? (stageAnchor ?? "wait") : stageAnchor;
    void addBoardColumn(board.id, {
      title,
      kind: newKind,
      anchor,
      ...(newKind === "auto" && anchor
        ? { rule: ruleFor(anchor, newCondition) }
        : {}),
    });
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
                <span>{t("chat.boardColumnStage")}</span>
                <select
                  value={column.anchor ?? "none"}
                  disabled={column.home}
                  onChange={(e) => setStage(column, e.target.value as BoardColumn | "none")}
                >
                  <option value="none">{t("chat.boardStageNone")}</option>
                  {BOARD_STAGE_COLUMNS.map((stage) => (
                    <option key={stage} value={stage}>
                      {t(STAGE_TITLE[stage])}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span>{t("chat.boardColumnKind")}</span>
                <select
                  value={column.kind}
                  disabled={column.home}
                  onChange={(e) => setKind(column, e.target.value as "auto" | "manual")}
                >
                  {column.kind === "stage" ? (
                    <option value="stage">{t("chat.boardColumnKindStage")}</option>
                  ) : null}
                  <option value="auto">{t("chat.boardColumnKindAuto")}</option>
                  <option value="manual">{t("chat.boardColumnKindManual")}</option>
                </select>
              </label>

              {column.kind === "auto" ? (
                <label className={styles.field}>
                  <span>{t("chat.boardColumnRule")}</span>
                  <select
                    value={ruleCondition(column.rule)}
                    onChange={(e) =>
                      column.anchor
                        ? void updateBoardColumn(board.id, column.id, {
                            rule: ruleFor(column.anchor, e.target.value as RuleCondition),
                          })
                        : undefined
                    }
                  >
                    {CONDITIONS.map((condition) => (
                      <option key={condition} value={condition}>
                        {t(CONDITION_TITLE[condition])}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

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
        <div className={styles.rowFields}>
          <label className={styles.field}>
            <span>{t("chat.boardColumnKind")}</span>
            <select
              value={newKind}
              onChange={(e) => {
                const kind = e.target.value as "auto" | "manual";
                setNewKind(kind);
                // A rule lane always watches a stage, so an unset one becomes
                // Wait — the stage «Review» and «Broken» lanes are about.
                if (kind === "auto" && newStage === "none") setNewStage("wait");
              }}
            >
              <option value="manual">{t("chat.boardColumnKindManual")}</option>
              <option value="auto">{t("chat.boardColumnKindAuto")}</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>{t("chat.boardColumnStage")}</span>
            <select
              value={newStage}
              onChange={(e) => setNewStage(e.target.value as BoardColumn | "none")}
            >
              {newKind === "manual" ? (
                <option value="none">{t("chat.boardStageNone")}</option>
              ) : null}
              {BOARD_STAGE_COLUMNS.map((stage) => (
                <option key={stage} value={stage}>
                  {t(STAGE_TITLE[stage])}
                </option>
              ))}
            </select>
          </label>
          {newKind === "auto" ? (
            <label className={styles.field}>
              <span>{t("chat.boardColumnRule")}</span>
              <select
                value={newCondition}
                onChange={(e) => setNewCondition(e.target.value as RuleCondition)}
              >
                {CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {t(CONDITION_TITLE[condition])}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
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
