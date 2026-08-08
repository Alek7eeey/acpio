import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import styles from "./MarkdownContent.module.css";

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

function languageLabel(raw?: string | null) {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return LANG_LABELS[key] ?? raw.trim();
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      title={copied ? "Скопировано" : "Копировать"}
      aria-label={copied ? "Скопировано" : "Копировать"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Скопировано" : "Копировать"}
    </button>
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const label = languageLabel(language) ?? "Code";
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeToolbar}>
        <span className={styles.codeLang}>{label}</span>
        <CopyButton text={code} className={styles.copyBtn} />
      </div>
      <pre className={styles.codePre}>
        <code>{code}</code>
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
