#!/usr/bin/env bash
# One-time setup on a Mac without a Developer ID: create a self-signed code
# signing identity in the login keychain. Builds signed with it keep the same
# designated requirement, so macOS remembers privacy consent (Desktop,
# Documents, …) across updates instead of asking again after every build.
#
# The certificate is trusted by nothing and only identifies local builds.
# Remove it with Keychain Access (search "Lectern Local Signing") or:
#   security delete-identity -c "Lectern Local Signing"
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { printf '仅在 macOS 上需要。\n' >&2; exit 1; }
name='Lectern Local Signing'
keychain="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -p codesigning | grep -q "\"$name\""; then
  printf '本机签名身份已存在：%s\n' "$name"
  exit 0
fi
work=$(mktemp -d)
# The directory holds a private key; remove it outright rather than to the Trash.
trap 'rm -rf "$work"' EXIT
cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$name
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
# The system LibreSSL writes a PKCS#12 file that the macOS keychain can import.
openssl=/usr/bin/openssl
"$openssl" req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
pass=$("$openssl" rand -hex 16)
"$openssl" pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12" \
  -passout "pass:$pass" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
# Only codesign may use the key without asking.
security import "$work/identity.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null
security find-identity -p codesigning | grep "\"$name\"" | head -1
printf '已在登录钥匙串创建本机签名身份。之后打包的 Lectern 都用它签名。\n'
