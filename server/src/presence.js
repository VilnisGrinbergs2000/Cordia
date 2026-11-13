const counts = new Map();
// Users who asked to appear offline. Presence stays accurate for the server
// (calls, push suppression) while every payload that reaches another client
// reports them as offline.
const hidden = new Set();

function addPresence(userId) {
  const id = Number(userId);
  counts.set(id, (counts.get(id) || 0) + 1);
}

function removePresence(userId) {
  const id = Number(userId);
  const next = (counts.get(id) || 0) - 1;
  if (next <= 0) counts.delete(id);
  else counts.set(id, next);
}

function isOnline(userId) {
  return counts.has(Number(userId));
}

function setPresenceHidden(userId, value) {
  const id = Number(userId);
  if (value) hidden.add(id);
  else hidden.delete(id);
}

function isPresenceHidden(userId) {
  return hidden.has(Number(userId));
}

// What other clients are allowed to know: connected and not invisible.
function isVisibleOnline(userId) {
  return isOnline(userId) && !hidden.has(Number(userId));
}

function onlineIds() {
  return [...counts.keys()].filter((id) => !hidden.has(id));
}

// Admins get the real number, invisibility included.
function onlineCount() {
  return counts.size;
}

module.exports = {
  addPresence,
  removePresence,
  isOnline,
  isVisibleOnline,
  setPresenceHidden,
  isPresenceHidden,
  onlineIds,
  onlineCount
};
