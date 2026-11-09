/**
 * P3 權限角色的純函式（補充決定 1 到 3）：角色是集合、驗證、工具對應、有效角色。
 */

import { describe, expect, it } from 'vitest';

import {
  effectivePermissionRoles,
  missingOperation,
  parsePermissionRoles,
  toolOperations,
} from '../src/writeGuard/permissionRoles.js';

describe('parsePermissionRoles', () => {
  it('accepts null and distinct R/E/D in any order, returning canonical R, E, D order', () => {
    expect(parsePermissionRoles(null)).toBeNull();
    expect(parsePermissionRoles(['D', 'R'])).toEqual(['R', 'D']);
    expect(parsePermissionRoles(['E', 'D', 'R'])).toEqual(['R', 'E', 'D']);
  });

  it('accepts the empty array: every switch off (not the same as null)', () => {
    expect(parsePermissionRoles([])).toEqual([]);
  });

  it.each([[['R', 'R']], [['A']], [['r']], ['R'], [undefined], [1], [{}], [[null]], [['R', 1]]])(
    'refuses %j',
    (value) => {
      expect(parsePermissionRoles(value)).toBeUndefined();
    },
  );
});

describe('roles are a set, not a hierarchy', () => {
  it('each operation needs its own switch', () => {
    expect(missingOperation(['R'], ['read'])).toBeNull();
    expect(missingOperation(['R'], ['edit'])).toBe('edit');
    expect(missingOperation(['D'], ['delete'])).toBeNull();
    expect(missingOperation(['D'], ['read'])).toBe('read');
    expect(missingOperation(['R', 'E'], ['read', 'edit', 'delete'])).toBe('delete');
    expect(missingOperation([], ['read'])).toBe('read');
    expect(missingOperation([], [])).toBeNull();
  });

  it('null (no roles) allows everything', () => {
    expect(missingOperation(null, ['read', 'edit', 'delete'])).toBeNull();
  });
});

describe('tool mapping', () => {
  it('Read/Glob/Grep need read, Write/Edit/NotebookEdit need edit, others nothing', () => {
    for (const tool of ['Read', 'Glob', 'Grep']) expect(toolOperations(tool)).toEqual(['read']);
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(toolOperations(tool)).toEqual(['edit']);
    }
    for (const tool of ['Agent', 'Task', 'TodoWrite', 'WebFetch', 'mcp__x__write']) {
      expect(toolOperations(tool)).toEqual([]);
    }
  });
});

describe('effective roles (launch snapshot)', () => {
  it('the launch override (array or null) wins, else the Workspace default, else null', () => {
    expect(effectivePermissionRoles(['E'], ['R'])).toEqual(['E']);
    expect(effectivePermissionRoles(null, ['R'])).toBeNull();
    expect(effectivePermissionRoles(undefined, ['R'])).toEqual(['R']);
    expect(effectivePermissionRoles(undefined, [])).toEqual([]);
    expect(effectivePermissionRoles(undefined, undefined)).toBeNull();
  });
});
