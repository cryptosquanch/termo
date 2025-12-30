import { getDatabase } from './database.js';

export interface Bookmark {
  id: number;
  user_id: number;
  title: string;
  content: string;
  project: string | null;
  created_at: string;
}

/**
 * Add a new bookmark
 */
export function addBookmark(
  userId: number,
  title: string,
  content: string,
  project?: string
): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO bookmarks (user_id, title, content, project)
    VALUES (?, ?, ?, ?)
  `).run(userId, title, content, project || null);

  return result.lastInsertRowid as number;
}

/**
 * Get all bookmarks for a user (most recent first)
 */
export function getBookmarks(userId: number, limit = 20): Bookmark[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM bookmarks
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as Bookmark[];
}

/**
 * Get a single bookmark by ID
 */
export function getBookmark(userId: number, bookmarkId: number): Bookmark | null {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM bookmarks
    WHERE user_id = ? AND id = ?
  `).get(userId, bookmarkId) as Bookmark | null;
}

/**
 * Search bookmarks by title or content
 */
export function searchBookmarks(userId: number, query: string, limit = 10): Bookmark[] {
  const db = getDatabase();
  const searchTerm = `%${query}%`;
  return db.prepare(`
    SELECT * FROM bookmarks
    WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, searchTerm, searchTerm, limit) as Bookmark[];
}

/**
 * Delete a bookmark
 */
export function deleteBookmark(userId: number, bookmarkId: number): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM bookmarks
    WHERE user_id = ? AND id = ?
  `).run(userId, bookmarkId);

  return result.changes > 0;
}

/**
 * Get bookmark count for a user
 */
export function getBookmarkCount(userId: number): number {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM bookmarks
    WHERE user_id = ?
  `).get(userId) as { count: number };

  return result.count;
}
