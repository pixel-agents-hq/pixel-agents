import { DiagnosticSeverity, fromFile, Parser } from '@asyncapi/parser';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const source = resolve('core', 'asyncapi.yaml');
  const { document, diagnostics } = await fromFile(new Parser(), source).parse();

  for (const diagnostic of diagnostics) {
    const location = diagnostic.path?.length
      ? ` at ${diagnostic.path.join('.')}`
      : '';
    console.error(`${diagnostic.code}: ${diagnostic.message}${location}`);
  }

  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );

  if (!document || errors.length > 0) {
    console.error(`AsyncAPI validation failed with ${errors.length} error(s).`);
    process.exitCode = 1;
  } else {
    console.log('AsyncAPI document is valid.');
  }
}

void main();
