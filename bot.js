require('dotenv').config();
const http = require('http');
const https = require('https');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const palace = require('./memory');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

// ── Health check server ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`Health check on :${PORT}`);
  setInterval(() => {
    const mod = SELF_URL.startsWith('https') ? https : http;
    mod.get(SELF_URL, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
});

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[àáâãäåæçèéêëìíîïðñòóôõöùúûüý]/i.test(text)) return 'fr_es';
  return 'en';
}

const LANG_INSTRUCTION = {
  zh: '用中文回复，保持简洁。',
  en: 'Reply in English, be concise.',
  ja: '日本語で返答してください。',
  ko: '한국어로 답변해 주세요.',
  ru: 'Отвечайте на русском языке.',
  fr_es: 'Reply in the same language as the user (French or Spanish).',
};

// ── Gmail OAuth2 ──────────────────────────────────────────────────────────────
function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function getUnreadCount() {
  try {
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 1 });
    return res.data.resultSizeEstimate || 0;
  } catch { return null; }
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_emails',
    description: 'Search Gmail emails.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:boss@co.com is:unread newer_than:3d"' },
        max_results: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_email',
    description: 'Read full content of an email by ID.',
    input_schema: {
      type: 'object',
      properties: { email_id: { type: 'string' } },
      required: ['email_id']
    }
  },
  {
    name: 'send_email',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'list_emails',
    description: 'List recent emails.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number' },
        label: { type: 'string', description: 'INBOX | UNREAD | SENT (default: INBOX)' }
      },
      required: []
    }
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder pushed to user via Telegram at a specific time.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        due_at: { type: 'string', description: 'ISO 8601 datetime, e.g. "2026-04-10T09:00:00+08:00"' },
        repeat: { type: 'string', enum: ['once', 'daily', 'weekly'] }
      },
      required: ['message', 'due_at']
    }
  },
  {
    name: 'list_reminders',
    description: 'List all active reminders.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'delete_reminder',
    description: 'Cancel a reminder by ID.',
    input_schema: {
      type: 'object',
      properties: { reminder_id: { type: 'number' } },
      required: ['reminder_id']
    }
  },
  {
    name: 'remember',
    description: 'Save an important fact about the user to long-term memory.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string' },
        category: { type: 'string', enum: ['preference', 'personal', 'work', 'task', 'language', 'other'] }
      },
      required: ['fact']
    }
  },
  {
    name: 'evolve',
    description: 'Add a new behavior rule to yourself when you notice a consistent pattern. Rules persist forever and shape all future responses.',
    input_schema: {
      type: 'object',
      properties: {
        new_rule: { type: 'string', description: 'The new behavior, e.g. "Always greet user by name", "End code replies with test suggestions"' },
        reason: { type: 'string', description: 'Why this pattern was noticed' }
      },
      required: ['new_rule', 'reason']
    }
  }
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input, chatId) {
  console.log(`  🔧 ${name}:`, JSON.stringify(input).slice(0, 120));

  if (name === 'set_reminder') {
    const due = new Date(input.due_at);
    if (isNaN(due)) return `Error: invalid date "${input.due_at}"`;
    const repeat = (!input.repeat || input.repeat === 'once') ? null : input.repeat;
    palace.addReminder(chatId, input.message, due.getTime(), repeat);
    const t = due.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const rep = repeat ? `（每${repeat === 'daily' ? '天' : '周'}重复）` : '';
    return `✓ Reminder set: "${input.message}" at ${t}${rep}`;
  }

  if (name === 'list_reminders') {
    const list = palace.listReminders(chatId);
    if (!list.length) return 'No active reminders.';
    return list.map(r => {
      const t = new Date(r.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      return `ID ${r.id}: ${r.message} @ ${t}${r.repeat ? ` [${r.repeat}]` : ''}`;
    }).join('\n');
  }

  if (name === 'delete_reminder') {
    palace.deleteReminder(input.reminder_id);
    return `✓ Reminder ${input.reminder_id} cancelled`;
  }

  if (name === 'remember') {
    palace.store(chatId, 'semantic', input.fact, { room: input.category || 'general', importance: 3 });
    return `✓ Remembered: "${input.fact}"`;
  }

  if (name === 'evolve') {
    palace.addEvolution(input.new_rule, input.reason);
    palace.store(chatId, 'evolution', `Rule: ${input.new_rule}`, { importance: 5 });
    return `✓ Evolved! New rule added: ${input.new_rule}`;
  }

  const gmail = getGmailClient();

  if (name === 'search_emails') {
    try {
      const res = await gmail.users.messages.list({ userId: 'me', q: input.query, maxResults: input.max_results || 10 });
      const msgs = res.data.messages || [];
      if (!msgs.length) return 'No emails found.';
      const details = await Promise.all(msgs.map(async m => {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] });
        const h = msg.data.payload.headers;
        const g = n => h.find(x => x.name === n)?.value || '';
        return `ID: ${m.id}\nFrom: ${g('From')}\nDate: ${g('Date')}\nSubject: ${g('Subject')}\n${msg.data.snippet}`;
      }));
      return details.join('\n\n---\n\n');
    } catch (e) { return `Error: ${e.message}`; }
  }

  if (name === 'read_email') {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: input.email_id, format: 'full' });
      const h = msg.data.payload.headers;
      const g = n => h.find(x => x.name === n)?.value || '';
      let body = '';
      const extract = p => {
        if (p.mimeType === 'text/plain' && p.body?.data) body += Buffer.from(p.body.data, 'base64').toString('utf8');
        if (p.parts) p.parts.forEach(extract);
      };
      extract(msg.data.payload);
      return `From: ${g('From')}\nDate: ${g('Date')}\nSubject: ${g('Subject')}\n\n${body || msg.data.snippet}`;
    } catch (e) { return `Error: ${e.message}`; }
  }

  if (name === 'send_email') {
    try {
      const raw = Buffer.from(
        `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.body}`
      ).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      return `✓ Email sent to ${input.to}`;
    } catch (e) { return `Error: ${e.message}`; }
  }

  if (name === 'list_emails') {
    try {
      const res = await gmail.users.messages.list({ userId: 'me', labelIds: [input.label || 'INBOX'], maxResults: input.max_results || 10 });
      const msgs = res.data.messages || [];
      if (!msgs.length) return 'No emails.';
      const details = await Promise.all(msgs.map(async m => {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] });
        const h = msg.data.payload.headers;
        const g = n => h.find(x => x.name === n)?.value || '';
        return `${m.id} | ${g('Date').slice(0,16)} | ${g('From').slice(0,25)} | ${g('Subject')}`;
      }));
      return details.join('\n');
    } catch (e) { return `Error: ${e.message}`; }
  }

  return `Unknown tool: ${name}`;
}

// ── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(chatId, lang = 'zh') {
  const langInstr = LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.en;

  let system = `You are Zerlinda's personal AI assistant on Telegram. Her email: zerlindamazz@gmail.com.

## Core capabilities
- Access Gmail: search, read, send emails
- Long-term memory: use \`remember\` to save facts about her
- Reminders: use \`set_reminder\` to schedule push notifications
- Self-evolution: use \`evolve\` when you notice a recurring pattern

## Language
${langInstr}
You can understand and respond in: Chinese, English, Japanese, Korean, Russian, French, Spanish, and more.
Always match the language the user writes in.

## Behavior
- Be proactive: if you notice something important from memory, mention it
- Be warm but concise — this is a mobile chat
- When user mentions deadlines, tasks, or important things → save them with \`remember\`
- When user shows a consistent preference → save it with \`evolve\``;

  // Self-evolution rules
  const evolutions = palace.getEvolutions();
  if (evolutions.length) {
    system += '\n\n## Your evolved behaviors (learned from this user):\n';
    system += evolutions.map(e => `- ${e.rule}`).join('\n');
  }

  // User profile facts
  const profile = palace.getProfile(chatId);
  const facts = Object.entries(profile)
    .filter(([k]) => !k.startsWith('last_fact_') && k !== 'updated_at' && k !== 'chatId' && k !== 'lang');
  if (facts.length) {
    system += '\n\n## What you know about Zerlinda:\n';
    system += facts.map(([k, v]) => `- ${k}: ${v}`).join('\n');
  }

  return system;
}

