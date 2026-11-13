const MAX_BACKUP = 1048576;

function validateBackup(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_BACKUP) {
    return { error: 'Invalid encrypted key backup.' };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'Invalid encrypted key backup.' };
    }
    if (parsed.cipher !== 'AES-GCM') {
      return { error: 'Invalid encrypted key backup.' };
    }
    if (parsed.v === 1) {
      if (parsed.kdf !== 'PBKDF2-SHA256') {
        return { error: 'Invalid encrypted key backup.' };
      }
      if (!Number.isInteger(parsed.iterations) || parsed.iterations < 100000) {
        return { error: 'Invalid encrypted key backup.' };
      }
    } else if (parsed.v === 2 || parsed.v === 3) {
      if (parsed.kdf !== 'Argon2id') {
        return { error: 'Invalid encrypted key backup.' };
      }
      if (
        !Number.isInteger(parsed.memoryKiB) ||
        parsed.memoryKiB < 19456 ||
        parsed.memoryKiB > 262144 ||
        !Number.isInteger(parsed.iterations) ||
        parsed.iterations < 2 ||
        parsed.iterations > 10 ||
        !Number.isInteger(parsed.parallelism) ||
        parsed.parallelism < 1 ||
        parsed.parallelism > 4
      ) {
        return { error: 'Invalid encrypted key backup.' };
      }
    } else {
      return { error: 'Unsupported encrypted key backup version.' };
    }
    for (const field of ['salt', 'iv', 'ct']) {
      if (typeof parsed[field] !== 'string' || !parsed[field]) {
        return { error: 'Invalid encrypted key backup.' };
      }
    }
    return { backup: value };
  } catch {
    return { error: 'Invalid encrypted key backup.' };
  }
}

module.exports = { MAX_BACKUP, validateBackup };
