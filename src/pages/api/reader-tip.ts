export const prerender = false;

import type { APIRoute } from 'astro';

const TYPE_META: Record<string, { emoji: string; label: string; color: number }> = {
  event:      { emoji: '📅', label: 'Event Submission', color: 0x3b82f6 },
  tip:        { emoji: '📰', label: 'News Tip',         color: 0x22c55e },
  correction: { emoji: '⚠️',  label: 'Correction',       color: 0xf97316 },
  feedback:   { emoji: '💬', label: 'Feedback',          color: 0x8b5cf6 },
};

export const POST: APIRoute = async ({ request }) => {
  const webhookUrl = import.meta.env.SBS_DISCORD_WEBHOOK;
  if (!webhookUrl) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500 });
  }

  let body: { type?: string; message?: string; page?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { type = 'feedback', message, page } = body;
  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message required' }), { status: 400 });
  }

  const meta = TYPE_META[type] ?? TYPE_META.feedback;
  const pageStr = page ? ` — ${page}` : '';

  const payload = {
    content: `${meta.emoji} **${meta.label}**${pageStr}`,
    embeds: [{
      title: `${meta.emoji} ${meta.label}`,
      description: message.trim().slice(0, 2000),
      color: meta.color,
      fields: page ? [{ name: 'URL', value: page.slice(0, 200), inline: false }] : [],
      timestamp: new Date().toISOString(),
      footer: { text: 'South Bay Signal reader submission' },
    }],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('Discord webhook failed:', res.status, await res.text());
      return new Response(JSON.stringify({ error: 'Webhook failed' }), { status: 502 });
    }
  } catch (err) {
    console.error('Discord webhook error:', err);
    return new Response(JSON.stringify({ error: 'Network error' }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
