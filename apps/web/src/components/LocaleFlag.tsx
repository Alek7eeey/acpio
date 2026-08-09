import { useId } from "react";
import type { AppLocale } from "@acprocess/shared";
import styles from "./LocaleFlag.module.css";

export function LocaleFlag({ locale }: { locale: AppLocale }) {
  const id = useId().replace(/:/g, "");

  if (locale === "ru") {
    return (
      <svg className={styles.flag} viewBox="0 0 3 2" aria-hidden>
        <rect width="3" height="0.667" y="0" fill="#fff" />
        <rect width="3" height="0.667" y="0.667" fill="#0039a6" />
        <rect width="3" height="0.667" y="1.333" fill="#d52b1e" />
      </svg>
    );
  }

  const clipS = `gb-s-${id}`;
  const clipT = `gb-t-${id}`;

  return (
    <svg className={`${styles.flag} ${styles.flagGb}`} viewBox="0 0 60 30" aria-hidden>
      <clipPath id={clipS}>
        <path d="M0,0 v30 h60 v-30 z" />
      </clipPath>
      <clipPath id={clipT}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 z" />
      </clipPath>
      <g clipPath={`url(#${clipS})`}>
        <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
        <path
          d="M0,0 L60,30 M60,0 L0,30"
          clipPath={`url(#${clipT})`}
          stroke="#c8102e"
          strokeWidth="4"
        />
        <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
        <path d="M30,0 v30 M0,15 h60" stroke="#c8102e" strokeWidth="6" />
      </g>
    </svg>
  );
}
