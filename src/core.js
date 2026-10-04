/**
 * The few @actions/core helpers this Action needs, with no dependency:
 * inputs from INPUT_* variables, outputs to $GITHUB_OUTPUT, the job summary,
 * workflow commands (::add-mask::, ::warning::, ::error::) and redaction.
 *
 * Every line this module writes passes through redact(), so a secret that was
 * registered with setSecret() never reaches the log, even if a server echoes it.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const TRUE = ['true', 'True', 'TRUE'];
const FALSE = ['false', 'False', 'FALSE'];

/** Data inside a workflow command: the escaping @actions/core uses. */
export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function createCore({ env = process.env, write = (s) => process.stdout.write(s) } = {}) {
  const secrets = new Set();

  // A secret can also reach text in its markdown-escaped form (mq\_sk\_...), which
  // GitHub renders back as the secret, so both spellings are removed.
  const spellings = (secret) => {
    const escaped = secret.replace(/([\\`*_[\]|~])/g, '\\$1');
    return escaped === secret ? [secret] : [escaped, secret];
  };
  const redact = (value) => {
    let text = String(value ?? '');
    for (const secret of secrets) for (const spelling of spellings(secret)) text = text.split(spelling).join('***');
    return text;
  };
  // Untrusted text (server messages, page quotes) must never start a workflow command.
  const neutralize = (text) => text.replace(/^(\s*)::/gm, '$1: :');
  const line = (text) => write(`${text}\n`);
  const command = (name, message) => line(`::${name}::${escapeData(neutralize(redact(message)))}`);

  return {
    getInput(name) {
      const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
      return String(env[key] ?? '').trim();
    },

    getBooleanInput(name, fallback) {
      const raw = this.getInput(name);
      if (raw === '') return fallback;
      if (TRUE.includes(raw)) return true;
      if (FALSE.includes(raw)) return false;
      throw new InputError(`${name} must be true or false, got "${raw}".`);
    },

    /** Registers a secret: GitHub masks it in the log, and redact() removes it from everything we write. */
    setSecret(value) {
      const secret = String(value ?? '');
      if (!secret) return;
      secrets.add(secret);
      line(`::add-mask::${escapeData(secret)}`);
    },

    redact,

    info(message) {
      line(neutralize(redact(message)));
    },
    notice(message) {
      command('notice', message);
    },
    warning(message) {
      command('warning', message);
    },
    error(message) {
      command('error', message);
    },

    setOutput(name, value) {
      const text = redact(value ?? '');
      const file = env.GITHUB_OUTPUT;
      if (!file) {
        line(`Output ${name}: ${neutralize(text)}`);
        return;
      }
      const delimiter = `ghadelimiter_${randomUUID()}`;
      appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`, 'utf8');
    },

    appendSummary(markdown) {
      const file = env.GITHUB_STEP_SUMMARY;
      if (!file) return false;
      appendFileSync(file, `${redact(markdown)}\n`, 'utf8');
      return true;
    },
  };
}
