// ---------------------------------------------------------------------------
// TEST-ONLY module hook. Registered by scripts/test-inr-auto-verify.mjs and by
// nothing else. The server never loads it, and the production source file
// vcGatewayAdapter.js on disk has no test seam.
//
// Why it exists: the wallet tests need a verifier that is trusted and has a
// MOCK contract. Only vcGatewayAdapter.js can register trusted verifiers (the
// registry is module-private), so this hook appends one function to that
// module's source IN MEMORY, for this test process only. The appended function
// is the only way to create such a verifier, and it exists only in the test run.
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGET = fileURLToPath(new URL('../../server/lib/vcGatewayAdapter.js', import.meta.url));
const TARGET_URL = pathToFileURL(TARGET).href;
const SEAM = `
// ---- injected by scripts/support/trusted-verifier-loader.mjs (TEST ONLY) ----
export function __createTestVerifier({ contract, transport } = {}) {
  const adapter = createVcGatewayAdapter({ contract, transport });
  trustedVerifiers.add(adapter);
  return adapter;
}
`;

export async function load(url, context, nextLoad) {
  if (url === TARGET_URL) {
    const source = await readFile(TARGET, 'utf8');
    return { format: 'module', source: source + SEAM, shortCircuit: true };
  }
  return nextLoad(url, context);
}
