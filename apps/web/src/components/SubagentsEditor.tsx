import { useState } from "react";
import type { BuiltinSubagentDef, BuiltinSubagentsSetting, BuiltinToolName } from "@acpio/shared";
import {
  BUILTIN_SUBAGENT_AGENTS_MAX,
  BUILTIN_SUBAGENT_MAX_TURNS_CAP,
  BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT,
  BUILTIN_TOOL_NAMES,
} from "@acpio/shared";
import { useT } from "../lib/i18n";
import styles from "./BuiltinModelsEditor.module.css";

const ALL_TOOLS: readonly BuiltinToolName[] = BUILTIN_TOOL_NAMES;

interface AgentDraft {
  /** Set when the draft edits an existing row. */
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: BuiltinToolName[];
  maxTurns: string;
}

const emptyDraft = (): AgentDraft => ({
  name: "",
  description: "",
  systemPrompt: "",
  tools: ["read", "glob", "grep"],
  maxTurns: String(BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT),
});

/**
 * Settings → Built-in agent → Subagents: the roster of user-defined agents the
 * `task` tool offers the model. The built-in `explore` agent is shown pinned
 * and read-only — it lives in code, not in settings. Rows are form state;
 * everything lands on Save like the rest of the page.
 */
export function SubagentsEditor({
  value,
  onChange,
}: {
  value: BuiltinSubagentsSetting;
  onChange: (next: BuiltinSubagentsSetting) => void;
}) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) return;
    const maxTurns = Math.min(
      BUILTIN_SUBAGENT_MAX_TURNS_CAP,
      Math.max(1, Math.round(Number(draft.maxTurns)) || BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT),
    );
    const row: BuiltinSubagentDef = {
      id: draft.id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt,
      tools: draft.tools.length ? draft.tools : ["read", "glob", "grep"],
      maxTurns,
    };
    onChange({
      ...value,
      agents: draft.id
        ? value.agents.map((a) => (a.id === draft.id ? row : a))
        : [...value.agents, row],
    });
    setDraft(emptyDraft());
    setAdding(false);
  };

  const toggleTool = (tool: BuiltinToolName) => {
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(tool)
        ? d.tools.filter((x) => x !== tool)
        : [...d.tools, tool],
    }));
  };

  const atLimit = value.agents.length >= BUILTIN_SUBAGENT_AGENTS_MAX;

  return (
    <div className={styles.editor}>
      <ul className={styles.list}>
        <li className={styles.row}>
          <span className={styles.check}>
            <span className={styles.id}>explore</span>
            <span className={styles.tag}>{t("settings.subagentsBuiltInTag")}</span>
          </span>
          <span className={styles.labelInput}>{t("settings.subagentsExploreDesc")}</span>
          <span aria-hidden />
        </li>
        {value.agents.map((agent) => (
          <li key={agent.id} className={styles.row}>
            <span className={styles.check} title={agent.id}>
              <span className={styles.id}>{agent.name}</span>
            </span>
            <span className={styles.labelInput}>
              {agent.tools.join(", ")}
              {agent.description ? ` — ${agent.description}` : ""}
            </span>
            <span>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  setDraft({
                    id: agent.id,
                    name: agent.name,
                    description: agent.description,
                    systemPrompt: agent.systemPrompt,
                    tools: [...agent.tools],
                    maxTurns: String(agent.maxTurns),
                  });
                  setAdding(true);
                }}
              >
                {t("common.edit")}
              </button>
              <button
                type="button"
                className={styles.remove}
                title={t("settings.subagentsRemove")}
                aria-label={`${t("settings.subagentsRemove")}: ${agent.name}`}
                onClick={() =>
                  onChange({ ...value, agents: value.agents.filter((a) => a.id !== agent.id) })
                }
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className={styles.addForm}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.subagentsName")}</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="test_runner"
              spellCheck={false}
              autoFocus
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.subagentsDescription")}</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder={t("settings.subagentsDescriptionHint")}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.subagentsSystemPrompt")}</span>
            <textarea
              className={styles.labelInput}
              rows={4}
              value={draft.systemPrompt}
              onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
              placeholder={t("settings.subagentsSystemPromptHint")}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.subagentsTools")}</span>
            <div className={styles.check}>
              {ALL_TOOLS.map((tool) => (
                <label key={tool} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  <span className={styles.id}>{tool}</span>
                </label>
              ))}
            </div>
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.subagentsMaxTurns")}</span>
            <input
              type="number"
              min={1}
              max={BUILTIN_SUBAGENT_MAX_TURNS_CAP}
              value={draft.maxTurns}
              onChange={(e) => setDraft((d) => ({ ...d, maxTurns: e.target.value }))}
            />
          </label>
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={saveDraft}
              disabled={!draft.name.trim()}
            >
              {t("settings.subagentsSubmit")}
            </button>
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setAdding(false);
                setDraft(emptyDraft());
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {atLimit ? <p className={styles.hint}>{t("settings.subagentsMaxReached", { max: BUILTIN_SUBAGENT_AGENTS_MAX })}</p> : null}
      <button
        type="button"
        className={styles.btn}
        disabled={atLimit}
        onClick={() => {
          setDraft(emptyDraft());
          setAdding((open) => !open);
        }}
        aria-expanded={adding}
      >
        + {t("settings.subagentsAdd")}
      </button>
    </div>
  );
}
