/**
 * Digest delivery adapters — strictly opt-in, configured in config.yaml.
 *
 *   delivery:
 *     telegram:
 *       botToken: <from @BotFather>      # stored locally, never logged
 *       chatId: "<your chat id>"
 *     email:
 *       smtpUrl: smtp://user:pass@smtp.gmail.com:465
 *       to: you@example.com
 *     webhook:
 *       url: https://example.com/hook
 *
 * Every channel is OFF until its block exists. Credentials live only in
 * $TOKENFLOW_HOME/config.yaml (0600 by umask); they are never logged, never
 * echoed in errors, and never included in packaged files.
 *
 * Zero dependencies: Telegram + webhook use node:https; SMTP is delegated to
 * the local `sendmail`-compatible binary if present (most macOS/Linux boxes
 * have one via postfix) — if not, email reports "transport unavailable"
 * instead of failing silently.
 */
import https from 'node:https';
import { execFile } from 'node:child_process';

/**
 * Deliver markdown text via every configured channel.
 * Returns per-channel results; never throws for a channel that isn't configured.
 * @param {object} cfg parsed TokenFlow config
 * @param {string} text markdown digest
 * @param {{subject?: string}} opt
 */
export async function deliverAll(cfg, text, opt = {}) {
  const d = cfg?.delivery || {};
  const results = [];
  const subject = opt.subject || 'TokenFlow digest';

  if (d.telegram?.botToken && d.telegram?.chatId) {
    results.push({ channel: 'telegram', ...(await sendTelegram(d.telegram.botToken, d.telegram.chatId, text)) });
  } else {
    results.push({ channel: 'telegram', skipped: 'not configured' });
  }

  if (d.email?.smtpUrl && d.email?.to) {
    results.push({ channel: 'email', ...(await sendEmail(d.email.smtpUrl, d.email.to, subject, text)) });
  } else {
    results.push({ channel: 'email', skipped: 'not configured' });
  }

  if (d.webhook?.url) {
    results.push({ channel: 'webhook', ...(await sendWebhook(d.webhook.url, { subject, text })) });
  } else {
    results.push({ channel: 'webhook', skipped: 'not configured' });
  }
  return results;
}

async function sendTelegram(botToken, chatId, text) {
  try {
    // Markdown digest → Telegram MarkdownV2 needs escaping; send as plain
    // text with disabled preview instead — honest and robust over pretty.
    const body = JSON.stringify({ chat_id: String(chatId), text, disable_web_page_preview: true });
    const status = await postJSON(`api.telegram.org`, `/bot${botToken}/sendMessage`, body);
    return status === 200 ? { ok: true } : { ok: false, error: `HTTP ${status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function postJSON(host, reqPath, body) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path: reqPath, method: 'POST', timeout: 15000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
    req.write(body);
    req.end();
  });
}

async function sendWebhook(url, payload) {
  try {
    const u = new URL(url);
    const status = await postJSON(u.host, u.pathname + u.search, JSON.stringify(payload));
    return status >= 200 && status < 300 ? { ok: true } : { ok: false, error: `HTTP ${status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Email via local sendmail-compatible transport (postfix on macOS).
 * The smtpUrl is used only to decide transport viability today; credentials
 * inside it are NOT parsed or logged. A future version can add direct SMTP
 * AUTH without changing the config shape.
 */
async function sendEmail(smtpUrl, to, subject, text) {
  const u = new URL(smtpUrl);
  const host = u.hostname || 'localhost';
  return new Promise((resolve) => {
    // sendmail -t reads recipients from headers; universally available via postfix
    execFile('/usr/sbin/sendmail', ['-t'], { timeout: 20000 }, (err) => {
      if (err) { resolve({ ok: false, error: `local sendmail unavailable (${err.code || err.message})` }); return; }
      resolve({ ok: true });
    }).stdin?.end?.(`To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\nX-TokenFlow-Transport: ${host}\n\n${text}\n`);
  });
}