// ── Claude agentic loop ───────────────────────────────────────────────────────
async function processWithClaude(chatId, userMessage, forceLang = null) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);

  const lang = forceLang || detectLang(userMessage);

  // Update stored language preference
  const profile = palace.getProfile(chatId);
  if (!profile.lang || profile.lang !== lang) {
    palace.updateProfile(chatId, { lang });
  }

  // Recall relevant memories
  const memories = palace.recall(chatId, userMessage, { limit: 5 });
  const memBlock = memories.length
    ? `\n\n[Memory context:\n${memories.join('\n')}\n]`
    : '';

  const userContent = userMessage + memBlock;
  history.push({ role: 'user', content: userContent });
  while (history.length > 30) history.splice(0, 2);

  let messages = [...history];
  let finalReply = '';

  for (let turn = 0; turn < 15; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(chatId, lang),
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      finalReply = response.content.find(b => b.type === 'text')?.text?.trim() || '✓';
      history.push({ role: 'assistant', content: finalReply });
      break;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input, chatId)
          });
        }
      }
      messages.push({ role: 'user', content: results });
      const t = response.content.find(b => b.type === 'text')?.text;
      if (t) finalReply = t;
      continue;
    }
    break;
  }

  if (finalReply) palace.storeEpisode(chatId, userMessage, finalReply);
  return finalReply || '⚠️ No response.';
}

// ── Proactive morning greeting (9am Shanghai) ─────────────────────────────────
async function sendMorningGreeting(chatId) {
  console.log(`[Morning greeting] → ${chatId}`);
  try {
    // Gather context
    const reminders = palace.listReminders(String(chatId));
    const todayReminders = reminders.filter(r => {
      const due = new Date(r.dueAt);
      const now = new Date();
      return due.toDateString() === now.toDateString();
    });
    const unread = await getUnreadCount();
    const memories = palace.recall(String(chatId), 'task deadline important work', { limit: 4 });
    const profile = palace.getProfile(String(chatId));
    const lang = profile.lang || 'zh';

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long', month: 'long', day: 'numeric' });

    const context = [
      `Today: ${now}`,
      todayReminders.length ? `Today's reminders: ${todayReminders.map(r => r.message).join('; ')}` : 'No reminders today.',
      unread !== null ? `Unread emails: ${unread}` : '',
      memories.length ? `Recent important memories:\n${memories.join('\n')}` : ''
    ].filter(Boolean).join('\n');

    const prompt = `Generate a warm, personalized morning greeting for Zerlinda based on:
${context}

Keep it SHORT (3-5 lines). ${LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.en}
Mention today's tasks/reminders if any. If unread emails > 0, briefly mention it.
Be encouraging and natural — like a smart assistant who cares.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const greeting = response.content[0]?.text || '早安！今天也加油 ☀️';
    await bot.telegram.sendMessage(chatId, `☀️ ${greeting}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`[Morning greeting error] ${e.message}`);
  }
}

// ── Proactive weekly check-in (Monday 9am) ───────────────────────────────────
async function sendWeeklyCheckIn(chatId) {
  try {
    const memories = palace.recall(String(chatId), 'task work deadline project', { limit: 6 });
    const profile = palace.getProfile(String(chatId));
    const lang = profile.lang || 'zh';

    const prompt = `Generate a brief Monday morning weekly check-in message for Zerlinda.
Known context:\n${memories.join('\n') || 'No recent context.'}
Keep it to 3-4 lines. ${LANG_INSTRUCTION[lang] || LANG_INSTRUCTION.en}
Ask what her main focus is for this week. Be warm and motivating.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    const msg = response.content[0]?.text || '新的一周开始了！本周有什么重点任务吗？';
    await bot.telegram.sendMessage(chatId, `📅 ${msg}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`[Weekly check-in error] ${e.message}`);
  }
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Check reminders every minute
cron.schedule('* * * * *', async () => {
  const due = palace.getDueReminders();
  for (const r of due) {
    try {
      await bot.telegram.sendMessage(r.chatId, `⏰ *提醒*\n\n${r.message}`, { parse_mode: 'Markdown' });
      palace.markReminderSent(r.id, r.repeat);
      console.log(`[Reminder] → ${r.chatId}: ${r.message}`);
    } catch (e) { console.error(`[Reminder error] ${e.message}`); }
  }
});

