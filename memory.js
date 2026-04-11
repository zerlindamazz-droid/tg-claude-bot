/**
 * MemPalace-inspired memory system — pure JS, no native compilation
 * Storage: lowdb (JSON file)
 */
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const DB_PATH = process.env.MEMORY_DB || path.join(__dirname, 'palace.json');
const adapter = new FileSync(DB_PATH);
const db = low(adapter);

db.defaults({
  memories: [],
  profiles: {},
  evolutions: [],
  reminders: [],
  _nextId: 1
}).write();

function nextId() {
  const id = db.get('_nextId').value();
  db.set('_nextId', id + 1).write();
  return id;
}

function extractKeywords(text) {
  const stop = new Set(['the','a','an','is','are','i','you','we','they','and','or','in','on','to','for','of',
    '我','你','他','是','的','了','在','和','有','不','这','那','也','就']);
  return text.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g,' ')
    .split(/\s+/).filter(w => w.length > 1 && !stop.has(w)).slice(0,15);
}

const palace = {
  // ── Memories ────────────────────────────────────────────────────────────────
  store(chatId, hall, content, { room = null, importance = 1 } = {}) {
    db.get('memories').push({
      id: nextId(), chatId: String(chatId), hall, room, content,
      keywords: extractKeywords(content), importance,
      createdAt: Date.now(), accessCount: 0
    }).write();
  },

  storeEpisode(chatId, userMsg, botReply) {
    this.store(chatId, 'episodic', `User: ${userMsg}\nBot: ${botReply}`, { importance: 1 });
  },

  recall(chatId, query, { limit = 5 } = {}) {
    const qKeywords = extractKeywords(query);
    const all = db.get('memories').filter({ chatId: String(chatId) }).value();
    if (!qKeywords.length) {
      return all.slice(-limit).map(m => `[${m.hall}] ${m.content}`);
    }
    const scored = all.map(m => {
      const score = qKeywords.filter(k => m.keywords.includes(k) || m.content.toLowerCase().includes(k)).length
        * m.importance;
      return { ...m, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    return scored.map(m => `[${m.hall}/${m.room || 'general'}] ${m.content}`);
  },

  // ── User profile ────────────────────────────────────────────────────────────
  getProfile(chatId) {
    return db.get(`profiles.${String(chatId)}`).value() || {};
  },

  updateProfile(chatId, updates) {
    const current = this.getProfile(chatId);
    const merged = { ...current, ...updates };
    db.set(`profiles.${String(chatId)}`, merged).write();
    return merged;
  },

  // ── Self-evolution ──────────────────────────────────────────────────────────
  getEvolutions() {
    return db.get('evolutions').value().slice(-10);
  },

  addEvolution(rule, reason) {
    db.get('evolutions').push({ id: nextId(), rule, reason, createdAt: Date.now() }).write();
    console.log(`[Evolution] ${reason}: ${rule}`);
  },

  // ── Reminders ───────────────────────────────────────────────────────────────
  addReminder(chatId, message, dueAtMs, repeat = null) {
    db.get('reminders').push({
      id: nextId(), chatId: String(chatId), message,
      dueAt: dueAtMs, repeat, sent: false
    }).write();
  },

  getDueReminders() {
    const now = Date.now();
    return db.get('reminders').filter(r => !r.sent && r.dueAt <= now).value();
  },

  markReminderSent(id, repeat) {
    if (repeat === 'daily') {
      db.get('reminders').find({ id }).assign({ dueAt: db.get('reminders').find({ id }).value().dueAt + 86400000 }).write();
    } else if (repeat === 'weekly') {
      db.get('reminders').find({ id }).assign({ dueAt: db.get('reminders').find({ id }).value().dueAt + 604800000 }).write();
    } else {
      db.get('reminders').find({ id }).assign({ sent: true }).write();
    }
  },

  listReminders(chatId) {
    return db.get('reminders').filter(r => r.chatId === String(chatId) && !r.sent)
      .sortBy('dueAt').value();
  },

  deleteReminder(id) {
    db.get('reminders').find({ id }).assign({ sent: true }).write();
  },

  // ── Stats ───────────────────────────────────────────────────────────────────
  stats(chatId) {
    const all = db.get('memories').filter({ chatId: String(chatId) }).value();
    const counts = {};
    all.forEach(m => { counts[m.hall] = (counts[m.hall] || 0) + 1; });
    return Object.entries(counts).map(([hall, count]) => ({ hall, count }));
  }
};

module.exports = palace;
