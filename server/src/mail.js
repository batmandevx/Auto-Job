import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

// Reads recent Gmail messages (read-only) to find sign-in / verification codes and "verify your email" links.
// Uses IMAP with a Gmail App Password from server/.env; reading never sends, moves or deletes anything.
// sendApplication() is the one function that sends, and only runs when you press Send in the panel.

export const mailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

function client() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
    logger: false,
  });
}

export async function mailStatus() {
  if (!mailConfigured()) return { ok: false, error: 'Set GMAIL_USER and GMAIL_APP_PASSWORD in server/.env' };
  const c = client();
  try {
    await c.connect();
    const box = await c.mailboxOpen('INBOX', { readOnly: true });
    return { ok: true, user: process.env.GMAIL_USER, messages: box.exists };
  } catch (e) {
    return { ok: false, error: e.responseText || e.message };
  } finally {
    await c.logout().catch(() => {});
  }
}

const CODE_WORDS = /(verification|security|one[-\s]?time|confirmation|access|login|sign[-\s]?in|authentication)?\s*(code|otp|passcode|pin)\b/i;
const LINK_WORDS = /verify|verification|confirm|activate|validate|magic|sign[-_]?in|login|complete.?registration/i;

// Pull the most likely code out of an email: a 4-8 character token right after a "code" phrase,
// or on a line of its own, preferring digits. Years, prices and phone-like numbers are skipped.
export function extractCode(subject, text) {
  const body = `${subject}\n${text}`.replace(/ /g, ' ');
  const near = [...body.matchAll(/(?:code|otp|passcode|pin)(?:\s*(?:is|:|-|=))?\s*[:\-]?\s*\n?\s*([A-Z0-9]{4,8})\b/gi)].map((m) => m[1]);
  const alone = [...body.matchAll(/^\s*([0-9]{4,8}|[A-Z0-9]{6,8})\s*$/gm)].map((m) => m[1]);
  const looksLikeCode = (t) => /\d/.test(t) && !/^(19|20)\d{2}$/.test(t) && !/^0+$/.test(t);
  const pick = [...near, ...alone].find(looksLikeCode);
  if (pick) return pick;
  if (CODE_WORDS.test(body)) return [...body.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]).find(looksLikeCode) || null;
  return null;
}

export function extractLinks(html, text) {
  const hrefs = [...String(html || '').matchAll(/href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(([, url, label]) => ({
    url: url.replace(/&amp;/g, '&'),
    label: label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
  const plain = [...String(text || '').matchAll(/https?:\/\/[^\s<>")]+/g)].map((m) => ({ url: m[0], label: '' }));
  return [...hrefs, ...plain].filter((l) => LINK_WORDS.test(l.url) || LINK_WORDS.test(l.label)).filter((l) => !/unsubscribe|privacy|preferences|support/i.test(l.url + l.label));
}

// Newest matching message received after `since` (ms). `hint` (company / site words) ranks senders.
export async function findVerification({ since, hint = '', want = 'any' }) {
  if (!mailConfigured()) throw new Error('Gmail is not connected: add GMAIL_USER and GMAIL_APP_PASSWORD to server/.env');
  const c = client();
  await c.connect();
  try {
    await c.mailboxOpen('INBOX', { readOnly: true });
    const sinceDate = new Date(since - 24 * 3600_000); // IMAP SINCE is by day
    const uids = (await c.search({ since: sinceDate }, { uid: true })) || [];
    const recent = uids.slice(-25).reverse();
    if (!recent.length) return null;
    const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const found = [];
    for await (const msg of c.fetch(recent, { uid: true, internalDate: true, source: true }, { uid: true })) {
      if (msg.internalDate.getTime() < since - 60_000) continue;
      const mail = await simpleParser(msg.source);
      const subject = mail.subject || '';
      const text = mail.text || '';
      const from = mail.from?.text || '';
      const code = want === 'link' ? null : extractCode(subject, text);
      const links = want === 'code' ? [] : extractLinks(mail.html, text);
      if (!code && !links.length) continue;
      const hay = `${from} ${subject}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      found.push({ code, link: links[0]?.url || null, from, subject, at: msg.internalDate.toISOString(), score });
    }
    found.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
    return found[0] || null;
  } finally {
    await c.logout().catch(() => {});
  }
}

// Send one application email from your Gmail (SMTP, same App Password). Called only after you confirm in the panel.
export async function sendApplication({ to, cc, subject, body, attachments = [] }) {
  if (!mailConfigured()) throw new Error('Gmail is not connected: add GMAIL_USER and GMAIL_APP_PASSWORD to server/.env');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') },
  });
  const info = await transport.sendMail({
    from: process.env.GMAIL_USER,
    to,
    cc: cc || undefined,
    subject,
    text: body,
    attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.base64, 'base64'), contentType: a.mime || 'application/pdf' })),
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

export async function smtpCheck() {
  if (!mailConfigured()) return { ok: false, error: 'Gmail not connected' };
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } });
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
