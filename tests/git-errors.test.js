'use strict';
/* git's stderr is the only thing the user ever sees when a clone or pull
 * fails, so the mapping from git's words to ours is worth pinning down:
 * every case here is real output copied from a failing git run.
 */
const { cleanGitError } = require('../lib/git');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  cond ? (pass++, console.log('  PASS  ' + label))
    : (fail++, console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')));
};
const says = (label, raw, needle) => {
  const got = cleanGitError(raw);
  ok(label, got.includes(needle), got);
};

console.log('\ngit error messages\n');

says('no saved credential',
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  'koi saved credential nahi mila');

says('expired or wrong token',
  'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
  "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
  'expire ho gaya hai ya galat');

says('private repo without access',
  "remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found",
  'Repo nahi mila');

says('org with SAML SSO',
  "remote: The 'acme' organization has enabled or enforced SAML SSO. To access this repository, " +
  'you must re-authorize the OAuth Application.',
  'SAML SSO');

says('403 is not reported as a network problem',
  "fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
  'permission nahi hai');

says('401 is not reported as a network problem',
  "fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 401",
  'reject kar diya');

says('ssh key without an agent',
  'git@github.com: Permission denied (publickey).\n' +
  'fatal: Could not read from remote repository.',
  'https://github.com/');

says('genuinely offline',
  "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
  'Internet check');

says('missing branch',
  "fatal: Remote branch develop not found in upstream origin",
  'branch remote par nahi mili');

says('interrupted transfer',
  'error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF',
  'beech me toot gaya');

/* The clone path puts the token straight into the URL, and git prints that URL
 * back in its error. Nothing here may ever reach the browser. */
const leak = 'Command failed: git ls-remote --heads -- https://ghp_AbCdEfGhIjKlMnOpQrSt1234567890@github.com/acme/app.git\n' +
  "fatal: unable to access 'https://ghp_AbCdEfGhIjKlMnOpQrSt1234567890@github.com/acme/app.git/': The requested URL returned error: 500";
const leaked = cleanGitError(leak);
ok('token never survives into the message', !/ghp_AbCdEfGhIjKlMnOpQrSt/.test(leaked), leaked);

const basic = 'Command failed: git ls-remote --heads -- https://user:s3cret@example.com/x.git\n' +
  'fatal: something unmapped went wrong';
const basicOut = cleanGitError(basic);
ok('basic-auth password never survives either', !/s3cret/.test(basicOut), basicOut);
ok('unmapped errors fall back to git\'s own line',
  basicOut === 'something unmapped went wrong', basicOut);
ok('the execFile header is never shown on its own',
  !/^Command failed/.test(cleanGitError('Command failed: git fetch')), cleanGitError('Command failed: git fetch'));
ok('empty input still says something', cleanGitError('') === 'git command fail hui', cleanGitError(''));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
