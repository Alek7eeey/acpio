import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "../lib/i18n";
import { lastPathSegment } from "../lib/pathSegments";
import { ImageViewer, type ViewerPicture } from "./ImageViewer";
import { toggleWrapLines, useWrapLines } from "../lib/wrapLines";
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

/** Marks the <img> of a picture in agent text, so a click can gather the rest
 *  of the message's pictures (see `pictureGroup`). */
const PICTURE_ATTR = "data-md-picture";

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

function WrapButton() {
  const t = useT();
  const wrap = useWrapLines();
  const label = t("common.wrapLines");
  return (
    <button
      type="button"
      className={`${styles.copyBtn}${wrap ? "" : ` ${styles.copyBtnOff}`}`}
      aria-pressed={wrap}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleWrapLines();
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 6h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        {wrap ? (
          <>
            <path
              d="M4 12h11a3 3 0 0 1 0 6H8"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M11 15l-3 3 3 3"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path d="M4 12h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path
              d="M17 9l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M4 18h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const t = useT();
  const wrap = useWrapLines();
  const label = languageLabel(language) ?? t("common.code");
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeToolbar}>
        <span className={styles.codeLang}>{label}</span>
        <div className={styles.codeActions}>
          <WrapButton />
          <CopyButton text={code} />
        </div>
      </div>
      <pre className={`${styles.codePre}${wrap ? "" : ` ${styles.codePreNoWrap}`}`}>
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
  /** The chat whose folder a local image path is resolved against. */
  sessionId?: string | null;
};

function childrenToPlainText(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToPlainText).join("");
  if (typeof children === "object" && "props" in children) {
    return childrenToPlainText((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/** The Kommersant newspaper is often cited as "Ъ" — expand so it doesn't look like a broken glyph. */
function friendlyLinkLabel(href: string | undefined, children: ReactNode): ReactNode {
  const plain = childrenToPlainText(children).trim();
  if (plain === "Ъ" || plain === "ъ") return "Коммерсантъ";
  if (!plain && href) {
    try {
      const host = new URL(href).hostname.replace(/^www\./, "");
      if (/kommersant/i.test(host)) return "Коммерсантъ";
    } catch {
      // ignore
    }
  }
  return children;
}

/** Text that is nothing but a path on this machine — `C:\work\shot.png`, or one
 *  relative to the chat folder. A web address is not one, however many slashes
 *  it has, and neither is a bare word. */
function isPathText(text: string): boolean {
  // `C:` reads as a scheme and is not one; `https:` is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return false;
  return /[\\/]/.test(text);
}

/**
 * The file's own name, when the text is nothing but a path.
 *
 * A link to a file or a picture is written by whoever made that file, so its
 * text is the path the file has: `D:\work\shots\screen.png` in the middle of a
 * sentence is a link the reader cannot find the name in, and the picture beside
 * it is one word wide. The name is what the link says; the path it came from is
 * its tooltip, and stays in the destination.
 */
function pathLabel(text: string): string | null {
  const trimmed = text.trim();
  if (!isPathText(trimmed)) return null;
  const name = lastPathSegment(trimmed);
  return name && name !== trimmed ? name : null;
}

/** A link in agent text. One that points at a file says the file's name. */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const text = childrenToPlainText(children).trim();
  const name = pathLabel(text);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={styles.link}
      title={name ? text : undefined}
    >
      {name ?? friendlyLinkLabel(href, children)}
    </a>
  );
}

/** Expand bare (Ъ) citations in plain markdown text. */
function expandSourceCitations(text: string): string {
  return text
    .replace(/\[Ъ\]\((https?:\/\/[^)\s]+)\)/g, "[Коммерсантъ]($1)")
    .replace(/\[ъ\]\((https?:\/\/[^)\s]+)\)/g, "[Коммерсантъ]($1)")
    .replace(/(^|[\s(])Ъ(?=\))/g, "$1Коммерсантъ");
}

/** A picture path markdown cannot read: a bare destination ends at the first
 *  space or `[`, so a screenshot named `Точки доступа_…__[point].png` stayed
 *  text. Angle brackets carry such a path through unchanged. */
function quoteImagePaths(text: string): string {
  return text.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g, (whole, alt: string, dest: string) =>
    /[ \t[\]()]/.test(dest) && !/[<>"']/.test(dest) ? `![${alt}](<${dest}>)` : whole,
  );
}

/**
 * Keep a markdown image's own `src` intact.
 *
 * The agent points at bytes it saved itself, so an image URL is usually a plain
 * path: `C:\work\shot.png`, or one relative to the chat folder. The default
 * transform drops exactly those (a Windows drive reads as an unknown protocol)
 * before any renderer sees them, so `src` passes through and is vetted where it
 * turns into an element. Links keep the default treatment.
 */
const transformUrl: UrlTransform = (url, key) =>
  key === "src" ? url : defaultUrlTransform(url);

/** The markdown pipeline percent-escapes a destination — a Windows path reaches
 *  us as `C:%5Ctmp%5Cshot.png` — and the route wants the plain path. */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A path on this machine, as an agent writes one — `file:///C:/shot.png` too. */
function localPath(url: string): string | null {
  const fileUrl = /^file:\/\/(.*)$/i.exec(url);
  if (fileUrl) {
    const rest = decodePath(fileUrl[1] ?? "");
    // `file:///C:/x.png` — the slash before a drive letter is not a path part.
    return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
  }
  // A Windows drive is not a scheme, however much `C:` looks like one.
  if (/^[A-Za-z]:[\\/]/.test(url)) return decodePath(url);
  // Any other scheme (data:, https:, javascript:, …) is not a path.
  return /^[a-z][a-z0-9+.-]+:/i.test(url) ? null : decodePath(url);
}

/** Where an image's bytes are: a URL the browser fetches as it stands, or a file
 *  served by this chat's own route (see `/api/sessions/:id/file`). */
function imageTarget(raw: string, sessionId: string | null): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^data:image\//i.test(url) || /^https?:\/\//i.test(url)) return url;
  const filePath = localPath(url);
  if (!filePath || !sessionId) return null;
  const query = `path=${encodeURIComponent(filePath)}&inline=1`;
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?${query}`;
}

/**
 * The pictures a click started from: the ones the same message already shows,
 * in the order the reader meets them, so ← / → walk that message's pictures
 * instead of the whole chat. A picture outside a message (a plan dialog, a bare
 * render) is its own group of one.
 */
function pictureGroup(node: HTMLImageElement): { pictures: ViewerPicture[]; index: number } {
  const root = node.closest("[data-msg-hotkey]") ?? node.parentElement;
  const nodes = root
    ? Array.from(root.querySelectorAll<HTMLImageElement>(`img[${PICTURE_ATTR}]`))
    : [];
  const list = nodes.length > 0 ? nodes : [node];
  return {
    index: Math.max(0, list.indexOf(node)),
    pictures: list.map((img) => ({
      src: img.getAttribute("src") ?? "",
      alt: img.getAttribute("alt") ?? "",
    })),
  };
}

/**
 * One picture in agent text. A file on this machine is served through the chat's
 * own route; either way the picture is clickable and opens the viewer (see
 * ImageViewer) rather than a bare tab. A source that cannot be shown (no chat
 * around the renderer, a path that 404s) leaves its caption behind instead of a
 * broken box.
 */
export function MarkdownImage({
  src,
  alt,
  sessionId = null,
}: {
  src: string;
  alt?: string;
  sessionId?: string | null;
}) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState<{ pictures: ViewerPicture[]; index: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const target = imageTarget(src, sessionId ?? null);
  // A caption the text did not give is the picture's own path, and a path is not
  // a caption: the reader gets the file's name, the path stays in the tooltip.
  const rawCaption = (alt ?? "").trim() || decodePath(src.trim());
  const shortCaption = pathLabel(rawCaption);
  const caption = shortCaption ?? rawCaption;
  const tooltip = shortCaption ? rawCaption : caption;
  if (!target) {
    return caption ? (
      <span className={styles.imageMissing} title={shortCaption ? rawCaption : undefined}>
        {caption}
      </span>
    ) : null;
  }
  if (broken) {
    return (
      <span className={styles.imageMissing} title={rawCaption}>
        {caption}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={styles.imageButton}
        title={t("imageViewer.open")}
        aria-label={caption ? `${t("imageViewer.open")}: ${caption}` : t("imageViewer.open")}
        onClick={() => {
          const node = imgRef.current;
          if (node) setViewing(pictureGroup(node));
        }}
      >
        <img
          ref={imgRef}
          // Marks the picture for `pictureGroup`; the value carries nothing.
          data-md-picture=""
          className={styles.image}
          src={target}
          alt={caption}
          title={tooltip}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </button>
      {viewing
        ? createPortal(
            <ImageViewer
              pictures={viewing.pictures}
              startIndex={viewing.index}
              onClose={() => setViewing(null)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

// Stable identity — a fresh `components` object every render remounts the whole tree.
const markdownComponents: Components = {
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
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  blockquote: ({ children }) => (
    <blockquote className={styles.quote}>{children as ReactNode}</blockquote>
  ),
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table className={styles.table}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className={styles.thead}>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className={styles.tr}>{children}</tr>,
  th: ({ children }) => <th className={styles.th}>{children}</th>,
  td: ({ children }) => <td className={styles.td}>{children}</td>,
};

const remarkPlugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming = false,
  className,
  sessionId = null,
}: MarkdownContentProps) {
  // Render the server buffer directly. Each incoming chunk becomes visible
  // immediately; no synthetic typing or delayed catch-up animation.
  const rendered = useMemo(() => quoteImagePaths(expandSourceCitations(text)), [text]);
  // `img` closes over this chat's id, so a path in the text becomes a URL on the
  // chat's own file route. One object per id — a fresh one on every render
  // remounts the whole tree (see the note above markdownComponents).
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      img: ({ src, alt }) => (
        <MarkdownImage src={typeof src === "string" ? src : ""} alt={alt} sessionId={sessionId} />
      ),
    }),
    [sessionId],
  );
  if (!text.trim()) return null;

  return (
    <div
      className={`${styles.root}${streaming ? ` ${styles.streaming}` : ""}${className ? ` ${className}` : ""}`}
    >
      <div className={styles.body}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          urlTransform={transformUrl}
          components={components}
        >
          {rendered}
        </ReactMarkdown>
      </div>
    </div>
  );
});
