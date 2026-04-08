require('dotenv').config();
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();

async function processWithClaude(chatId, userMessage) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userMessage });
  while (history.length > 40) history.splice(0, 2);

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: `You are a personal AI assistant on Telegram. You are a helpful, knowledgeable assistant.
Always reply in the same language the user writes in (Chinese or English).
Keep replies concise for mobile reading. Use markdown formatting.`,
    messages: [...history]
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '✓ Done.';
  history.push({ role: 'assistant', content: text });
  return text;
}

bot.start(ctx => ctx.reply(
  '🤖 *Claude AI Assistant*\n\n直接发消息给我布置任务！\n\n我可以：\n• 回答任何问题\n• 编写代码\n• 写作、翻译、分析\n• 任何 AI 任务\n\n`/clear` — 重置对话\n`/help` — 显示帮助',
  { parse_mode: 'Markdown' }
));

bot.help(ctx => ctx.reply(
  '🤖 *Claude AI Assistant*\n\n直接发消息布置任务，比如：\n• `帮我写一个 Python 脚本`\n• `解释一下这段代码`\n• `翻译这段文字`\n\n`/clear` — 重置对话历史\n`/help` — 显示此帮助',
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
  console.log('🤖 Claude Telegram bot is READY!');
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
