const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const domain = process.env.CPANEL_DOMAIN || 'montao.net';
const cpanelHost = process.env.CPANEL_HOST || `mail.${domain}`;
const imapHost = process.env.MAIL_IMAP_HOST || `mail.${domain}`;
const smtpHost = process.env.MAIL_SMTP_HOST || `mail.${domain}`;
const hosts = [...new Set([imapHost, smtpHost, cpanelHost, `mail.${domain}`])];
const checks = [
  [imapHost, Number(process.env.MAIL_IMAP_PORT || 993), 'IMAP SSL'],
  [imapHost, 143, 'IMAP plain'],
  [smtpHost, Number(process.env.MAIL_SMTP_PORT || 465), 'SMTP SSL'],
  [smtpHost, 587, 'SMTP submission'],
  [cpanelHost, Number(process.env.CPANEL_PORT || 2083), 'cPanel SSL'],
  [cpanelHost, 2082, 'cPanel plain'],
  [cpanelHost, 2096, 'Webmail SSL'],
];

function tcpCheck(host, port, label) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const startedAt = Date.now();
    let done = false;

    function finish(result) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ host, port, label, ms: Date.now() - startedAt, ...result });
    }

    socket.setTimeout(5000);
    socket.on('connect', () => finish({ ok: true }));
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.on('error', (error) => finish({ ok: false, error: error.code || error.message }));
  });
}

(async () => {
  const publicIp = await fetch('https://api.ipify.org').then((response) => response.text()).catch(() => null);
  const dnsResults = {};

  for (const host of hosts) {
    dnsResults[host] = await dns.lookup(host, { all: true }).catch((error) => ({
      error: error.code || error.message,
    }));
  }

  const tcpResults = [];
  for (const [host, port, label] of checks) {
    tcpResults.push(await tcpCheck(host, port, label));
  }

  console.log(JSON.stringify({ publicIp, domain, dns: dnsResults, tcp: tcpResults }, null, 2));
})();
