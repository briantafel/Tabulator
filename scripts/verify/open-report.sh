#!/bin/sh
# Decrypt a sealed verify report downloaded from the "Verify forecasts" run.
#   scripts/verify/open-report.sh <dir with report.tgz.enc + key.enc> <private key.pem> <out dir>
set -eu
dir=$1; priv=$2; out=$3
KEY=$(openssl pkeyutl -decrypt -inkey "$priv" -pkeyopt rsa_padding_mode:oaep -in "$dir/key.enc")
export KEY
mkdir -p "$out"
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:KEY -in "$dir/report.tgz.enc" | tar xzf - -C "$out"
ls -l "$out"
