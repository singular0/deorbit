// neato-config.js - Neato bot re-configuration built on MtpFileSystem.
//
// Publishable: pure text transformation + fs.read/fs.write calls.
//
//   1. setOrbitalHosts(fs, ip)   - /etc/hosts: add (or replace) the
//      `orbital.deorbit` name pointing at the given IP address
//   2. setVendorHost(fs)         - /home/root/tron/config/vendors.ini: in
//      section [N] set `host = deorbit`
//   3. uploadCert(fs, bytes)     - install a cert at
//      /home/root/tron/config/ssl/godaddy.crt

const dec = new TextDecoder();
const enc = new TextEncoder();

export const HOSTS_PATH = "/etc/hosts";
export const VENDORS_INI_PATH = "/home/root/tron/config/vendors.ini";
export const CERT_PATH = "/home/root/tron/config/ssl/godaddy.crt";
export const ORBITAL_NAME = "orbital.deorbit";
export const VENDOR_HOST = "deorbit";

/**
 * 1. Point `orbital.deorbit` at `ip` in /etc/hosts.
 * Any existing non-comment line mentioning the name is dropped, then a
 * single fresh mapping is appended.
 *
 * @param fs   MtpFileSystem (session already begun)
 * @param ip   IPv4/IPv6 address as a string, e.g. "192.168.1.10"
 * @param opts { name?, path?, ...fs.write options (onConfirm, onBackup, force) }
 */
export async function setOrbitalHosts(fs, ip, opts = {}) {
  const name = opts.name ?? ORBITAL_NAME;
  const path = opts.path ?? HOSTS_PATH;
  const text = dec.decode(await fs.read(path));

  const kept = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      const fields = t.split(/\s+/);
      if (fields.slice(1).includes(name)) {
        removed++;
        continue; // drop the old mapping
      }
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push(`${ip}\t${name}`, "");

  fs.log(`hosts: ${removed ? `replaced ${removed} existing` : "added"} '${name}' -> ${ip}`);
  return fs.write(path, enc.encode(kept.join("\n")), opts);
}

/**
 * 2. In vendors.ini section [N] set `host = deorbit`.
 * Replaces every `host = ...` line inside the section; inserts one right
 * after the section header if the section has no host line. Throws if the
 * section does not exist.
 *
 * @param fs   MtpFileSystem (session already begun)
 * @param opts { section?, host?, path?, ...fs.write options }
 */
export async function setVendorHost(fs, opts = {}) {
  const section = opts.section ?? "N";
  const host = opts.host ?? VENDOR_HOST;
  const path = opts.path ?? VENDORS_INI_PATH;
  const text = dec.decode(await fs.read(path));

  const out = [];
  let inSection = false;
  let foundSection = false;
  let replaced = 0;
  for (const line of text.split("\n")) {
    const hdr = line.match(/^\s*\[([^\]]*)\]/);
    if (hdr) {
      if (inSection && !replaced) {
        out.push(`host = ${host}`); // section had no host line: insert at its end
        replaced = 1;
      }
      inSection = hdr[1].trim() === section;
      if (inSection) foundSection = true;
      out.push(line);
      continue;
    }
    if (inSection && /^\s*host\s*=/.test(line)) {
      out.push(line.replace(/^\s*host\s*=.*/, `host = ${host}`));
      replaced++;
      continue;
    }
    out.push(line);
  }
  if (inSection && !replaced) {
    out.push(`host = ${host}`);
    replaced = 1;
  }
  if (!foundSection) throw new Error(`section [${section}] not found in ${path}`);

  fs.log(`vendors.ini: set host = ${host} in [${section}] (${replaced} line(s) written)`);
  return fs.write(path, enc.encode(out.join("\n")), opts);
}

/**
 * 3. Install a TLS certificate at /home/root/tron/config/ssl/godaddy.crt.
 *
 * @param fs         MtpFileSystem (session already begun)
 * @param certBytes  Uint8Array with the PEM/DER content
 * @param opts       { path?, ...fs.write options }
 */
export async function uploadCert(fs, certBytes, opts = {}) {
  const path = opts.path ?? CERT_PATH;
  fs.log(`cert: uploading ${certBytes.length} bytes -> ${path}`);
  return fs.write(path, certBytes, opts);
}

/** Run all three steps in order. `certBytes` may be null to skip step 3. */
export async function reconfigureNeato(fs, { ip, certBytes = null, ...opts } = {}) {
  const r1 = await setOrbitalHosts(fs, ip, opts);
  if (!r1.ok) return r1;
  const r2 = await setVendorHost(fs, opts);
  if (!r2.ok) return r2;
  if (certBytes) return uploadCert(fs, certBytes, opts);
  return { ok: true };
}
