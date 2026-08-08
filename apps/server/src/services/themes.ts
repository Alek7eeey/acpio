import { asc, eq } from "drizzle-orm";
import type { ChatThemeDto } from "@acprocess/shared";
import { defaultThemeName } from "@acprocess/i18n";
import { db } from "../db/client.js";
import { chatThemes } from "../db/schema.js";
import { getSettings } from "./settings.js";

function mapTheme(row: typeof chatThemes.$inferSelect): ChatThemeDto {
  return {
    id: row.id,
    name: row.name,
    path: row.path ?? "",
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listThemes(): Promise<ChatThemeDto[]> {
  const rows = await db.select().from(chatThemes).orderBy(asc(chatThemes.sortOrder), asc(chatThemes.createdAt));
  return rows.map(mapTheme);
}

export async function getTheme(id: string): Promise<ChatThemeDto | null> {
  const [row] = await db.select().from(chatThemes).where(eq(chatThemes.id, id)).limit(1);
  return row ? mapTheme(row) : null;
}

export async function createTheme(input: { name?: string }): Promise<ChatThemeDto> {
  const settings = await getSettings();
  const name = (input.name?.trim() || defaultThemeName(settings.locale)).slice(0, 80);
  const existing = await db.select().from(chatThemes);
  const sortOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
  const [row] = await db
    .insert(chatThemes)
    .values({ name, path: "", sortOrder })
    .returning();
  return mapTheme(row);
}

export async function updateTheme(
  id: string,
  patch: Partial<{ name: string; sortOrder: number }>,
): Promise<ChatThemeDto | null> {
  const next: Partial<{ name: string; sortOrder: number; updatedAt: Date }> = { ...patch };
  if (typeof next.name === "string") next.name = next.name.trim();
  const [row] = await db
    .update(chatThemes)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(chatThemes.id, id))
    .returning();
  return row ? mapTheme(row) : null;
}

export async function deleteTheme(id: string): Promise<boolean> {
  const rows = await db.delete(chatThemes).where(eq(chatThemes.id, id)).returning();
  return rows.length > 0;
}

export async function reorderThemes(ids: string[]): Promise<ChatThemeDto[]> {
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(chatThemes)
      .set({ sortOrder: i, updatedAt: new Date() })
      .where(eq(chatThemes.id, ids[i]!));
  }
  return listThemes();
}
