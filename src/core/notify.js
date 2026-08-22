/**
 * Best-effort OS notifications.
 *
 * TokenFlow's privacy model forbids network calls, so alerts surface through
 * whatever the operating system already provides: osascript on macOS,
 * notify-send on Linux, a toast via PowerShell on Windows 10/11. Everything
 * here is fire-and-forget: a missing or failing notifier degrades to silence
 * (the status file still records the alert), never to a crash or a hang.
 */
import { spawn } from 'node:child_process';

/** Escape a string for an AppleScript double-quoted literal. */
export function appleScriptEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape for XML text nodes (PowerShell toast content travels as XML). */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Show a notification. Resolves regardless of delivery outcome.
 * @param {{title:string, body?:string}} p
 */
export function notify({ title, body = '' }) {
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 240);
  try {
    switch (process.platform) {
      case 'darwin': {
        const script = `display notification "${appleScriptEscape(b)}" with title "${appleScriptEscape(t)}"`;
        return spawnDetached('osascript', ['-e', script]);
      }
      case 'win32': {
        // EncodedCommand sidesteps every quoting hazard between cmd, PowerShell
        // and the XML payload. The well-known PowerShell AppId is what makes
        // the toast appear on systems where "TokenFlow" itself has no identity.
        const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$xml.GetElementsByTagName('text').Item(0).AppendChild($xml.CreateTextNode('${xmlEscape(t)}')) | Out-Null
$xml.GetElementsByTagName('text').Item(1).AppendChild($xml.CreateTextNode('${xmlEscape(b)}')) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;
        const encoded = Buffer.from(ps, 'utf16le').toString('base64');
        return spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
      }
      default: {
        // Linux and the BSDs: the freedesktop desktop-notification spec.
        return spawnDetached('notify-send', ['-a', 'TokenFlow', t, b]);
      }
    }
  } catch (err) {
    // Notifications are strictly additive; a broken notifier must never take
    // the watch daemon down. The transition is still recorded in status.json.
    return Promise.resolve({ delivered: false, reason: err.message });
  }
}

function spawnDetached(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (err) => resolve({ delivered: false, reason: err.message }));
      child.once('spawn', () => resolve({ delivered: true }));
      child.unref();
      // Belt and braces: a notifier that never emits either event must not
      // hold the event loop open.
      setTimeout(() => resolve({ delivered: false, reason: 'timeout' }), 3000).unref();
    } catch (err) {
      resolve({ delivered: false, reason: err.message });
    }
  });
}
