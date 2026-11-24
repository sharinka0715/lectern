import type { EndpointBilling, Workspace } from '../shared/types';
import { type Transport } from './transport';
import { readSettingsFile, settingsPathExpression } from './conversation-settings';

// A routing hint, not proof of who ultimately receives payment. Never emit the URL:
// even a URL can contain identifying information. Never consult keys/tokens.
export const customRouteCase = 'case "${ANTHROPIC_BASE_URL:-}" in (""|https://api.anthropic.com|https://api.anthropic.com/) custom=0;; (*) custom=1;; esac';

export function endpointBillingProbe(file: string | null = null, customRoute?: boolean): string {
  return `cd "$HOME" || exit 1
export LC_ALL=C
${customRoute === undefined ? customRouteCase : `custom=${Number(customRoute)}`}
# Check this installation actually supports the noninteractive JSON command.
claude auth status --help 2>/dev/null | grep -Eq -- '--json([[:space:]]|$)' || exit 0
# Claude 2.1.326 pretty-prints top-level JSON fields with exactly two spaces.
# Match only complete, allowlisted lines. Unknown output formats fail closed.
# Do not transmit raw identity fields, stderr, or invoke any project helper.
claude ${file ? '--settings ' + settingsPathExpression(file) + ' ' : ''}--setting-sources user auth status --json 2>/dev/null | awk -v custom="$custom" '
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
  observe(workspace: Workspace, resolvedConfig: string, now = Date.now(), file: string | null = null): EndpointBilling | undefined {
    const key = JSON.stringify([workspace.kind, workspace.host, workspace.port, resolvedConfig, file]);
    const last = this.entries.get(key);
    if (last && now < last.expires) return last.value;
    const entry: { value?: EndpointBilling; expires: number } = { expires: Infinity };
    this.entries.set(key, entry);
    const check = (customRoute?: boolean) => this.transport.run(workspace, endpointBillingProbe(file, customRoute), {
      tag: 'claude.auth.category', timeoutMs: 8000, maxBytes: 128,
    });
    const probe = file ? readSettingsFile(this.transport, workspace, file).then(settings => {
      const base = (settings.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL;
      return check(typeof base === 'string' ? base !== '' && base !== 'https://api.anthropic.com' && base !== 'https://api.anthropic.com/' : undefined);
    }) : check();
    void probe.then(({ stdout }) => {
      const value = stdout.toString('ascii').trim() as EndpointBilling;
      entry.value = categories.has(value) ? value : 'unknown';
    }, () => { entry.value = 'unknown'; }).finally(() => { entry.expires = Date.now() + 5 * 60_000; });
    return undefined;
  }
}