// Morning greeting: 9:00am Shanghai (01:00 UTC)
cron.schedule('0 1 * * *', async () => {
  const chatIds = palace.getAllChatIds();
  for (const id of chatIds) await sendMorningGreeting(id);
}, { timezone: 'UTC' });

// Weekly check-in: Monday 9:00am Shanghai
cron.schedule('0 1 * * 1', async () => {
  const chatIds = palace.getAllChatIds();
  for (const id of chatIds) await sendWeeklyCheckIn(id);
}, { timezone: 'UTC' });

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.start(async ctx => {
  const chatId = ctx.chat.id;
  // Register this chat for proactive messages
  palace.updateProfile(chatId, { chatId: String(chatId), name: ctx.from.first_name || 'Zerlinda' });
  await ctx.reply(
    '🤖 *Claude AI — Personal Assistant*\n\n' +
    '功能 / Features:\n' +
    '• 📧 Gmail — 查邮件、发邮件\n' +
    '• 🧠 长期记忆 Long-term memory\n' +
    '• ⏰ 智能提醒 Smart reminders\n' +
    '• ☀️ 每日早安问候 Daily morning greeting\n' +
    '• 🧬 自我进化 Self-evolving\n' +
    '• 🌍 多语言 Multilingual\n\n' +
    '命令 / Commands:\n' +
    '`/reminders` `/memory` `/profile` `/clear`',
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', ctx => {
  conversations.delete(ctx.chat.id);
  ctx.reply('🗑️ Session cleared (long-term memory kept)');
});

bot.command('memory', ctx => {
  const stats = palace.stats(ctx.chat.id);
  if (!stats.length) return ctx.reply('No memory yet. Chat more and I\'ll remember!');
  const lines = stats.map(s => `• ${s.hall}: ${s.count}`).join('\n');
  ctx.reply(`🧠 *Memory Stats*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('reminders', ctx => {
  const list = palace.listReminders(ctx.chat.id);
  if (!list.length) return ctx.reply('No active reminders.\n\nSay "remind me tomorrow 9am to check emails" to set one!');
  const lines = list.map(r => {
    const t = new Date(r.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `*ID ${r.id}*${r.repeat ? ` 🔁${r.repeat}` : ''}\n${r.message}\n⏰ ${t}`;
  }).join('\n\n');
  ctx.reply(`⏰ *Active Reminders*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('profile', ctx => {
  const profile = palace.getProfile(ctx.chat.id);
  const keys = Object.keys(profile).filter(k => !['chatId','updated_at'].includes(k) && !k.startsWith('last_fact_'));
  if (!keys.length) return ctx.reply('No profile data yet. The more we chat, the more I learn about you!');
  const lines = keys.map(k => `• *${k}*: ${profile[k]}`).join('\n');
  ctx.reply(`👤 *Your Profile*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('goodmorning', async ctx => {
  await sendMorningGreeting(ctx.chat.id);
});

bot.on('text', async ctx => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;

  // Register chat_id on first interaction
  const profile = palace.getProfile(chatId);
  if (!profile.chatId) {
    palace.updateProfile(chatId, { chatId: String(chatId), name: ctx.from.first_name || 'User' });
  }

  console.log(`[${new Date().toISOString()}] ${ctx.from.first_name} (${chatId}): ${text.slice(0,80)}`);
  await ctx.sendChatAction('typing');

  try {
    const reply = await processWithClaude(chatId, text);
    if (reply.length <= 4000) {
      await ctx.reply(reply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(reply));
    } else {
      const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
      for (let i = 0; i < chunks.length; i++) {
        await ctx.reply((chunks.length > 1 ? `_(${i+1}/${chunks.length})_\n` : '') + chunks[i]).catch(() => {});
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    await ctx.reply('⚠️ Error, please retry or /clear');
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Claude Bot [Memory + Evolution + Proactive Greetings + Multilingual] READY!');
}).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
