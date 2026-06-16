#!/usr/bin/env node

const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const dryRun = process.argv.includes('--dry-run');
const cpanelHost = process.env.CPANEL_HOST;
const cpanelPort = process.env.CPANEL_PORT || '2083';
const cpanelUser = process.env.CPANEL_USER;
const cpanelToken = process.env.CPANEL_TOKEN;
const domain = (process.env.CPANEL_DOMAIN || 'montao.net').toLowerCase();
const quotaMb = process.env.CPANEL_EMAIL_QUOTA_MB || '1024';

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} no esta configurado`);
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generatePassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%';
  const pool = `${letters}${digits}${symbols}`;
  const pick = (source, length) =>
    Array.from(crypto.randomBytes(length), (byte) => source[byte % source.length]).join('');

  return `${pick(letters, 1)}${pick(digits, 1)}${pick(symbols, 1)}${pick(pool, 21)}`;
}

async function cpanelApi(moduleAndFunction, params = {}, method = 'GET') {
  const url = new URL(`https://${cpanelHost}:${cpanelPort}/execute/${moduleAndFunction}`);
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `cpanel ${cpanelUser}:${cpanelToken}`,
    },
  };

  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  } else {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(params);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 500) };
  }

  if (!response.ok || payload.status !== 1) {
    const detail = payload.errors?.join('; ') || payload.message || payload.raw || response.statusText;
    throw new Error(`${moduleAndFunction} fallo (${response.status}): ${detail}`);
  }

  return payload;
}

async function getIndexUsers() {
  await mongoose.connect(process.env.MONGODB_URI);
  const emailRegex = new RegExp(`@${escapeRegex(domain)}$`, 'i');
  const users = await mongoose.connection.db
    .collection('users')
    .find({ email: emailRegex }, { projection: { email: 1, name: 1, role: 1 } })
    .sort({ email: 1 })
    .toArray();

  return users.map((user) => ({
    id: String(user._id),
    email: normalizeEmail(user.email),
    name: user.name || '',
    role: user.role || 'user',
  }));
}

async function getCpanelEmails() {
  const payload = await cpanelApi('Email/list_pops_with_disk', { domain });
  return new Set((payload.data || []).map((account) => normalizeEmail(account.email || account.login)));
}

async function createCpanelEmail(email, password) {
  const username = email.split('@')[0];
  return cpanelApi(
    'Email/add_pop',
    {
      email: username,
      domain,
      password,
      quota: quotaMb,
    },
    'POST',
  );
}

async function main() {
  requireEnv('MONGODB_URI', process.env.MONGODB_URI);
  requireEnv('CPANEL_HOST', cpanelHost);
  requireEnv('CPANEL_USER', cpanelUser);
  requireEnv('CPANEL_TOKEN', cpanelToken);

  const users = await getIndexUsers();
  const desiredEmails = [...new Set(users.map((user) => user.email))].filter(Boolean);
  const cpanelEmails = await getCpanelEmails();
  const missingEmails = desiredEmails.filter((email) => !cpanelEmails.has(email));
  const created = [];

  for (const email of missingEmails) {
    const password = generatePassword();

    if (!dryRun) {
      await createCpanelEmail(email, password);
    }

    created.push({ email, password });
  }

  const cpanelAccountsAfter = dryRun ? cpanelEmails.size : (await getCpanelEmails()).size;

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        domain,
        usersMatched: desiredEmails.length,
        cpanelAccountsBefore: cpanelEmails.size,
        cpanelAccountsAfter,
        missing: missingEmails,
        created,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
