/**
 * Generate core/src/messages.ts from core/asyncapi.yaml using @asyncapi/modelina.
 *
 * Pipeline:
 *  1. Parse yaml via Modelina's TypeScriptGenerator (which uses asyncapi parser internally).
 *  2. Apply two custom constraints:
 *     - propertyKey: bypass Modelina's hardcoded reserved-keyword renaming (Modelina
 *       renames `type` -> `reservedType` and `status` -> `reservedStatus`, which would
 *       break the discriminated-union narrowing pattern used everywhere in the webview).
 *     - constant: always render `const: 'foo'` as the inline literal `'foo'` instead
 *       of an enum-style reference (`AnonymousSchema_N.FOO`) -- the latter is invalid
 *       TS when `enumType: 'union'` produces type aliases.
 *  3. Filter out unreferenced AnonymousSchema_* enum aliases that Modelina splits but
 *     our `constant` override leaves dead.
 *  4. Concatenate all model outputs into a single core/src/messages.ts file with a
 *     header banner (DO NOT EDIT MANUALLY).
 *  5. Run prettier --write + eslint --fix on the file so it matches repo style and
 *     is reviewable as code (committed file, not gitignored).
 */

import { TypeScriptGenerator } from '@asyncapi/modelina';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const YAML_PATH = path.join(REPO_ROOT, 'core', 'asyncapi.yaml');
const OUTPUT_PATH = path.join(REPO_ROOT, 'core', 'src', 'messages.ts');

const HEADER = `/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run \`npm run asyncapi:generate\` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml. 
 * Editors and clients in any language can consume the spec directly.
 */

`;

async function main(): Promise<void> {
  if (!fs.existsSync(YAML_PATH)) {
    console.error(`[generate-messages] ${YAML_PATH} not found.`);
    process.exit(1);
  }

  const generator = new TypeScriptGenerator({
    modelType: 'interface',
    enumType: 'union',
    mapType: 'record',
    moduleSystem: 'ESM',
    useJavascriptReservedKeywords: false,
    constraints: {
      // Bypass reserved-keyword renaming so `type` and `status` stay verbatim.
      // Without this, discriminated-union narrowing (`msg.type === 'foo'`) breaks.
      propertyKey: ({ objectPropertyModel }) => objectPropertyModel.propertyName,
      // Always render const: '<value>' as the inline literal '<value>'. Default
      // Modelina behavior produces enum-style references that aren't valid TS
      // when enumType: 'union' generates plain type aliases.
      constant: ({ constrainedMetaModel }) => {
        const constOptions = constrainedMetaModel.options?.const;
        return constOptions ? `'${String(constOptions.originalInput)}'` : undefined;
      },
    },
  });

  const yaml = fs.readFileSync(YAML_PATH, 'utf-8');
  const models = await generator.generate(yaml);

  // Drop unreferenced single-value anonymous enum aliases. Modelina splits each
  // `const` schema into its own ConstrainedEnumModel; our `constant` override
  // inlines the literal so the alias is dead code. Multi-value enums (real
  // string-literal unions) stay -- they ARE referenced by their containing
  // schema. The yaml should still extract them to named schemas for readability;
  // this filter only drops the const-derived garbage.
  const filtered = models.filter((m) => {
    const isAnon = m.modelName.startsWith('AnonymousSchema_');
    const isEnum = m.model.constructor.name === 'ConstrainedEnumModel';
    if (!isAnon || !isEnum) return true;
    // Keep multi-value enums (still referenced); drop single-value (inlined).
    const enumModel = m.model as { values?: unknown[] };
    return (enumModel.values?.length ?? 0) > 1;
  });

  // Inline objects that Modelina extracts to AnonymousSchema_N interfaces are
  // still referenced. Renaming them in-place to a stable name is out of scope --
  // the yaml is authored to extract reusable shapes (AgentSeatMeta, etc.) so
  // the AnonymousSchema_N shouldn't appear in practice. Warn loudly if any do.
  const leakingAnon = filtered.filter((m) => m.modelName.startsWith('AnonymousSchema_'));
  if (leakingAnon.length > 0) {
    console.warn(
      `[generate-messages] WARNING: ${leakingAnon.length} anonymous schema(s) leaked into output: ` +
        leakingAnon.map((m) => m.modelName).join(', ') +
        '. Consider extracting them to named schemas in core/asyncapi.yaml.',
    );
  }

  // Concatenate. Each model.result is a complete TS declaration (interface/type).
  // We need to re-export the unions and the FurnitureAssetMessage interface as
  // top-level named exports. Modelina prepends `interface Foo` (no `export`) by
  // default when emitted via .generate(); we add `export` to every declaration.
  const body = filtered.map((m) => exportify(m.result)).join('\n\n');

  fs.writeFileSync(OUTPUT_PATH, HEADER + body + '\n', 'utf-8');
  console.log(`[generate-messages] wrote ${OUTPUT_PATH} (${filtered.length} models)`);

  // Format + lint --fix the generated file so the committed file passes CI.
  try {
    execSync(`npx prettier --write ${quote(OUTPUT_PATH)}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error('[generate-messages] prettier failed:', err);
    process.exit(1);
  }
  try {
    execSync(`npx eslint --fix ${quote(path.relative(REPO_ROOT, OUTPUT_PATH))}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch (err) {
    // ESLint may exit non-zero if there are unfixable warnings; that's okay --
    // we want to see them but not fail generation.
    console.warn('[generate-messages] eslint --fix reported issues (non-fatal).');
  }
}

/**
 * Modelina emits declarations like `interface Foo { ... }` or
 * `type Foo = A | B;` without `export`. Add it.
 */
function exportify(decl: string): string {
  const trimmed = decl.trimStart();
  if (trimmed.startsWith('export ')) return decl;
  return `export ${trimmed}`;
}

function quote(s: string): string {
  // cmd.exe does not strip single quotes, so POSIX-style quoting breaks the
  // path on Windows. Use double quotes there, single quotes on POSIX shells.
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

main().catch((err) => {
  console.error('[generate-messages] failed:', err);
  process.exit(1);
});
