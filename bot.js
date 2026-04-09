require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// Health check server for Render free tier
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => console.log(`Health check on :${PORT}`));

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

// ── Gmail OAuth2 ──────────────────────────────────────────────────────────────
function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_emails',
    description: 'Search Gmail emails. Returns a list of matching emails with subject, sender, date, and snippet.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:boss@company.com", "subject:invoice", "is:unread", "newer_than:2d"' },
        max_results: { type: 'number', description: 'Max emails to return (default: 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: { type: 'string', description: 'Gmail message ID' }
      },
      required: ['email_id']
    }
  },
  {
    name: 'send_email',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'list_emails',
    description: 'List recent emails from inbox.',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Number of emails to list (default: 10)' },
        label: { type: 'string', description: 'Label to filter by, e.g. INBOX, UNREAD, SENT (default: INBOX)' }
      },
      required: []
    }
  }
];

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  console.log(`  🔧 ${name}:`, JSON.stringify(input).slice(0, 100));
  const gmail = getGmailClient();

  switch (name) {
    case 'search_emails': {
      try {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: input.query,
          maxResults: input.max_results || 10
        });
        const messages = res.data.messages || [];
        if (!messages.length) return 'No emails found.';

        const details = await Promise.all(messages.map(async m => {
          const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'] });
          const headers = msg.data.payload.headers;
          const get = name => headers.find(h => h.name === name)?.value || '';
          return `ID: ${m.id}\nFrom: ${get('From')}\nDate: ${get('Date')}\nSubject: ${get('Subject')}\nSnippet: ${msg.data.snippet}`;
        }));
        return details.join('\n\n---\n\n');
      } catch (e) { return `Error: ${e.message}`; }
    }

    case 'read_email': {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: input.email_id, format: 'full' });
        const headers = msg.data.payload.headers;
        const get = n => headers.find(h => h.name === n)?.value || '';

        // Extract body
        let body = '';
        const extractBody = (part) => {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf8');
          }
          if (part.parts) part.parts.forEach(extractBody);
        };
        extractBody(msg.data.payload);

        return `From: ${get('From')}\nTo: ${get('To')}\nDate: ${get('Date')}\nSubject: ${get('Subject')}\n\n${body || msg.data.snippet}`;
      } catch (e) { return `Error: ${e.message}`; }
    }

    case 'send_email': {
      try {
        const raw = Buffer.from(
          `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${input.body}`
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
        return `✓ Email sent to ${input.to}`;
      } catch (e) { return `Error: ${e.message}`; }
    }

    case 'list_emails': {
      try {
        const res = await gmail.users.messages.list({
          userId: 'me',
          labelIds: [input.label || 'INBOX'],
          maxResults: input.max_results || 10
        });
        const messages = res.data.messages || [];
        if (!messages.length) return 'No emails found.';

        const details = await Promise.all(messages.map(async m => {
          const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'] });
          const headers = msg.data.payload.headers;
          const get = n => headers.find(h => h.name === n)?.value || '';
          return `ID: ${m.id} | ${get('Date').slice(0,16)} | ${get('From').slice(0,30)} | ${get('Subject')}`;
        }));
        return details.join('\n');
      } catch (e) { return `Error: ${e.message}`; }
    }

    default: return `Unknown tool: ${name}`;
  }
}

// ── Claude agentic loop ───────────────────────────────────────────────────────
async function processWithClaude(chatId, userMessage) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userMessage });
  while (history.length > 40) history.splice(0, 2);

  let messages = [...history];
  for (let turn = 0; turn < 15; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: `You are a personal AI assistant on Telegram for Zerlinda (zerlindamazz@gmail.com).
You have access to her Gmail — you can search, read, and send emails on her behalf.
Always reply in the same language the user writes in (Chinese or English).
Keep replies concise for mobile reading. Use markdown formatting.`,
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text?.trim() || '✓ Done.';
      history.push({ role: 'assistant', content: response.content });
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input)
          });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    break;
  }
  return '⚠️ Hit turn limit. Try /clear or a simpler request.';
}

// ── Bot commands ──────────────────────────────────────────────────────────────
bot.start(ctx => ctx.reply(
  '🤖 *Claude AI Assistant*\n\n直接发消息给我布置任务！\n\n我可以：\n• 查看和发送 Gmail 邮件\n• 回答任何问题\n• 编写代码\n• 写作、翻译、分析\n\n`/clear` — 重置对话\n`/help` — 显示帮助',
  { parse_mode: 'Markdown' }
));

bot.help(ctx => ctx.reply(
  '🤖 *Claude AI Assistant*\n\n示例：\n• `帮我查一下最新的未读邮件`\n• `搜索来自 boss@company.com 的邮件`\n• `给 xxx@gmail.com 发邮件说明天开会`\n\n`/clear` — 重置对话历史\n`/help` — 显示此帮助',
  { parse_mode: 'Markdown' }
));

bot.command('clear', ctx => {
  conversations.delete(ctx.chat.id);
  ctx.reply('🗑️ 对话已重置！');
});

bot.on('text', async ctx => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  const name = ctx.from.first_name || 'User';

  console.log(`[${new Date().toISOString()}] ${name} (${chatId}): ${text}`);
  await ctx.sendChatAction('typing');

  try {
    const reply = await processWithClaude(chatId, text);

    if (reply.length <= 4000) {
      await ctx.reply(reply, { parse_mode: 'Markdown' }).catch(() => ctx.reply(reply));
    } else {
      const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
      for (let i = 0; i < chunks.length; i++) {
        const prefix = chunks.length > 1 ? `_(${i+1}/${chunks.length})_\n` : '';
        await ctx.reply(prefix + chunks[i]).catch(() => {});
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    await ctx.reply('⚠️ 出错了，请重试或发 /clear 重置对话。');
  }
});

bot.launch().then(() => {
  console.log('🤖 Claude Telegram bot with Gmail is READY!');
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
