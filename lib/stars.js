'use strict';
/* Starred files.
 *
 * Kept on the server rather than in the browser: a star is a statement about
 * the asset, not about the machine you happened to open it on, so it should
 * still be there from the laptop and from the phone on the LAN.
 *
 * Shape is { projectId: { relPath: starredAt } } so a lookup is two hops and
 * removing a whole project is one delete.
 */
const { STARS_FILE, readJSON, writeJSON } = require('./config');

function load() {
  const raw = readJSON(STARS_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function list() {
  return load();
}

function isStarred(projectId, relPath) {
  const all = load();
  return !!(all[projectId] && all[projectId][relPath]);
}

/** Flips the star and returns the state it landed in. */
function toggle(projectId, relPath) {
  const all = load();
  const forProject = all[projectId] || (all[projectId] = {});
  let starred;
  if (forProject[relPath]) {
    delete forProject[relPath];
    starred = false;
  } else {
    forProject[relPath] = Date.now();
    starred = true;
  }
  // Do not leave an empty bag behind for a project with nothing starred.
  if (!Object.keys(forProject).length) delete all[projectId];
  writeJSON(STARS_FILE, all);
  return starred;
}

/** Called when a project is unregistered, so its stars do not outlive it. */
function removeProject(projectId) {
  const all = load();
  if (!all[projectId]) return false;
  delete all[projectId];
  writeJSON(STARS_FILE, all);
  return true;
}

module.exports = { list, isStarred, toggle, removeProject };
