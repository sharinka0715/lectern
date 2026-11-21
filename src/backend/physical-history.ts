import { createHash } from 'node:crypto';
import { joinList, t } from '../shared/i18n';
import type { Workspace } from '../shared/types';
import { diagnostic, errorDetails } from '../diagnostics';
import type { IndexedFile } from './history-index';
import { SESSION_UUID } from './native-presence';
import { quoteShell as q, type Transport } from './transport';

type File = IndexedFile;
const keyOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (f: File) => [f.path, f.stamp];
export const physicalStamp = (file: File) => file.stamp.split('|').slice(2).join(' ');
export interface HistoryPart { file: File; end: number }
export interface PhysicalSession { id: string; file: File; previous: HistoryPart[] }

// Only a hint from the already fetched index windows. A different filename is
// never collapsed from this hint alone (forks also copy native message UUIDs).
export function nativeSessionHint(head: string, tail: string, filenameId: string): string | undefined {
  let id: string | undefined;
  for (const text of [head, tail]) for (const line of text.split('\n')) {
    if (!line.includes('"sessionId"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.isSidechain) continue;
    // Older forks carry a copied prefix under the OLD session ID followed by
    // native title/owner/continued-in records under their own filename UUID.
    if (r.sessionId === filenameId) return filenameId;
    if (!['user', 'assistant'].includes(r.type)) continue;
    if (r.forkedFrom || typeof r.sessionId !== 'string' || !SESSION_UUID.test(r.sessionId) || id && id !== r.sessionId) return;
    id = r.sessionId;
  }
  return id;
}

// Check the opened regular files against the discovery stamps before AND
// after inspection. The verifier emits only an offset/boolean, not chat text.
const inspectPair = async (t: Transport, w: Workspace, a: File, b: File, body: string, timeoutMs = 60000) => {
  const script = `set -eu
safe() { d=\${1%/*}; [ ! -L "$d" ] && [ ! -L "\${d%/*}" ] && [ ! -L "$1" ] && [ -f "$1" ]; }
safe ${q(a.path)} && safe ${q(b.path)} || { printf stale; exit 0; }
exec 3< ${q(a.path)} 4< ${q(b.path)}
case "$(uname -s)" in Darwin|*BSD) stamp() { stat -Lf '%i|%z|%.9Fm|%.9Fc' "$1"; };; *) stamp() { stat -Lc '%i|%s|%y|%z' "$1"; };; esac
verify() { [ "$(stamp /dev/fd/3)" = ${q(a.stamp)} ] && [ "$(stamp /dev/fd/4)" = ${q(b.stamp)} ]; }
verify || { printf stale; exit 0; }
out=$( ${body} )
if verify; then printf '%s' "$out"; else printf stale; fi`;
  try {
    const result = (await t.run(w, script, { tag: 'history.physical_proof', timeoutMs, maxBytes: 64 })).stdout.toString();
    return result === 'stale' ? undefined : result;
  } catch (error) {
    // This optional proof is not required to list the native sessions. Do not
    // persist an inconclusive transport result as a negative content proof.
    diagnostic.event('history.physical_proof.unavailable', {error:errorDetails(error)}, 'warn');
  }
};

const ownerCheck = String.raw`use strict; use JSON::PP; use Encode qw(decode_utf8);
my ($id, @cwd) = map {decode_utf8($_)} @ARGV; my $found = 0;
while (<STDIN>) {
 my $r = eval { decode_json($_) }; exit 0 unless ref($r) eq 'HASH';
 exit 0 if exists($r->{forkedFrom}) || exists($r->{sessionId}) && ($r->{sessionId} // '') ne $id;
 if (($r->{type} // '') =~ /^(user|assistant)$/ && !$r->{isSidechain}) {
  exit 0 unless ($r->{sessionId} // '') eq $id && grep { $_ eq ($r->{cwd} // '') } @cwd; $found++;
 }
}
print 'yes' if $found;`;

async function prefix(t: Transport, w: Workspace, short: File, long: File, owner: string, aliases: string[], crossName: boolean) {
  // All bytes, not file lengths, timestamps, titles or head/tail samples.
  // -ef compares device AND inode; digest tools are available on GNU and BSD.
  // Run the owner check after hashing using a newly opened/verified descriptor
  // so reading the prefix has not advanced its file position.
  const checkOwner = crossName ? `exec 5< ${q(long.path)}; [ /dev/fd/4 -ef /dev/fd/5 ] || exit 0
 command -v perl >/dev/null && [ "$(perl -MJSON::PP -e ${q(ownerCheck)} ${[owner, ...aliases].map(q).join(' ')} <&5)" = yes ] || exit 0` : '';
  const body = `if [ ! /dev/fd/3 -ef /dev/fd/4 ]; then
 if command -v sha256sum >/dev/null; then digest() { sha256sum; }; elif command -v shasum >/dev/null; then digest() { shasum -a 256; }; else exit 0; fi
 a=$(digest <&3); b=$(head -c ${short.size} <&4 | digest); [ "$a" = "$b" ] || exit 0
fi
${checkOwner}
printf yes`;
  const result = await inspectPair(t,w,short,long,body);
  return result === undefined ? undefined : result === 'yes';
}

// A resumed native session starts with a COPY of its predecessor's current
// branch under the new session ID: from the root message, or from the latest
// compact boundary. Newer CLIs also leave a continued-in marker in the source;
// older CLIs and desktop clients do not. The proof below works for both:
//  1. the successor's first main-chain record H (root user message or compact
//     boundary, parentUuid null, own session ID) exists in the predecessor with
//     the same identity (same logical parent for a boundary);
//  2. the successor's leading records (H .. L) all exist in the predecessor; the
//     first record that does not is the successor's own first message;
//  3. a marker, if present as the predecessor's last link, names this successor.
//     Without a marker, nothing on the predecessor's main chain after L may be
//     newer than the successor's own first message, and no completed reply may
//     follow L there: a resume may drop the source's unfinished last turn, while
//     a branch or a source that kept going leaves finished replies behind, and
//     merging would hide them.
// The predecessor's UUID lookup uses a byte scan: a record's own UUID is the
// first "uuid" occurrence of that value in the file, and a predecessor cannot
// contain the successor's later UUIDs, so a superset never extends the copy.
// Output: the predecessor's cut (bytes before H for a boundary, 0 for a root
// copy, which already repeats everything) and the copied record count.
const bridge = String.raw`use strict; use JSON::PP; use Encode qw(decode_utf8);
my $j = JSON::PP->new->utf8;
my ($old,$new,@cwds) = map {decode_utf8($_)} @ARGV;
open(my $from, '<&=3') or die; open(my $to, '<&=4') or die;
my $uuid = qr/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
my %kinds = map {$_ => 1} qw(user assistant system attachment progress);
sub record { my $r = eval { $j->decode($_[0]) }; return ref($r) eq 'HASH' && !$r->{isSidechain} && $kinds{$r->{type} // ''} && ($r->{uuid} // '') =~ $uuid ? $r : undef }
sub here { my $c = $_[0]->{cwd} // ''; return grep {$_ eq $c} @cwds }
sub boundary { my $r = shift; return ($r->{type} // '') eq 'system' && ($r->{subtype} // '') eq 'compact_boundary' }
my ($head,$parent,$isb);
while (defined(my $line=<$to>)) {
 next if index($line,'"parentUuid"') < 0; my $r = record($line) or next;
 exit if defined($r->{parentUuid}) || exists($r->{forkedFrom}) || ($r->{sessionId} // '') ne $new || !here($r);
 $isb = boundary($r);
 exit unless $isb ? ($r->{logicalParentUuid} // '') =~ $uuid : $r->{type} eq 'user';
 ($head,$parent) = ($r->{uuid}, $r->{logicalParentUuid}); last;
}
exit unless defined $head;
my %at; my $link; my $offset = 0;
while (defined(my $line=<$from>)) {
 my $start = $offset; $offset += length($line);
 while ($line =~ /"uuid":"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/gi) { $at{lc $1} //= $start }
 next unless index($line,'"continued-in"')>=0 || index($line,'"forkedFrom"')>=0 || defined($link) && $line =~ /"type"\s*:\s*"(?:user|assistant)"/;
 my $r = eval { $j->decode($line) }; next unless ref($r) eq 'HASH' && !$r->{isSidechain} && ($r->{sessionId} // '') eq $old;
 exit if exists $r->{forkedFrom};
 if (($r->{type} // '') eq 'continued-in') { my $target = $r->{continuedInSessionId} // ''; exit if defined($link) && $link ne $target; $link = $target; }
 elsif (($r->{type} // '') =~ /^(user|assistant)$/) { $link = undef; }
}
exit unless defined $at{lc $head};
exit if defined($link) && $link ne $new;
my ($last,$depth,$own) = ($head,1,undef);
while (defined(my $line=<$to>)) {
 next if index($line,'"parentUuid"') < 0; my $r = record($line) or next;
 exit if exists($r->{forkedFrom}) || ($r->{sessionId} // '') ne $new;
 if (defined $at{lc $r->{uuid}}) { $last = $r->{uuid}; $depth++; next; }
 $own = $r->{timestamp} // ''; last;
}
exit unless defined($link) || defined($own) && $own ne '';
seek($from,$at{lc $head},0) or exit; my $anchor = record(scalar <$from>);
# The source may have moved into a subdirectory; a resume records the launch cwd.
exit unless $anchor && lc($anchor->{uuid}) eq lc($head) && !defined($anchor->{parentUuid});
exit if $isb && !(boundary($anchor) && ($anchor->{logicalParentUuid} // '') eq $parent && ($anchor->{sessionId} // '') eq $old);
exit if !$isb && boundary($anchor);
if (!defined $link) {
 seek($from,$at{lc $last},0) or exit; my $skip = <$from>;
 while (defined(my $line=<$from>)) {
  next unless $line =~ /"type"\s*:\s*"(?:user|assistant)"/; my $r = record($line) or next;
  next unless ($r->{sessionId} // '') eq $old;
  my $time = $r->{timestamp} // '';
  # An unfinished last turn may be dropped by a resume; a completed reply may not.
  # Report the depth anyway: a deeper but rejected source rules out shallower ones.
  if ($time eq '' || $time gt $own) { print "x $depth"; exit; }
  if ($r->{type} eq 'assistant' && ref($r->{message}) eq 'HASH' && ($r->{message}{stop_reason} // '') eq 'end_turn') { print "y $depth"; exit; }
 }
}
print(($isb ? $at{lc $head} : 0)." $depth");`;

function groups(files: File[]) {
  const names = new Set(files.map(f => f.id));
  const count = new Map<string, number>();
  for (const f of files) count.set(f.id, (count.get(f.id) ?? 0) + 1);
  const by = new Map<string, File[]>();
  for (const f of files) {
    const id = f.nativeHint && !f.metadata.forkParentId && names.has(f.nativeHint) && count.get(f.id) === 1 ? f.nativeHint : f.id;
    const list = by.get(id) ?? []; list.push(f); by.set(id, list);
  }
  return by;
}
function longest(files: File[], id: string) {
  return [...files].sort((a,b) => b.size - a.size || Number(b.id === id) - Number(a.id === id))[0];
}
function candidates(files: Iterable<File>, aliases: string[]) { return [...files].filter(f => f.metadata.cwd && aliases.includes(f.metadata.cwd)); }

function copyGroup(id: string, list: File[]) {
  const owners = list.filter(f => f.id === id), extra = list.filter(f => f.id !== id);
  const key = keyOf(['physical-prefix-v2', id, owners.map(identity)]);
  const max = longest(owners, id);
  return {owners, extra, key, max, foreignKey: (f: File) => keyOf([key, identity(f)])};
}

/** Key durable decisions by every participating physical revision. Failed
 * content proofs are cached; failed transports/stale reads do not grant proof. */
export async function provePhysicalHistory(t: Transport, w: Workspace, rows: Map<string,File>, aliases: string[]) {
  const files = candidates(rows.values(), aliases), by = groups(files);
  let changed = false;
  const replace = (f: File, fields: Partial<File>) => { rows.set(f.path, {...rows.get(f.path)!, ...fields}); changed = true; };
  for (const [id, list] of by) {
    if (list.length < 2 || list.length > 32) continue;
    const { owners, extra, key, max, foreignKey } = copyGroup(id, list);
    if (!max) continue;
    let ok: boolean | undefined = owners.length === 1 || owners.every(f => f.groupProof?.key === key && f.groupProof.order === 0);
    if (owners.length > 1 && !owners.every(f => f.groupProof?.key === key)) {
      ok = true;
      for (const f of owners) if (ok && f !== max) ok = await prefix(t,w,f,max,id,aliases,false);
      if (ok === undefined) continue;
      for (const f of owners) replace(f,{groupProof:{key,order:ok ? 0 : -1}});
    }
    if (!ok) continue;
    for (const f of extra) {
      const key = foreignKey(f);
      if (f.groupProof?.key === key) continue;
      const [short,long] = f.size <= max.size ? [f,max] : [max,f];
      const verified = !f.metadata.forkParentId && !max.metadata.forkParentId && max.nativeHint === id &&
        await prefix(t,w,short,long,id,aliases,true);
      if (verified !== undefined) replace(f,{groupProof:{key,order:verified ? 0 : -1}});
    }
  }
  const selected = selectCopies(candidates(rows.values(),aliases), new Set());
  const pending = continuationCandidates(selected).filter(([from,to]) => !rows.get(to.file.path)!.linkProofs?.some(p => p.key === linkKey(from.file,to.file)));
  // Each proof streams one transcript on the target; a few run side by side over
  // the shared connection so a first scan of a large project stays bounded.
  const prove = async ([from,to]: [PhysicalSession,PhysicalSession]) => {
    const key = linkKey(from.file,to.file);
    const output = await inspectPair(t,w,from.file,to.file,`if command -v perl >/dev/null && perl -MJSON::PP -e 1 2>/dev/null; then perl -e ${q(bridge)} ${[from.id,to.id,...aliases].map(q).join(' ')}; fi`, 180000);
    if (output === undefined) return;
    const [head, tail] = output.split(' '), cut = Number(head), count = Number(tail);
    const depth = Number.isSafeInteger(count) && count > 0 ? count : 0;
    // -1: no proof, or the source kept going after the copy began; -2: the
    // source had stopped but the copy left finished replies behind (a branch).
    const proof = head !== 'x' && head !== 'y' && Number.isSafeInteger(cut) && cut >= 0 && cut <= from.file.size && depth
      ? {key, before: cut, depth} : {key, before: head === 'y' ? -2 : -1, depth: head === 'x' || head === 'y' ? depth : 0};
    // Keep the newest few: the predecessor set of one file is small and stable.
    replace(to.file,{linkProofs:[proof,...(rows.get(to.file.path)!.linkProofs ?? []).filter(p => p.key !== key)].slice(0,16)});
  };
  await Promise.all(Array.from({length: Math.min(4, pending.length)}, async () => {
    for (let next = pending.shift(); next; next = pending.shift()) await prove(next);
  }));
  return changed;
}

const linkKey = (from: File, to: File) => keyOf(['continuation-v2',identity(from),identity(to)]);

/** Pairs worth a content proof. A marker names its successor; without one, a
 * copy starts at its predecessor's root message or latest compact boundary,
 * whose UUIDs the index keeps. Same-ID copies are the group logic's job. */
function continuationCandidates({sessions,conflicts}: ReturnType<typeof selectCopies>) {
  const usable = [...sessions.values()].filter(s => s.file.id === s.id && !conflicts.has(s.id) && !s.file.metadata.forkParentId);
  const byAnchor = new Map<string,PhysicalSession[]>();
  for (const s of usable) for (const uuid of new Set([s.file.anchors?.head, s.file.anchors?.lastBoundary])) if (uuid) {
    const list = byAnchor.get(uuid) ?? []; list.push(s); byAnchor.set(uuid,list);
  }
  const pairs = new Map<string,[PhysicalSession,PhysicalSession]>();
  const add = (from: PhysicalSession, to: PhysicalSession) => { if (from.id !== to.id) pairs.set(from.id+' '+to.id,[from,to]); };
  for (const from of usable) {
    const next = from.file.metadata.continuedInSessionId, to = next && sessions.get(next);
    if (to && usable.includes(to)) add(from,to);
  }
  for (const to of usable) {
    const {head, headKind} = to.file.anchors ?? {};
    if (!head || headKind === 'other' || !headKind) continue;
    const sources = (byAnchor.get(head) ?? []).filter(from => from !== to &&
      (from.file.anchors?.head === head || headKind === 'boundary' && from.file.anchors?.lastBoundary === head) &&
      // A source that handed off to another existing session is not this copy's source.
      !(from.file.metadata.continuedInSessionId && from.file.metadata.continuedInSessionId !== to.id && sessions.has(from.file.metadata.continuedInSessionId)));
    for (const from of sources.slice(0,8)) add(from,to);
  }
  return [...pairs.values()];
}

function selectCopies(files: File[], live: Set<string>) {
  const sessions = new Map<string, PhysicalSession>(), conflicts = new Set<string>();
  for (const [id,list] of groups(files)) {
    const { owners, extra, max, key, foreignKey } = copyGroup(id,list);
    const ownerProven = max && (owners.length === 1 || owners.every(f => f.groupProof?.key === key && f.groupProof.order === 0));
    const matches = ownerProven ? extra.filter(f => !live.has(f.id) && (!live.has(id) || f.size <= max.size) &&
      f.groupProof?.key === foreignKey(f) && f.groupProof.order === 0) : [];
    // Two longer extensions of a common prefix need not match EACH OTHER.
    const extended = matches.filter(f => f.size > max.size);
    const copies = matches.filter(f => f.size <= max.size || extended.length === 1);
    if (owners.length) {
      const file = ownerProven ? longest([max,...copies],id) : owners[0];
      sessions.set(id,{id,file,previous:[]});
      if (!ownerProven || file.nativeHint && file.nativeHint !== id) conflicts.add(id);
    }
    for (const file of extra) if (!copies.includes(file)) {
      // An unproven differently named candidate does not invalidate the
      // uniquely named native owner's own verified continued-in marker.
      conflicts.add(file.id);
      sessions.set(file.id,{id:file.id,file,previous:[]});
    }
  }
  return {sessions,conflicts};
}

export function selectPhysicalHistory(files: File[], aliases: string[], live: Set<string>) {
  const selected = selectCopies(candidates(files,aliases),live), {sessions,conflicts} = selected;
  const notes: string[] = [];
  if (conflicts.size) notes.push(t('backend.unconfirmedCopies', { ids: joinList([...conflicts].slice(0,8).map(id => id.slice(0,8))) }));
  // Every proven edge, then one predecessor per successor and one successor per
  // predecessor. A marker outranks a markerless copy; otherwise the deepest copy
  // wins. A tie that no edge between the tied files resolves keeps them apart.
  type Edge = {from: PhysicalSession; to: PhysicalSession; before: number; depth: number; marked: boolean};
  const proofs = continuationCandidates(selected).flatMap(([from,to]) => {
    const proof = to.file.linkProofs?.find(p => p.key === linkKey(from.file,to.file));
    return proof ? [{from,to,proof}] : [];
  });
  // A copy that branched off a finished file runs deeper into THAT file; a
  // shallower match is then only their shared history, not this copy's source.
  // Later copies of this very file also run deeper, but they kept going.
  const reach = new Map<string,number>();
  for (const {from,to,proof} of proofs) if (proof.before >= 0 || proof.before === -2) reach.set(to.id, Math.max(reach.get(to.id) ?? 0, proof.depth));
  const edges: Edge[] = proofs.flatMap(({from,to,proof}) => {
    const marked = from.file.metadata.continuedInSessionId === to.id;
    // A running predecessor is still its own conversation.
    if (proof.before < 0 || live.has(from.id) || !marked && proof.depth < (reach.get(to.id) ?? 0)) return [];
    return [{from,to,before:proof.before,depth:proof.depth,marked}];
  });
  const ambiguous = new Set<string>();
  const pick = (list: Edge[], other: (e: Edge) => PhysicalSession) => {
    if (list.length < 2) return list[0];
    const marked = list.filter(e => e.marked), pool = marked.length ? marked : list;
    const depth = Math.max(...pool.map(e => e.depth)), best = pool.filter(e => e.depth === depth);
    if (best.length === 1) return best[0];
    // Two equally deep sources where one continues the other: the later copy.
    const tips = best.filter(e => !best.some(f => f !== e && edges.some(g => g.from === other(e) && g.to === other(f))));
    if (tips.length === 1) return tips[0];
    for (const e of list) ambiguous.add(other(e).id);
  };
  const into = new Map<string,Edge[]>(), outOf = new Map<string,Edge[]>();
  for (const e of edges) { into.set(e.to.id,[...into.get(e.to.id) ?? [],e]); }
  const chosen = new Map<string,Edge>(); // keyed by successor
  for (const [id,list] of into) { const e = pick(list, x => x.from); if (e) chosen.set(id,e); else ambiguous.add(id); }
  for (const e of chosen.values()) outOf.set(e.from.id,[...outOf.get(e.from.id) ?? [],e]);
  for (const [id,list] of outOf) {
    const e = pick(list, x => x.to);
    for (const other of list) if (other !== e) chosen.delete(other.to.id);
    if (!e) ambiguous.add(id);
  }
  for (const id of ambiguous) notes.push(t('backend.ambiguousResume', { id: id.slice(0,8) }));
  const predecessor = new Map([...chosen.values()].map(e => [e.to.id,e]));
  const successor = new Map([...chosen.values()].map(e => [e.from.id,e]));
  for (const tip of [...sessions.values()]) {
    if (successor.has(tip.id) || !predecessor.has(tip.id)) continue;
    const chain: Edge[] = [], seen = new Set([tip.id]);
    for (let e = predecessor.get(tip.id); e && !seen.has(e.from.id) && chain.length < 32; e = predecessor.get(e.from.id)) { chain.unshift(e); seen.add(e.from.id); }
    tip.previous = chain.map(e => ({file:e.from.file,end:e.before}));
    for (const e of chain) sessions.delete(e.from.id);
  }
  return { sessions:[...sessions.values()], notes: [...new Set(notes)] };
}
