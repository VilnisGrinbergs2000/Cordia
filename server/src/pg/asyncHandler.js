'use strict';

// Express 4 does not catch rejected promises from route handlers: an async
// handler that throws leaves the request hanging until the client times out.
// asyncHandler keeps the handler async but forwards the rejection to next(err)
// so the app-level error middleware still answers with a 500.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
