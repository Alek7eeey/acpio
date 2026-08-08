import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { useT } from "../lib/i18n";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import xml from "highlight.js/lib/languages/xml";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import styles from "./MarkdownContent.module.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c++", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("docker", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("golang", go);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("kt", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("ps1", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rb", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const LANG_ALIASES: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  "f#": "csharp",
};

const LANG_LABELS: Record<string, string> = {
  cs: "C#",
  csharp: "C#",
  fs: "F#",
  fsharp: "F#",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  go: "Go",
  golang: "Go",
  rs: "Rust",
  rust: "Rust",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  php: "PHP",
  sql: "SQL",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  zsh: "Zsh",
  powershell: "PowerShell",
  ps1: "PowerShell",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  md: "Markdown",
  markdown: "Markdown",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  plaintext: "Text",
  text: "Text",
};

function normalizeLang(raw?: string | null) {
  if (!raw) return "";
  const key = raw.trim().toLowerCase();
  return LANG_ALIASES[key] ?? key;
}

function languageLabel(raw?: string | null) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return LANG_LABELS[key] ?? raw.trim();
}

function highlightCode(code: string, language?: string) {
  const lang = normalizeLang(language);
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return "";
  }
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.copyBtn}
      title={copied ? t("common.copied") : t("common.copy")}
      aria-label={copied ? t("common.copied") : t("common.copy")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M6 16V6a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const t = useT();
  const label = languageLabel(language) ?? t("common.code");
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeToolbar}>
        <span className={styles.codeLang}>{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className={styles.codePre}>
        {highlighted ? (
          <code
            className={`hljs${language ? ` language-${normalizeLang(language)}` : ""}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  );
}

type MarkdownContentProps = {
  text: string;
  streaming?: boolean;
  className?: string;
};

export function MarkdownContent({ text, streaming = false, className }: MarkdownContentProps) {
  if (!text.trim()) return null;

  return (
    <div className={`${styles.root}${streaming ? ` ${styles.streaming}` : ""}${className ? ` ${className}` : ""}`}>
      <div className={styles.body}>
        <ReactMarkdown
          components={{
            p: ({ children }) => <p className={styles.paragraph}>{children}</p>,
            ul: ({ children }) => <ul className={styles.list}>{children}</ul>,
            ol: ({ children }) => <ol className={styles.list}>{children}</ol>,
            li: ({ children }) => <li className={styles.listItem}>{children}</li>,
            h1: ({ children }) => <h1 className={styles.heading}>{children}</h1>,
            h2: ({ children }) => <h2 className={styles.heading}>{children}</h2>,
            h3: ({ children }) => <h3 className={styles.heading}>{children}</h3>,
            pre: ({ children }) => <>{children}</>,
            code: ({ className: codeClass, children }) => {
              const match = /language-([\w#+-]+)/.exec(codeClass ?? "");
              const value = String(children).replace(/\n$/, "");
              const isBlock = Boolean(match) || value.includes("\n");
              if (!isBlock) {
                return <code className={styles.inlineCode}>{children}</code>;
              }
              return <CodeBlock language={match?.[1]} code={value} />;
            },
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer" className={styles.link}>
                {children}
              </a>
            ),
            blockquote: ({ children }) => (
              <blockquote className={styles.quote}>{children as ReactNode}</blockquote>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}
