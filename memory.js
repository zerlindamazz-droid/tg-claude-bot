/**
 * MemPalace-inspired memory system for Claude Telegram Bot
 *
 * Architecture:
 *   Palace → Wings (people/projects) → Halls (memory types) → Rooms (specific memories)
 *
 * Memory types (Halls):
 *   - episodic:   what happened in past conversations
 *   - semantic:   facts the user told us (name, job, preferences)
 *   - procedural: how the user likes things done
 *   - evolution:  bot's own learned behaviors and self-improvements
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.MEMORY_DB || path.join(__dirname, 'palace.db');

class MemPalace {
  constructor() {
    this.db = new Database(DB_PATH);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        hall TEXT NOT NULL,         -- episodic | semantic | procedural | evolution
        room TEXT,                  -- topic/tag
        content TEXT NOT NULL,
        keywords TEXT,              -- space-separated for search
        importance INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        accessed_at INTEGER DEFAULT (strftime('%s','now')),
        access_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        chat_id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS bot_evolution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER DEFAULT 1,
        system_additions TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        due_at INTEGER NOT NULL,        -- unix timestamp
        repeat TEXT DEFAULT NULL,       -- null | daily | weekly
        sent INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_hall ON memories(chat_id, hall);
      CREATE INDEX IF NOT EXISTS idx_keywords ON memories(keywords);
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, sent);
    `);
  }

  // ── Store a memory ──────────────────────────────────────────────────────────
  store(chatId, hall, content, { room = null, importance = 1 } = {}) {
    const keywords = this._extractKeywords(content);
    this.db.prepare(`
      INSERT INTO memories (chat_id, hall, room, content, keywords, importance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(chatId), hall, room, content, keywords, importance);
  }

  // ── Store conversation episode ──────────────────────────────────────────────
  storeEpisode(chatId, userMsg, botReply) {
    const content = `User: ${userMsg}\nBot: ${botReply}`;
    this.store(chatId, 'episodic', content, { importance: 1 });
  }

  // ── Retrieve relevant memories for a query ─────────────────────────────────
  recall(chatId, query, { limit = 6, halls = null } = {}) {
    const keywords = this._extractKeywords(query).split(' ').filter(k => k.length > 2);
    if (!keywords.length) return this._recallRecent(chatId, limit);

    const hallFilter = halls ? `AND hall IN (${halls.map(() => '?').join(',')})` : '';
    const hallParams = halls || [];

    // Score by keyword matches + recency + importance
    const likeConditions = keywords.map(() => `(keywords LIKE ? OR content LIKE ?)`).join(' OR ');
    const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);

    const rows = this.db.prepare(`
      SELECT *,
        (importance * 2 + access_count * 0.1) AS score,
        (strftime('%s','now') - created_at) AS age_secs
      FROM memories
      WHERE chat_id = ? ${hallFilter}
        AND (${likeConditions})
      ORDER BY score DESC, created_at DESC
      LIMIT ?
    `).all(String(chatId), ...hallParams, ...likeParams, limit);

    // Update access stats
    if (rows.length) {
      const ids = rows.map(r => r.id);
      this.db.prepare(`
        UPDATE memories SET accessed_at = strftime('%s','now'), access_count = access_count + 1
        WHERE id IN (${ids.join(',')})
      `).run();
    }

    return rows.map(r => `[${r.hall}/${r.room || 'general'}] ${r.content}`);
  }

  _recallRecent(chatId, limit) {
    return this.db.prepare(`
      SELECT * FROM memories WHERE chat_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(String(chatId), limit).map(r => `[${r.hall}] ${r.content}`);
  }

  // ── User profile (semantic facts) ──────────────────────────────────────────
  getProfile(chatId) {
    const row = this.db.prepare('SELECT profile_json FROM user_profile WHERE chat_id = ?').get(String(chatId));
    return row ? JSON.parse(row.profile_json) : {};
  }

  updateProfile(chatId, updates) {
    const current = this.getProfile(chatId);
    const merged = { ...current, ...updates, updated_at: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO user_profile (chat_id, profile_json) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET profile_json = ?, updated_at = strftime('%s','now')
    `).run(String(chatId), JSON.stringify(merged), JSON.stringify(merged));
    return merged;
  }

  // ── Bot self-evolution ──────────────────────────────────────────────────────
  getEvolutions() {
    return this.db.prepare(`
      SELECT system_additions, reason FROM bot_evolution ORDER BY created_at DESC LIMIT 10
    `).all();
  }

  addEvolution(systemAddition, reason) {
    this.db.prepare(`
      INSERT INTO bot_evolution (system_additions, reason) VALUES (?, ?)
    `).run(systemAddition, reason);
    console.log(`[Evolution] ${reason}`);
  }

  // ── Reminders ───────────────────────────────────────────────────────────────
  addReminder(chatId, message, dueAt, repeat = null) {
    this.db.prepare(`
      INSERT INTO reminders (chat_id, message, due_at, repeat) VALUES (?, ?, ?, ?)
    `).run(String(chatId), message, Math.floor(dueAt / 1000), repeat);
  }

  getDueReminders() {
    const now = Math.floor(Date.now() / 1000);
    return this.db.prepare(`
      SELECT * FROM reminders WHERE due_at <= ? AND sent = 0
    `).all(now);
  }

  markReminderSent(id, repeat) {
    if (repeat === 'daily') {
      this.db.prepare(`UPDATE reminders SET due_at = due_at + 86400 WHERE id = ?`).run(id);
    } else if (repeat === 'weekly') {
      this.db.prepare(`UPDATE reminders SET due_at = due_at + 604800 WHERE id = ?`).run(id);
    } else {
      this.db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).run(id);
    }
  }

  listReminders(chatId) {
    return this.db.prepare(`
      SELECT * FROM reminders WHERE chat_id = ? AND sent = 0 ORDER BY due_at ASC
    `).all(String(chatId));
  }

  deleteReminder(id) {
    this.db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).run(id);
  }

  // ── Stats ───────────────────────────────────────────────────────────────────
  stats(chatId) {
    const row = this.db.prepare(`
      SELECT hall, COUNT(*) as count FROM memories WHERE chat_id = ?
      GROUP BY hall
    `).all(String(chatId));
    return row;
  }

  // ── Keyword extractor ───────────────────────────────────────────────────────
  _extractKeywords(text) {
    const stopwords = new Set(['the','a','an','is','are','was','were','i','you','he','she','it',
      'we','they','this','that','and','or','but','in','on','at','to','for','of','with',
      '我','你','他','她','是','的','了','在','和','有','不','这','那','也','就','都','会',
      '可以','帮','我','给']);
    return text.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w))
      .slice(0, 20)
      .join(' ');
  }
}

module.exports = new MemPalace();
