import { quoteShell as q } from './transport';

// Reduce metadata *before* it crosses SSH. In particular do not transport env, userConfig,
// hook commands, credentials, descriptions or inline command bodies. No config is evaluated.
const jq = `if type != "object" then {} elif $t == "settings" then
  {enabledPlugins: ((.enabledPlugins // {}) | objects | with_entries(select(.value | type == "boolean")))}
elif $t == "installed" then
  {plugins:(.plugins | objects | with_entries(.value |= ((if type == "array" then . else [.] end) | map(objects | {installPath,scope,projectPath}))))}
else {name, defaultEnabled, skills, commands: (.commands | if type == "object" then with_entries(.value |= (if type == "object" then {content:(.content|type=="string"),source} else null end)) else . end)} end`;
const perl = `my $j=decode_json(join("",<STDIN>)); die unless ref($j) eq "HASH"; my $t=$ARGV[0]; my %out;
if ($t eq "settings") { my $h=$j->{enabledPlugins}; $out{enabledPlugins}={map {$_=>$h->{$_}} grep { JSON::PP::is_bool($h->{$_}) } keys %$h} if ref($h) eq "HASH" }
elsif ($t eq "installed") {my $h=$j->{plugins}; if(ref($h) eq "HASH") { my %p; for my $id(keys %$h){ my $v=$h->{$id}; my @rows; for my $r(ref($v) eq "ARRAY"?@$v:($v)){ next unless ref($r) eq "HASH"; push @rows, {map {$_=>$r->{$_}} qw(scope projectPath installPath)} } $p{$id}=\\@rows } $out{plugins}=\\%p }}
else { %out=map {$_=>$j->{$_}} qw(name defaultEnabled skills commands); my $h=$j->{commands}; if(ref($h) eq "HASH"){ $out{commands}={}; for my $k(keys %$h){ my $v=$h->{$k}; next unless ref($v) eq "HASH"; $out{commands}{$k}={content=> defined($v->{content}) && !ref($v->{content})?JSON::PP::true:JSON::PP::false,source=>$v->{source}} } } }
print encode_json(\\%out);`;

export const metadataReader = `unset PERL5OPT PERL5LIB PERLLIB; json_tool=''
if command -v jq >/dev/null 2>&1; then json_tool=jq
elif (cd / && perl -MJSON::PP -e 1) 2>/dev/null; then json_tool=perl; fi
record_json() {
  [ -f "$3" ] && [ ! -L "$3" ] && [ -r "$3" ] || return 0
  # 'unknown' distinguishes unreadable metadata from a missing file. Do not guess disabled plugins.
  payload=unknown
  if [ -n "$json_tool" ] && [ "$(wc -c < "$3")" -le 262144 ]; then
    if [ "$json_tool" = jq ]; then result=$(head -c 262144 < "$3" | jq -c --arg t "$1" ${q(jq)} 2>/dev/null)
    else result=$(head -c 262144 < "$3" | (cd / && perl -MJSON::PP -e ${q(perl)} "$1") 2>/dev/null); fi
    if [ -n "$result" ]; then payload=$(printf '%s' "$result" | base64); fi
  fi
  printf '%s\\0%s\\0%s\\0' "$1" "$2" "$payload"
}`;
