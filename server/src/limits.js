'use strict';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// Cordia has no paid tier, so there is exactly one set of limits and every
// account gets all of it. The numbers live in one module because the upload
// route, the storage manager and the client all quote the same ceiling.
const ACCOUNT_LIMITS = {
  maxUploadBytes: 50 * MB,
  storageQuotaBytes: 5 * GB
};

module.exports = { ACCOUNT_LIMITS };
