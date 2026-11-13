'use strict';

// The viewer's language, falling back to the language without its region, then to
// whatever the developer wrote. Only descriptions are localised: a command's name
// is what people type.
function localize(command, locale) {
  const wanted = String(locale || '')
    .trim()
    .toLowerCase();
  const table = command.localizations || {};
  const match = table[wanted] || table[wanted.split('-')[0]];
  if (!match) return { description: command.description, options: {} };
  return { description: match.description || command.description, options: match.options || {} };
}

// "de-DE,de;q=0.9,en;q=0.8" -> "de-de". Enough of Accept-Language to pick one.
function localeFromHeader(header) {
  return String(header || '')
    .split(',')[0]
    .split(';')[0]
    .trim()
    .toLowerCase();
}

module.exports = { localize, localeFromHeader };
