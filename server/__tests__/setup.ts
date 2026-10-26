/**
 * Shared server-test isolation: pin HERMES_HOME to a path that does not exist
 * unless a test deliberately creates one.
 *
 * The Hermes provider reports availability from a filesystem probe
 * (hermesHomeExists), and the handshake loop / consent gate / startup install
 * consult it. Dev machines that happen to run Hermes must not change what the
 * Claude-era suites assert (exactly one consent ask, one hooksStatus per
 * connect) — nor may CI pass while a developer's box fails. Absent =
 * unavailable = every pre-Hermes test observes exactly the single-provider
 * wire it was written against. Hermes-specific tests set HERMES_HOME to a
 * fresh temp dir in their own beforeEach; they win because they re-run the
 * probes per dispatch, never through this file's default.
 */

import * as os from 'os';
import * as path from 'path';

process.env['HERMES_HOME'] = path.join(os.tmpdir(), 'pixel-agents-tests-no-hermes-home');
