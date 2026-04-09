require('dotenv').config();
const http = require('http');
const https = require('https');
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const palace = require('./memory');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map(); // in-session history

// ── Health check + Heartbeat (keeps Render from sleeping) ────────────────────
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`Health check on :${PORT}`);
  // Ping self every 10 min so Render doesn't spin down
  setInterval(() => {
    const url = new URL(SELF_URL);
    const mod = url.protocol === 'https:' ? https : http;
    mod.get(SELF_URL, r => console.log(`[Heartbeat] ${r.statusCode}`))
       .on('error', e => console.log(`[Heartbeat error] ${e.message}`));
  }, 10 * 60 * 1000);
});

// ── Gmail OAuth2 ─────────────────────────────────────────────────────────────
function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

// ── Tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_emails',
    description: 'Search Gmail emails.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query e.g. "from:boss@co.com", "is:unread", "newer_than:3d"' },
        max_results: { type: 'number', description: 'Max results (default 10)' }
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
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'list_emails',
    description: 'List recent emails from a label.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number' },
        label: { type: 'string', description: 'INBOX, UNREAD, SENT (default INBOX)' }
      },
      required: []
    }
  },
  {
    name: 'remember',
    description: 'Save an important fact about the user to long-term memory.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember, e.g. "User prefers concise replies"' },
        category: { type: 'string', enum: ['preference', 'personal', 'work', 'task', 'other'], description: 'Category of fact' }
      },
      required: ['fact']
    }
  },
  {
    name: 'evolve',
    description: 'Add a new rule or behavior to your own system prompt when you notice a pattern in how this user wants things done.',
    input_schema: {
      type: 'object',
      properties: {
        new_rule: { type: 'string', description: 'A new behavior rule to add to yourself, e.g. "Always end task summaries with a bullet list"' },
        reason: { type: 'string', description: 'Why you are adding this rule' }
      },
      required: ['new_rule', 'reason']
    }
  }
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input, chatId) {
  console.log(`  🔧 ${name}:`, JSON.stringify(input).slice(0, 120));

  if (name === 'remember') {
    palace.store(chatId, 'semantic', input.fact, { room: input.category || 'general', importance: 3 });
    palace.updateProfile(chatId, { [`last_fact_${Date.now()}`]: input.fact });
    return `✓ Remembered: "${input.fact}"`;
  }

  if (name === 'evolve') {
    palace.addEvolution(input.new_rule, input.reason);
    palace.store(chatId, 'evolution', `New rule: ${input.new_rule} (Reason: ${input.reason})`, { importance: 5 });
    return `✓ Evolved: added new rule — ${input.new_rule}`;
  }

  const gmail = getGmailClient();

  if (name === 'search_emails') {
    try {
      const res = await gmail.users.messages.list({ userId: 'me', q: input.query, maxResults: input.max_results || 10 });
      const messages = res.data.messages || [];
      if (!messages.length) return 'No emails found.';
      const details = await Promise.all(messages.map(async m => {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','Date'] });
        const h = msg.data.payload.headers;
        const g = n => h.find(x => x.name === n)?.value || '';
        return `ID: ${m.id}\nFrom: ${g('From')}\nDate: ${g('Date')}\nSubject: ${g('Subject')}\nSnippet: ${msg.data.snippet}`;
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
      const extractBody = p => {
        if (p.mimeType === 'text/plain' && p.body?.data) body += Buffer.from(p.body.data, 'base64').toString('utf8');
        if (p.parts) p.parts.forEach(extractBody);
      };
      extractBody(msg.data.payload);
      return `From: ${g('From')}\nTo: ${g('To')}\nDate: ${g('Date')}\nSubject: ${g('Subject')}\n\n${body || msg.data.snippet}`;
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
      const messages = res.data.messages || [];
      if (!messages.length) return 'No emails found.';
      const details = await Promise.all(messages.map(async m => {
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

// ── Build system prompt with memory + evolution ───────────────────────────────
function buildSystemPrompt(chatId) {
  // Base
  let system = `You are a personal AI assistant on Telegram for Zerlinda (zerlindamazz@gmail.com).
You have access to her Gmail — you can search, read, and send emails.
You have long-term memory — use the \`remember\` tool to save important facts about the user.
You can evolve yourself — use the \`evolve\` tool when you notice a pattern in how the user wants things done.
Always reply in the same language as the user (Chinese or English). Keep replies concise for mobile.`;

  // Inject learned evolutions
  const evolutions = palace.getEvolutions();
  if (evolutions.length) {
    system += '\n\n## Your learned behaviors (self-evolution):\n';
    system += evolutions.map(e => `- ${e.system_additions}`).join('\n');
  }

  // Inject user profile
  const profile = palace.getProfile(chatId);
  const profileKeys = Object.keys(profile).filter(k => !k.startsWith('last_fact_') && k !== 'updated_at');
  if (profileKeys.length) {
    system += '\n\n## Known facts about this user:\n';
    system += profileKeys.map(k => `- ${k}: ${profile[k]}`).join('\n');
  }

  return system;
}

// ── Claude agentic loop ───────────────────────────────────────────────────────
async function processWithClaude(chatId, userMessage) {
  // Session history
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const sessionHistory = conversations.get(chatId);

  // Retrieve relevant long-term memories
  const memories = palace.recall(chatId, userMessage, { limit: 5 });

  // Build context injection
  let contextBlock = '';
  if (memories.length) {
    contextBlock = `\n\n[Relevant memories from past conversations:\n${memories.join('\n')}\n]`;
  }

  const userContent = userMessage + contextBlock;
  sessionHistory.push({ role: 'user', content: userContent });
  while (sessionHistory.length > 30) sessionHistory.splice(0, 2);

  const systemPrompt = buildSystemPrompt(chatId);
  let messages = [...sessionHistory];
  let finalReply = '';

  for (let turn = 0; turn < 15; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      finalReply = response.content.find(b => b.type === 'text')?.text?.trim() || '✓';
      sessionHistory.push({ role: 'assistant', content: finalReply });
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

      // Capture text blocks as partial reply
      const textBlock = response.content.find(b => b.type === 'text')?.text;
      if (textBlock) finalReply = textBlock;
      continue;
    }
    break;
  }

  // Store episode in long-term memory
  if (finalReply) palace.storeEpisode(chatId, userMessage, finalReply);

  return finalReply || '⚠️ No response.';
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.start(ctx => ctx.reply(
  '🤖 *Claude AI — Memory Edition*\n\n我有长期记忆，每次对话都会记住重要信息。\n\n功能：\n• 📧 查看/发送 Gmail\n• 🧠 长期记忆\n• 🧬 自我进化\n\n命令：\n`/memory` — 查看记忆统计\n`/profile` — 查看用户画像\n`/clear` — 重置本次对话\n`/help` — 帮助',
  { parse_mode: 'Markdown' }
));

bot.help(ctx => ctx.reply(
  '🤖 *Claude AI Assistant*\n\n示例任务：\n• `帮我查最新邮件`\n• `记住我喜欢简短回复`\n• `给 xxx@gmail.com 发邮件`\n\n`/memory` — 记忆统计\n`/profile` — 用户画像\n`/clear` — 重置对话',
  { parse_mode: 'Markdown' }
));

bot.command('clear', ctx => {
  conversations.delete(ctx.chat.id);
  ctx.reply('🗑️ 本次对话已重置（长期记忆保留）');
});

bot.command('memory', ctx => {
  const stats = palace.stats(ctx.chat.id);
  if (!stats.length) return ctx.reply('暂无记忆数据。');
  const lines = stats.map(s => `• ${s.hall}: ${s.count} 条`).join('\n');
  ctx.reply(`🧠 *记忆统计*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('profile', ctx => {
  const profile = palace.getProfile(ctx.chat.id);
  const keys = Object.keys(profile).filter(k => !k.startsWith('last_fact_') && k !== 'updated_at');
  if (!keys.length) return ctx.reply('暂无用户画像数据。对话越多，我了解你越多！');
  const lines = keys.map(k => `• *${k}*: ${profile[k]}`).join('\n');
  ctx.reply(`👤 *用户画像*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.on('text', async ctx => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
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
    await ctx.reply('⚠️ 出错了，请重试或发 /clear');
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Claude Telegram bot [Memory + Evolution + Heartbeat] READY!');
  console.log(`📊 Memory DB: ${process.env.MEMORY_DB || 'palace.db'}`);
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
