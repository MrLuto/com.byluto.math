'use strict';

const https = require('https');
const crypto = require('crypto');

const DEBUG_ENABLED_SETTING_KEY = 'debug_enabled';
const DEBUG_CID_SETTING_KEY = 'debug_cid';
const DEBUG_ENDPOINT = 'https://gas.byluto.nl/lc/';
const MAX_MESSAGE_LENGTH = 1500;
const MAX_BUFFERED_ENTRIES = 250;

function generateDebugCid() {
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') {
    value = String(value);
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...<truncated>`;
}

function shouldRedact(key) {
  return /password|token|cookie|authorization|secret|authenticity|csrf/i.test(String(key));
}

function sanitize(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncate(value.stack || '', 1200),
      cause: sanitize(value.cause, seen),
    };
  }

  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return truncate(value, 1200);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, seen));
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[circular]';
  }

  seen.add(value);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = shouldRedact(key) ? '[redacted]' : sanitize(entry, seen);
  }
  seen.delete(value);
  return output;
}

function chunkMessage(message) {
  if (message.length <= MAX_MESSAGE_LENGTH) {
    return [message];
  }

  const parts = [];
  for (let index = 0; index < message.length; index += MAX_MESSAGE_LENGTH) {
    parts.push(message.slice(index, index + MAX_MESSAGE_LENGTH));
  }

  return parts.map((part, index) => `[${index + 1}/${parts.length}] ${part}`);
}

class DebugLogger {
  constructor(homey, localLog, localError) {
    this.homey = homey;
    this.localLog = localLog;
    this.localError = localError;
    this.queue = Promise.resolve();
    this.buffer = [];
  }

  ensureCid() {
    const existing = this.homey.settings.get(DEBUG_CID_SETTING_KEY);
    if (typeof existing === 'string' && existing.trim() !== '') {
      return existing.trim();
    }

    const generated = generateDebugCid();
    this.homey.settings.set(DEBUG_CID_SETTING_KEY, generated);
    return generated;
  }

  isEnabled() {
    return this.homey.settings.get(DEBUG_ENABLED_SETTING_KEY) === true;
  }

  capture(level, source, args, forceRemote = false) {
    const enabled = this.isEnabled();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message: args.map((arg) => (typeof arg === 'string' ? arg : '')).filter(Boolean).join(' ').trim() || source,
      data: sanitize(args),
    };
    const payload = JSON.stringify(entry);

    if (!enabled && !forceRemote) {
      this.buffer.push(payload);
      if (this.buffer.length > MAX_BUFFERED_ENTRIES) {
        this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_ENTRIES);
      }
      return;
    }

    this.queue = this.queue
      .then(async () => {
        if (forceRemote && enabled && this.buffer.length > 0) {
          const snapshot = this.buffer.splice(0, this.buffer.length);
          await this.sendRaw(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'info',
            source: 'debug-buffer',
            message: 'Flushing buffered debug entries',
            data: { count: snapshot.length },
          }));

          for (const item of snapshot) {
            await this.sendRaw(item);
          }
        }

        await this.sendRaw(payload);
      })
      .catch((error) => {
        this.localError('[debug:remote] could not forward debug log', error);
      });
  }

  async sendRaw(payload) {
    const cid = this.ensureCid();
    for (const part of chunkMessage(payload)) {
      await new Promise((resolve, reject) => {
        const url = new URL(DEBUG_ENDPOINT);
        url.searchParams.set('uid', this.homey.manifest.id);
        url.searchParams.set('cid', cid);
        url.searchParams.set('message', part);

        const request = https.get(url, { timeout: 5000 }, (response) => {
          response.resume();
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`Debug endpoint returned ${response.statusCode}`));
            return;
          }
          resolve();
        });

        request.on('error', reject);
        request.on('timeout', () => {
          request.destroy(new Error('Debug endpoint timeout'));
        });
      });
    }
  }
}

module.exports = {
  DebugLogger,
  DEBUG_CID_SETTING_KEY,
  DEBUG_ENABLED_SETTING_KEY,
  generateDebugCid,
};
