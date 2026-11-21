import type { EndpointBilling, Workspace } from '../shared/types';
import { quoteShell as q, type Transport } from './transport';

// A routing hint, not proof of who ultimately receives payment. Never emit the URL:
// even a URL can contain identifying information. Never consult keys/tokens.
export const customRouteCase = 'case "${ANTHROPIC_BASE_URL:-}" in ""|https://api.anthropic.com|https://api.anthropic.com/) custom=0;; *) custom=1;; esac';

export function endpointBillingProbe(claudeDir?: string): string {
  return `cd "$HOME" || exit 1
${claudeDir ? `export CLAUDE_CONFIG_DIR=${q(claudeDir)}\n` : ''}export LC_ALL=C
${customRouteCase}
# Check this installation actually supports the noninteractive JSON command.
claude auth status --help 2>/dev/null | grep -Eq -- '--json([[:space:]]|$)' || exit 0
# Claude 2.1.326 pretty-prints top-level JSON fields with exactly two spaces.
# Match only complete, allowlisted lines. Unknown output formats fail closed.
# Do not transmit raw identity fields, stderr, or invoke any project helper.
claude --setting-sources user auth status --json 2>/dev/null | awk -v custom="$custom" '
/^[{]$/ { opened++ }
/^[}]$/ { closed++ }
/^  "loggedIn": true,?$/ { login=1 }
/^  "loggedIn": false,?$/ { login=-1 }
/^  "apiProvider": "firstParty",?$/ { first=1 }
/^  "apiProvider": "(bedrock|vertex|foundry|gateway|mantle|anthropicAws|anthropicGoogleCloud)",?$/ { third=1 }
/^  "authMethod": "third_party",?$/ { third=1 }
/^  "authMethod": "(api_key|api_key_helper)",?$/ { api=1 }
/^  "authMethod": "claude[.]ai",?$/ { account=1 }
/^  "subscriptionType": "(pro|max|ultra|team|enterprise)",?$/ { paid=1 }
END { if (opened!=1 || closed!=1) print "unknown"; else if (login==-1) print "signed-out"; else if (login!=1) print "unknown";
  else if (third || custom) print "third-party"; else if (first && api) print "api";
  else if (first && account && paid) print "subscription"; else print "unknown" }'`;
}

const categories = new Set<EndpointBilling>(['subscription', 'api', 'third-party', 'signed-out', 'unknown']);
/** In-memory, demand-driven. Only called after locate succeeded on a project, never for saved hosts. */
export class EndpointBillingCache {
  private entries = new Map<string, { value?: EndpointBilling; expires: number }>();
  constructor(private readonly transport: Pick<Transport, 'run'>) {}
  observe(workspace: Workspace, resolvedConfig: string, now = Date.now()): EndpointBilling | undefined {
    const key = JSON.stringify([workspace.kind, workspace.host, workspace.port, resolvedConfig, !!workspace.claudeDir]);
    const last = this.entries.get(key);
    if (last && now < last.expires) return last.value;
    const entry: { value?: EndpointBilling; expires: number } = { expires: Infinity };
    this.entries.set(key, entry);
    void this.transport.run(workspace, endpointBillingProbe(workspace.claudeDir ? resolvedConfig : undefined), {
      tag: 'claude.auth.category', timeoutMs: 8000, maxBytes: 128,
    }).then(({ stdout }) => {
      const value = stdout.toString('ascii').trim() as EndpointBilling;
      entry.value = categories.has(value) ? value : 'unknown';
    }, () => { entry.value = 'unknown'; }).finally(() => { entry.expires = Date.now() + 5 * 60_000; });
    return undefined;
  }
}
